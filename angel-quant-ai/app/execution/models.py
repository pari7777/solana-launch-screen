from __future__ import annotations

import itertools
import time
from dataclasses import dataclass, field

from app.broker.instruments import Instrument

_ids = itertools.count(1)


@dataclass
class Order:
    ins: Instrument
    side: str                  # BUY | SELL
    qty: int
    price: float               # LIMIT price (market and IOC orders are not allowed for algos)
    product: str
    purpose: str               # ENTRY | EXIT | PARTIAL
    position_id: int
    client_ref: str = ""
    broker_id: str = ""
    status: str = "NEW"        # NEW → SENT → OPEN → PARTIAL → FILLED | CANCELLED | REJECTED
    filled: int = 0
    avg_price: float = 0.0
    created: float = field(default_factory=time.time)
    sent_at: float = 0.0
    ack_ms: float | None = None
    first_fill_ms: float | None = None
    reprices: int = 0
    max_price: float = 0.0     # entry cap (BUY) / floor (SELL); 0 = no cap (exits)
    reject_reason: str = ""
    charges: float = 0.0
    leg: int = 0

    def __post_init__(self):
        if not self.client_ref:
            self.client_ref = f"{self.position_id}-{self.purpose[:1]}{self.leg}-{next(_ids)}"

    @property
    def remaining(self) -> int:
        return self.qty - self.filled

    @property
    def active(self) -> bool:
        return self.status in ("NEW", "SENT", "OPEN", "PARTIAL")

    def add_fill(self, qty: int, price: float):
        if qty <= 0:
            return
        if self.first_fill_ms is None and self.sent_at:
            self.first_fill_ms = (time.time() - self.sent_at) * 1000
        tot = self.avg_price * self.filled + price * qty
        self.filled += qty
        self.avg_price = tot / self.filled
        self.status = "FILLED" if self.filled >= self.qty else "PARTIAL"


@dataclass
class Leg:
    ins: Instrument
    side: str                  # entry side of this leg
    qty: int = 0               # filled quantity currently held
    entry_price: float = 0.0
    exit_qty: int = 0
    exit_price: float = 0.0


@dataclass
class Position:
    id: int
    strategy: str
    underlying: str
    product: str
    side: str                  # BUY (long / debit) or SELL (short / credit)
    target_qty: int
    entry_plan: float
    stop: float
    target: float
    initial_stop: float
    legs: list[Leg]
    reason: str
    plan_summary: dict
    status: str = "PENDING"    # PENDING → OPEN → EXITING → CLOSED (or CANCELLED if never filled)
    opened_at: float = field(default_factory=time.time)
    closed_at: float = 0.0
    best: float = 0.0          # most favourable mark since entry
    mark: float = 0.0
    trailing: bool = False
    partial_done: bool = False
    exit_reason: str = ""
    gross: float = 0.0
    charges_est: float = 0.0
    charges_actual: float = 0.0
    slippage: float = 0.0
    capital: float = 0.0
    signal_ms: float | None = None

    @property
    def is_combo(self) -> bool:
        return len(self.legs) > 1

    @property
    def is_open(self) -> bool:
        return self.status in ("PENDING", "OPEN", "EXITING")

    @property
    def key(self) -> str:
        return self.legs[0].ins.token

    @property
    def is_option_buy(self) -> bool:
        return self.legs[0].ins.is_option and self.side == "BUY"

    @property
    def qty(self) -> int:
        """Units held (combos: units of the combo = quantity of each leg)."""
        return min(l.qty - l.exit_qty for l in self.legs) if self.legs else 0

    @property
    def entry_price(self) -> float:
        """Net entry price per unit (combos: net debit for BUY, net credit for SELL)."""
        if not self.is_combo:
            return self.legs[0].entry_price
        sgn = 1 if self.side == "BUY" else -1
        return sgn * sum((l.entry_price if l.side == "BUY" else -l.entry_price) for l in self.legs)

    @property
    def net(self) -> float:
        return self.gross - self.charges_actual

    def unrealized(self) -> float:
        if not self.is_open or not self.qty:
            return 0.0
        d = 1 if self.side == "BUY" else -1
        return (self.mark - self.entry_price) * d * self.qty
