"""Index-option strategies (NIFTY / BANKNIFTY / FINNIFTY — whatever the instrument master lists).
Option BUYING and DEFINED-RISK spreads only. Naked option selling is not implemented.

  opt_momentum      momentum scalp: buy a liquid ATM/1-ITM CE (bull) or PE (bear) on an index EMA9/21 + Supertrend +
                    RSI + range-expansion signal; stop/target on the premium via option delta
  opt_debit_spread  bull call / bear put spread (buy ATM, sell 2 strikes OTM) on a confirmed trend or reversal
  opt_iron_condor   sideways market: short strangle ~1σ away, protected by long wings → maximum loss is fixed
"""
from __future__ import annotations

import math
from datetime import date

import numpy as np

from app.market import indicators as ind
from app.strategies.base import Strategy, TradePlan, round_tick


def lots_for(ctx, risk_per_unit: float, lot: int, premium: float) -> int:
    s = ctx.s
    if risk_per_unit <= 0 or lot <= 0:
        return 0
    by_risk = math.floor(ctx.capital * s.max_risk_per_trade_pct / 100 / (risk_per_unit * lot))
    by_prem = math.floor(ctx.capital * s.max_capital_per_trade_pct / 100 / (premium * lot)) if premium > 0 else 0
    return max(0, min(by_risk, by_prem, s.max_order_qty_lots))


class OptionStrategy(Strategy):
    kind = "options"

    def underlyings(self):
        for u in self.ctx.s.underlyings:
            k = self.ctx.index_key(u)
            if k and self.ctx.im.expiries(u):
                yield u, k

    def expiry(self, u: str) -> date | None:
        """Nearest expiry; on expiry day switch to the next one after 13:00 (gamma/theta risk)."""
        ex = self.ctx.im.expiries(u)
        if not ex:
            return None
        n = self.ctx.now()
        if ex[0] == n.date() and n.hour >= 13 and len(ex) > 1:
            return ex[1]
        return ex[0]

    def index_bars(self, k):
        s = self.ctx.md.series.get(k)
        if not s:
            return None
        return s.session()


class OptionMomentum(OptionStrategy):
    name = "opt_momentum"

    def __init__(self, ctx):
        super().__init__(ctx)
        self.last: dict[str, int] = {}

    def on_bar(self):
        out = []
        m = self.ctx.minutes_since_open()
        if m < 20 or m > 330:
            return out
        for u, k in self.underlyings():
            bars = self.index_bars(k)
            if bars is None or len(bars[4]) < 30:
                continue
            ts, o, h, l, c, _ = bars
            if self.last.get(u, -10**9) > ts[-1] - 20 * 60:
                continue
            e9, e21 = ind.ema(c, 9), ind.ema(c, 21)
            r = ind.rsi(c, 14)
            a = ind.atr(h, l, c, 14)
            _, st = ind.supertrend(h, l, c, 10, 3)
            if np.isnan(a[-1]) or np.isnan(e21[-1]):
                continue
            crossed_up = e9[-1] > e21[-1] and (e9[-3] <= e21[-3] or e9[-2] <= e21[-2])
            crossed_dn = e9[-1] < e21[-1] and (e9[-3] >= e21[-3] or e9[-2] >= e21[-2])
            expansion = (h[-1] - l[-1]) > 1.2 * a[-2]
            bull = crossed_up and st[-1] > 0 and r[-1] > 55 and expansion and c[-1] > c[-2]
            bear = crossed_dn and st[-1] < 0 and r[-1] < 45 and expansion and c[-1] < c[-2]
            if not (bull or bear):
                continue
            right = "CE" if bull else "PE"
            ex = self.expiry(u)
            pick = self.ctx.pick_option(u, ex, c[-1], right, itm_steps=1)
            if not pick:
                continue
            ins, tick, delta = pick
            idx_stop = max(1.5 * a[-1], abs(c[-1] - (l[-3:].min() if bull else h[-3:].max())))
            entry = round_tick((tick.bid + tick.ask) / 2, ins.tick, up=True)
            risk_unit = min(delta * idx_stop, 0.25 * entry)
            stop = round_tick(entry - risk_unit, ins.tick, up=False)
            target = round_tick(entry + 2 * risk_unit, ins.tick, up=True)
            lots = lots_for(self.ctx, entry - stop, ins.lot, entry)
            p, src = self.ctx.stats.win_rate(self.name)
            out.append(TradePlan(strategy=self.name, ins=ins, side="BUY", product="INTRADAY", qty=lots * ins.lot, entry=entry,
                                 stop=stop, target=target, underlying=u, win_prob=p, prob_source=src,
                                 max_entry=round_tick(tick.ask + ins.tick, ins.tick),
                                 reason=f"{u} EMA9/21 cross {'up' if bull else 'down'}, Supertrend {'up' if bull else 'down'}, "
                                        f"RSI {r[-1]:.0f}, range {((h[-1] - l[-1]) / a[-2]):.1f}× ATR → buy {ins.symbol} "
                                        f"(Δ≈{delta:.2f}, spread {tick.spread_pct:.2f}%)",
                                 meta={"delta": delta, "spot": float(c[-1]), "index_stop_pts": float(idx_stop)}))
            self.last[u] = int(ts[-1])
        return out


