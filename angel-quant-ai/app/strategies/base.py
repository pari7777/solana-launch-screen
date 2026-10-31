"""Trade plans and the pre-trade profitability check every strategy must pass.

A plan is only tradable when, AFTER brokerage, STT, exchange fees, SEBI fee, stamp duty, GST and expected slippage:
  - the net profit at target ≥ MIN_NET_REWARD_RUPEES
  - net reward / net risk ≥ MIN_REWARD_RISK
  - expected value (calibrated win-rate × net win − loss-rate × net loss) > 0
"""
from __future__ import annotations

import math
from dataclasses import dataclass, field
from typing import Any

from app.broker.instruments import Instrument
from app.costs.charges import ChargeModel, segment_of


def round_tick(price: float, tick: float, up: bool | None = None) -> float:
    if tick <= 0:
        return round(price, 2)
    n = price / tick
    n = math.ceil(n - 1e-9) if up is True else math.floor(n + 1e-9) if up is False else round(n)
    return round(n * tick, 2)


@dataclass
class TradePlan:
    strategy: str
    ins: Instrument
    side: str                      # BUY or SELL (entry side)
    product: str                   # INTRADAY | CARRYFORWARD | DELIVERY
    qty: int
    entry: float
    stop: float
    target: float
    reason: str
    underlying: str
    regime: str = ""
    win_prob: float = 0.40         # replaced by the strategy's calibrated out-of-sample win rate when available
    prob_source: str = "prior"
    max_entry: float = 0.0         # never pay more than this (buy) / accept less (sell)
    meta: dict[str, Any] = field(default_factory=dict)
    # filled by evaluate()
    charges_target: float = 0.0
    charges_stop: float = 0.0
    slippage: float = 0.0
    gross_target: float = 0.0
    net_target: float = 0.0
    net_stop: float = 0.0          # negative number: loss incl. costs
    rr: float = 0.0
    ev: float = 0.0
    capital: float = 0.0
    rejected: str = ""

    @property
    def direction(self) -> int:
        return 1 if self.side == "BUY" else -1

    def summary(self) -> dict:
        return {"strategy": self.strategy, "symbol": self.ins.symbol, "side": self.side, "qty": self.qty, "entry": self.entry,
                "stop": self.stop, "target": self.target, "gross_target": round(self.gross_target, 2),
                "charges": round(self.charges_target, 2), "slippage": round(self.slippage, 2), "net_target": round(self.net_target, 2),
                "max_loss": round(-self.net_stop, 2), "rr": round(self.rr, 2), "win_prob": round(self.win_prob, 3),
                "prob_source": self.prob_source, "ev": round(self.ev, 2), "capital": round(self.capital, 2),
                "reason": self.reason, "regime": self.regime, "underlying": self.underlying, "rejected": self.rejected}


def evaluate(plan: TradePlan, model: ChargeModel, spread: float | None, min_net: float, min_rr: float) -> TradePlan:
    """Fill in costs and expected values. Sets plan.rejected when the trade does not pay for itself."""
    seg = segment_of(plan.ins.itype, plan.product)
    q, d = plan.qty, plan.direction
    tick = plan.ins.tick or 0.05
    # slippage: half the quoted spread (or two ticks if unknown) on entry and on exit, plus one extra tick on a stop exit
    half = (spread / 2) if spread and spread > 0 else 2 * tick
    slip_target = (half * 2) * q
    slip_stop = (half * 2 + tick) * q
    plan.slippage = slip_target
    plan.gross_target = (plan.target - plan.entry) * d * q
    legs = plan.meta.get("legs") if plan.meta.get("combo") else None
    if legs:
        # every leg is a separate executed order on entry and on exit; leg exit prices scale with the net premium
        def combo_cost(exit_net: float) -> float:
            k = exit_net / plan.entry if plan.entry else 1.0
            return sum(model.round_trip("OPT", lg["side"], lg["price"], max(0.05, lg["price"] * k), q, plan.ins.exchange).total for lg in legs)
        c_t, c_s = combo_cost(plan.target), combo_cost(plan.stop)
        slip_target *= len(legs)
        slip_stop *= len(legs)
        plan.slippage = slip_target
    else:
        c_t = model.round_trip(seg, plan.side, plan.entry, plan.target, q, plan.ins.exchange).total
        c_s = model.round_trip(seg, plan.side, plan.entry, plan.stop, q, plan.ins.exchange).total
    plan.charges_target, plan.charges_stop = c_t, c_s
    plan.net_target = plan.gross_target - c_t - slip_target
    plan.net_stop = (plan.stop - plan.entry) * d * q - c_s - slip_stop
    plan.rr = plan.net_target / -plan.net_stop if plan.net_stop < 0 else 0.0
    plan.ev = plan.win_prob * plan.net_target + (1 - plan.win_prob) * plan.net_stop
    if legs and plan.side == "SELL":           # credit spread / condor: margin ≈ maximum loss
        width = plan.meta.get("width") or plan.stop
        plan.capital = width * q
    else:
        plan.capital = plan.entry * q if seg in ("OPT", "EQ_DELIVERY") or plan.side == "BUY" else plan.entry * q * 0.2
    if q <= 0:
        plan.rejected = "quantity is zero"
    elif (plan.target - plan.entry) * d <= 0 or (plan.entry - plan.stop) * d <= 0:
        plan.rejected = "stop/target on the wrong side of entry"
    elif plan.net_target < min_net:
        plan.rejected = f"net profit at target ₹{plan.net_target:.0f} < ₹{min_net:.0f} after ₹{c_t + slip_target:.0f} costs"
    elif plan.rr < min_rr:
        plan.rejected = f"net reward/risk {plan.rr:.2f} < {min_rr}"
    elif plan.ev <= 0:
        plan.rejected = f"negative expected value ₹{plan.ev:.0f} at win rate {plan.win_prob:.0%}"
    return plan


class Strategy:
    name = "base"
    kind = "intraday"           # intraday | options | swing

    def __init__(self, ctx):
        self.ctx = ctx          # engine context: market data, instruments, settings, stats
        self.enabled = True

    def on_bar(self) -> list[TradePlan]:
        """Called once per closed 1-minute bar. Returns candidate plans (not yet risk-checked)."""
        return []
