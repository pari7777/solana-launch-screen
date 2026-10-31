"""NSE stock intraday strategies (product INTRADAY, squared off before the close).
Signals use CLOSED 1-minute bars only. Entries are limit orders; stops are hard and never widened."""
from __future__ import annotations

import math

import numpy as np

from app.market import indicators as ind
from app.strategies.base import Strategy, TradePlan, round_tick


def size_by_risk(ctx, entry: float, stop: float) -> int:
    s = ctx.s
    risk_rupees = ctx.capital * s.max_risk_per_trade_pct / 100
    per_share = abs(entry - stop)
    if per_share <= 0:
        return 0
    q = math.floor(risk_rupees / per_share)
    cap = math.floor(ctx.capital * s.max_capital_per_trade_pct / 100 / entry) if entry > 0 else 0
    return max(0, min(q, cap))


class StockStrategy(Strategy):
    kind = "intraday"

    def stocks(self):
        for name in self.ctx.s.stocks:
            ins = self.ctx.im.equity.get(name)
            if ins:
                yield name, ins, self.ctx.key_for(ins)

    def plan(self, ins, name, side, entry, stop, target, reason, sid) -> TradePlan:
        tick = ins.tick
        entry = round_tick(entry, tick)
        stop = round_tick(stop, tick, up=(side == "SELL"))
        target = round_tick(target, tick, up=(side == "BUY"))
        q = size_by_risk(self.ctx, entry, stop)
        p, src = self.ctx.stats.win_rate(sid)
        return TradePlan(strategy=sid, ins=ins, side=side, product="INTRADAY", qty=q, entry=entry, stop=stop, target=target,
                         reason=reason, underlying=name, win_prob=p, prob_source=src,
                         max_entry=round_tick(entry + 2 * tick if side == "BUY" else entry - 2 * tick, tick))


class OpeningRangeBreakout(StockStrategy):
    """15-minute opening range; trade the first close outside it with above-average volume, on the VWAP side."""
    name = "stock_orb"
    OR_MIN = 15

    def __init__(self, ctx):
        super().__init__(ctx)
        self.done: set[str] = set()       # one ORB trade per stock per day
        self.day = None

    def on_bar(self):
        out = []
        m = self.ctx.minutes_since_open()
        if m < self.OR_MIN + 1 or m > 150:
            return out
        today = self.ctx.today()
        if self.day != today:
            self.day, self.done = today, set()
        for name, ins, k in self.stocks():
            if name in self.done:
                continue
            s = self.ctx.md.series.get(k)
            if not s:
                continue
            ts, o, h, l, c, v = s.session()
            if len(c) < self.OR_MIN + 2:
                continue
            orh, orl = h[:self.OR_MIN].max(), l[:self.OR_MIN].min()
            vw = ind.vwap(h, l, c, v)
            avgv = v[:-1].mean() if len(v) > 1 else 0
            last, prev = c[-1], c[-2]
            vol_ok = avgv > 0 and v[-1] > 1.5 * avgv
            rng = orh - orl
            if rng <= 0 or rng / last < 0.003:
                continue
            if prev <= orh < last and last > vw[-1] and vol_ok:
                out.append(self.plan(ins, name, "BUY", last, max(orl, last - rng), last + 2 * rng,
                                     f"close {last} broke 15-min high {orh} on {v[-1] / avgv:.1f}× volume, above VWAP", self.name))
                self.done.add(name)
            elif prev >= orl > last and last < vw[-1] and vol_ok:
                out.append(self.plan(ins, name, "SELL", last, min(orh, last + rng), last - 2 * rng,
                                     f"close {last} broke 15-min low {orl} on {v[-1] / avgv:.1f}× volume, below VWAP", self.name))
                self.done.add(name)
        return out


