"""Bar-by-bar backtester that runs the SAME strategy code as live trading on historical 1-minute candles.

Realism rules: signals on a closed bar fill at the NEXT bar's open ± slippage (never at the signal close); a bar that
touches both stop and target counts as a stop (conservative); every order pays the full charge model; intraday
positions are squared off at 15:12 IST; one position per instrument; trailing/partial rules mirror the live OMS.
Walk-forward: parameters are chosen on each training window and scored only on the following unseen window.

Limitation: SmartAPI serves history for listed (current) contracts only, so option strategies cannot be backtested on
expired contracts here — they are validated by live paper trading instead.
"""
from __future__ import annotations

import math
from dataclasses import dataclass, field
from datetime import date, datetime, time, timedelta

import numpy as np

from app.clock import IST
from app.costs.charges import ChargeModel, segment_of
from app.market.feed import Candle, MarketData, Series
from app.risk.allocation import Stats
from app.strategies.base import evaluate


@dataclass
class BTTrade:
    strategy: str
    symbol: str
    side: str
    qty: int
    entry: float
    exit: float
    gross: float
    charges: float
    net: float
    reason: str
    opened: datetime
    closed: datetime


@dataclass
class BTResult:
    trades: list[BTTrade] = field(default_factory=list)
    rejected: dict[str, int] = field(default_factory=dict)

    def metrics(self, capital: float) -> dict:
        n = len(self.trades)
        nets = np.array([t.net for t in self.trades]) if n else np.array([])
        eq = capital + np.cumsum(nets) if n else np.array([capital])
        peak = np.maximum.accumulate(np.concatenate([[capital], eq]))
        dd = float(((peak - np.concatenate([[capital], eq])) / peak).max() * 100) if n else 0.0
        wins = nets[nets > 0]
        losses = nets[nets <= 0]
        return {"trades": n, "net": round(float(nets.sum()), 2) if n else 0.0,
                "gross": round(sum(t.gross for t in self.trades), 2), "charges": round(sum(t.charges for t in self.trades), 2),
                "win_rate_pct": round(len(wins) / n * 100, 1) if n else None,
                "profit_factor": round(float(wins.sum() / -losses.sum()), 2) if len(losses) and losses.sum() < 0 else None,
                "avg_net": round(float(nets.mean()), 2) if n else None, "max_drawdown_pct": round(dd, 2),
                "return_pct": round(float(nets.sum()) / capital * 100, 2) if n else 0.0}


class SimCtx:
    """The subset of the live Engine that strategies use, driven by a simulated clock."""

    def __init__(self, s, im, capital: float):
        self.s, self.im, self.capital = s, im, capital
        self.md = MarketData()
        self.stats = Stats()
        self.regime = None
        self._now: datetime = datetime.now(IST)

    def key_for(self, ins) -> str:
        return MarketData.key(1, ins.token)

    def index_key(self, u):
        return ""

    def now(self):
        return self._now

    def today(self):
        return self._now.date()

    def minutes_since_open(self):
        o = datetime.combine(self._now.date(), time(9, 15), tzinfo=IST)
        return (self._now - o).total_seconds() / 60