def combo_plan(ctx, name, u, legs, side, net, stop, target, reason, units) -> TradePlan:
    """legs: [(instrument, 'BUY'|'SELL', price)], net/stop/target in net premium per unit."""
    p, src = ctx.stats.win_rate(name)
    first = legs[0][0]
    return TradePlan(strategy=name, ins=first, side=side, product="CARRYFORWARD" if name == "opt_iron_condor" else "INTRADAY",
                     qty=units, entry=round(net, 2), stop=round(stop, 2), target=round(target, 2), underlying=u, win_prob=p,
                     prob_source=src, reason=reason,
                     meta={"legs": [{"token": i.token, "symbol": i.symbol, "side": sd, "price": px, "tick": i.tick} for i, sd, px in legs],
                           "combo": True})


class DebitSpread(OptionStrategy):
    """Bull call (bullish) or bear put (bearish) spread: buy ATM, sell 2 strikes further OTM. Max loss = net debit."""
    name = "opt_debit_spread"

    def __init__(self, ctx):
        super().__init__(ctx)
        self.last: dict[str, int] = {}

    def on_bar(self):
        out = []
        m = self.ctx.minutes_since_open()
        if m < 30 or m > 300:
            return out
        reg = self.ctx.regime
        if reg.label not in ("BULL_TREND", "BEAR_TREND", "REVERSAL_UP", "REVERSAL_DOWN"):
            return out
        bull = reg.trend > 0
        for u, k in self.underlyings():
            bars = self.index_bars(k)
            if bars is None or len(bars[4]) < 30 or self.last.get(u, -10**9) > bars[0][-1] - 60 * 60:
                continue
            spot = float(bars[4][-1])
            ex = self.expiry(u)
            right = "CE" if bull else "PE"
            longp = self.ctx.pick_option(u, ex, spot, right, itm_steps=0)
            shortp = self.ctx.pick_option(u, ex, spot, right, itm_steps=-2)
            if not longp or not shortp or longp[0].token == shortp[0].token:
                continue
            (li, lt, _), (si, st_, _) = longp, shortp
            debit = lt.ask - st_.bid
            width = abs(si.strike - li.strike)
            if debit <= 0 or width <= 0 or debit >= 0.7 * width:
                continue
            target = min(width * 0.8, debit * 2.0)
            stop = debit * 0.5
            lots = lots_for(self.ctx, debit - stop, li.lot, debit)
            out.append(combo_plan(self.ctx, self.name, u, [(li, "BUY", lt.ask), (si, "SELL", st_.bid)], "BUY", debit, stop, target,
                                  f"{reg.label} → {'bull call' if bull else 'bear put'} spread {li.symbol}/{si.symbol}, "
                                  f"debit {debit:.2f} on width {width:.0f}", lots * li.lot))
            self.last[u] = int(bars[0][-1])
        return out


class IronCondor(OptionStrategy):
    """Sideways regime only. Short CE/PE ~1σ from spot (σ from India VIX), long wings 2 strikes further out.
    Maximum loss = wing width − credit, fixed at entry. Exit at 50% of credit captured or at 2× credit loss."""
    name = "opt_iron_condor"

    def __init__(self, ctx):
        super().__init__(ctx)
        self.day = None
        self.done: set[str] = set()

    def on_bar(self):
        out = []
        m = self.ctx.minutes_since_open()
        if m < 45 or m > 240 or self.ctx.regime.label != "SIDEWAYS":
            return out
        vix = self.ctx.regime.vix
        if not vix:
            return out
        today = self.ctx.today()
        if self.day != today:
            self.day, self.done = today, set()
        for u, k in self.underlyings():
            if u in self.done:
                continue
            bars = self.index_bars(k)
            if bars is None or len(bars[4]) < 30:
                continue
            spot = float(bars[4][-1])
            ex = self.expiry(u)
            if not ex:
                continue
            days = max(1, (ex - today).days)
            sigma = spot * vix / 100 * math.sqrt(days / 365)
            sc = self.ctx.pick_strike(u, ex, spot + sigma, "CE")
            sp = self.ctx.pick_strike(u, ex, spot - sigma, "PE")
            lc = self.ctx.pick_strike(u, ex, spot + sigma, "CE", offset=2)
            lp = self.ctx.pick_strike(u, ex, spot - sigma, "PE", offset=-2)
            if not all([sc, sp, lc, lp]):
                continue
            legs = [(lc[0], "BUY", lc[1].ask), (lp[0], "BUY", lp[1].ask), (sc[0], "SELL", sc[1].bid), (sp[0], "SELL", sp[1].bid)]
            credit = sc[1].bid + sp[1].bid - lc[1].ask - lp[1].ask
            width = min(abs(lc[0].strike - sc[0].strike), abs(sp[0].strike - lp[0].strike))
            if credit <= 0 or width <= 0 or credit < 0.2 * width:
                continue
            target, stop = credit * 0.5, credit * 2.0          # SELL combo: profit when the combo value falls
            max_loss = width - credit
            lots = lots_for(self.ctx, min(stop - credit, max_loss), sc[0].lot, max_loss)
            plan = combo_plan(self.ctx, self.name, u, legs, "SELL", credit, min(stop, width), target,
                              f"SIDEWAYS (ADX {self.ctx.regime.adx or 0:.0f}, VIX {vix:.1f}) → iron condor short "
                              f"{sc[0].strike:.0f}CE/{sp[0].strike:.0f}PE, wings ±2 strikes, credit {credit:.2f}, "
                              f"max loss {max_loss:.2f}/unit", lots * sc[0].lot)
            plan.meta["width"] = width
            plan.product = "INTRADAY"          # closed the same day by default (no overnight short options)
            out.append(plan)
            self.done.add(u)
        return out