class VwapTrendPullback(StockStrategy):
    """Trend day: price on one side of VWAP, EMA9 > EMA21 (or <), pullback to EMA21 and a close back in trend direction.
    RSI(14) must confirm (55–75 long / 25–45 short). Stop beyond the pullback low/high (≥ 1 ATR)."""
    name = "stock_vwap_trend"

    def __init__(self, ctx):
        super().__init__(ctx)
        self.last_signal: dict[str, int] = {}

    def on_bar(self):
        out = []
        m = self.ctx.minutes_since_open()
        if m < 30:
            return out
        for name, ins, k in self.stocks():
            s = self.ctx.md.series.get(k)
            if not s:
                continue
            ts, o, h, l, c, v = s.session()
            if len(c) < 30:
                continue
            if self.last_signal.get(name, -10**9) > ts[-1] - 30 * 60:     # one signal per 30 min per stock
                continue
            vw = ind.vwap(h, l, c, v)
            e9, e21 = ind.ema(c, 9), ind.ema(c, 21)
            r = ind.rsi(c, 14)
            a = ind.atr(h, l, c, 14)
            if np.isnan(a[-1]) or np.isnan(e21[-1]):
                continue
            last = c[-1]
            long_ok = last > vw[-1] and e9[-1] > e21[-1] and l[-2] <= e21[-2] and last > e9[-1] and 55 <= r[-1] <= 75
            short_ok = last < vw[-1] and e9[-1] < e21[-1] and h[-2] >= e21[-2] and last < e9[-1] and 25 <= r[-1] <= 45
            if long_ok:
                stop = min(l[-3:].min(), last - a[-1])
                out.append(self.plan(ins, name, "BUY", last, stop, last + 2.2 * (last - stop),
                                     f"uptrend above VWAP {vw[-1]:.2f}, EMA9>EMA21, pullback held EMA21, RSI {r[-1]:.0f}", self.name))
                self.last_signal[name] = int(ts[-1])
            elif short_ok:
                stop = max(h[-3:].max(), last + a[-1])
                out.append(self.plan(ins, name, "SELL", last, stop, last - 2.2 * (stop - last),
                                     f"downtrend below VWAP {vw[-1]:.2f}, EMA9<EMA21, pullback rejected EMA21, RSI {r[-1]:.0f}", self.name))
                self.last_signal[name] = int(ts[-1])
        return out


class VwapReversion(StockStrategy):
    """Range-bound market only: fade a 2-σ stretch from VWAP back toward VWAP, with RSI extreme and a reversal bar."""
    name = "stock_vwap_reversion"

    def __init__(self, ctx):
        super().__init__(ctx)
        self.last_signal: dict[str, int] = {}

    def on_bar(self):
        out = []
        if self.ctx.minutes_since_open() < 45:
            return out
        for name, ins, k in self.stocks():
            s = self.ctx.md.series.get(k)
            if not s:
                continue
            ts, o, h, l, c, v = s.session()
            if len(c) < 45 or self.last_signal.get(name, -10**9) > ts[-1] - 45 * 60:
                continue
            vw = ind.vwap(h, l, c, v)
            dev = c - vw
            sd = dev[-30:].std()
            r = ind.rsi(c, 14)
            if sd <= 0 or np.isnan(r[-1]):
                continue
            last = c[-1]
            if dev[-2] < -2 * sd and c[-1] > o[-1] and r[-2] < 30:
                stop = l[-3:].min() - 0.25 * sd
                out.append(self.plan(ins, name, "BUY", last, stop, vw[-1], f"{dev[-2] / sd:.1f}σ below VWAP, RSI {r[-2]:.0f}, reversal bar", self.name))
                self.last_signal[name] = int(ts[-1])
            elif dev[-2] > 2 * sd and c[-1] < o[-1] and r[-2] > 70:
                stop = h[-3:].max() + 0.25 * sd
                out.append(self.plan(ins, name, "SELL", last, stop, vw[-1], f"{dev[-2] / sd:.1f}σ above VWAP, RSI {r[-2]:.0f}, reversal bar", self.name))
                self.last_signal[name] = int(ts[-1])
        return out