def run(strategy_cls, s, im, candles: dict[str, list[Candle]], capital: float = 100_000.0, params: dict | None = None,
        slippage_ticks: int = 1, charges: ChargeModel | None = None) -> BTResult:
    """candles: instrument name → 1-minute candles (IST, sorted). Only single-leg stock strategies."""
    charges = charges or ChargeModel()
    ctx = SimCtx(s, im, capital)
    strat = strategy_cls(ctx)
    for k, v in (params or {}).items():
        setattr(strat, k, v)
    res = BTResult()
    # merge all bars on one timeline
    timeline = sorted({c.ts for cs in candles.values() for c in cs})
    by_ts = {name: {c.ts: c for c in cs} for name, cs in candles.items()}
    open_pos: dict[str, dict] = {}
    pending: list = []
    sq = time(15, 12)
    for ts in timeline:
        now = datetime.fromtimestamp(ts, IST)
        ctx._now = now + timedelta(minutes=1)            # the bar starting at ts has closed
        # 1) fill pending entries at this bar's open
        for plan in pending:
            c = by_ts.get(plan.underlying, {}).get(ts)
            if not c or plan.underlying in open_pos:
                continue
            tick = plan.ins.tick
            px = c.o + slippage_ticks * tick if plan.side == "BUY" else c.o - slippage_ticks * tick
            if (plan.side == "BUY" and px > plan.max_entry) or (plan.side == "SELL" and px < plan.max_entry):
                res.rejected["gap beyond max entry"] = res.rejected.get("gap beyond max entry", 0) + 1
                continue
            shift = px - plan.entry
            open_pos[plan.underlying] = {"plan": plan, "entry": px, "stop": plan.stop + shift, "init_stop": plan.stop + shift,
                                         "target": plan.target + shift, "qty": plan.qty, "best": px, "partial": False,
                                         "booked": 0.0, "booked_chg": 0.0, "opened": now}
        pending = []
        # 2) manage open positions on this bar
        for name, p in list(open_pos.items()):
            c = by_ts.get(name, {}).get(ts)
            if not c:
                continue
            plan, d = p["plan"], (1 if p["plan"].side == "BUY" else -1)
            risk = abs(p["entry"] - p["init_stop"]) or 1e-9
            seg = segment_of(plan.ins.itype, plan.product)
            tick = plan.ins.tick
            exit_px, why = None, ""
            adverse = c.l if d > 0 else c.h
            favour = c.h if d > 0 else c.l
            if (adverse - p["stop"]) * d <= 0:
                exit_px, why = p["stop"] - d * slippage_ticks * tick, "stop"
            else:
                if d > 0:
                    p["best"] = max(p["best"], favour)
                else:
                    p["best"] = min(p["best"], favour)
                r_best = (p["best"] - p["entry"]) * d / risk
                if not p["partial"] and r_best >= s.partial_book_r:
                    lot = max(1, plan.ins.lot)
                    q = int(math.floor(p["qty"] * s.partial_book_fraction / lot) * lot)
                    if 0 < q < p["qty"]:
                        bp = p["entry"] + d * s.partial_book_r * risk
                        p["booked"] += (bp - p["entry"]) * d * q
                        p["booked_chg"] += charges.leg(seg, "SELL" if d > 0 else "BUY", bp, q).total
                        p["qty"] -= q
                    p["partial"] = True
                    p["stop"] = max(p["stop"], p["entry"]) if d > 0 else min(p["stop"], p["entry"])
                if r_best >= s.trail_start_r:
                    trail = p["best"] - d * s.trail_gap_r * risk
                    p["stop"] = max(p["stop"], trail) if d > 0 else min(p["stop"], trail)
                if not p["partial"] and (favour - p["target"]) * d >= 0:
                    exit_px, why = p["target"], "target"
                elif now.time() >= sq:
                    exit_px, why = c.c - d * slippage_ticks * tick, "square-off"
            if exit_px is not None:
                full_qty = plan.qty
                gross = (exit_px - p["entry"]) * d * p["qty"] + p["booked"]
                chg = charges.leg(seg, plan.side, p["entry"], full_qty).total + charges.leg(seg, "SELL" if d > 0 else "BUY", exit_px, p["qty"]).total + p["booked_chg"]
                res.trades.append(BTTrade(plan.strategy, plan.ins.symbol, plan.side, full_qty, p["entry"], exit_px, gross, chg,
                                          gross - chg, why, p["opened"], now))
                ctx.stats.add(plan.strategy, gross - chg)
                del open_pos[name]
        # 3) feed the closed bar and ask the strategy for signals
        for name, bars in by_ts.items():
            c = bars.get(ts)
            if not c:
                continue
            ins = im.equity.get(name)
            if not ins:
                continue
            ser = ctx.md.series.setdefault(ctx.key_for(ins), Series(live=False))
            ser.candles.append(Candle(c.ts, c.o, c.h, c.l, c.c, c.v))
        if now.time() < s.no_new_entries_after:
            for plan in strat.on_bar():
                evaluate(plan, charges, None, s.min_net_reward_rupees, s.min_reward_risk)
                if plan.rejected:
                    k = plan.rejected.split(" ")[0:3]
                    k = " ".join(k)
                    res.rejected[k] = res.rejected.get(k, 0) + 1
                    continue
                if plan.underlying not in open_pos and len(open_pos) < s.max_open_positions:
                    pending.append(plan)
    return res


def walk_forward(strategy_cls, s, im, candles: dict[str, list[Candle]], grid: list[dict], train_days: int = 20, test_days: int = 5,
                 capital: float = 100_000.0) -> list[dict]:
    """Choose the best params on each training window by net P&L, report them on the next unseen window only."""
    days = sorted({datetime.fromtimestamp(c.ts, IST).date() for cs in candles.values() for c in cs})
    out = []

    def window(ds: list[date]):
        keep = set(ds)
        return {k: [c for c in v if datetime.fromtimestamp(c.ts, IST).date() in keep] for k, v in candles.items()}

    i = 0
    while i + train_days + test_days <= len(days):
        tr, te = days[i:i + train_days], days[i + train_days:i + train_days + test_days]
        scored = [(run(strategy_cls, s, im, window(tr), capital, g).metrics(capital)["net"], g) for g in grid]
        best = max(scored, key=lambda x: x[0])
        test = run(strategy_cls, s, im, window(te), capital, best[1]).metrics(capital)
        out.append({"train": f"{tr[0]}…{tr[-1]}", "test": f"{te[0]}…{te[-1]}", "params": best[1], "train_net": best[0], "test": test})
        i += test_days
    return out
