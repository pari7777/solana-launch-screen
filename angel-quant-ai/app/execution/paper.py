"""Paper broker on LIVE market data. Simulates what a retail API order really experiences:
order latency, broker/RMS rejections, fills only against the actual best bid/ask and its displayed depth
(partial fills when the depth is thin), price-protection, and every charge on every executed order."""
from __future__ import annotations

import asyncio
import random
import time

from app.costs.charges import ChargeModel, segment_of
from app.execution.models import Order


class PaperBroker:
    name = "paper"

    def __init__(self, md, key_for, charges: ChargeModel, latency_ms=(80, 350), reject_rate: float = 0.005, seed: int | None = None):
        self.md, self.key_for, self.charges = md, key_for, charges
        self.latency_ms, self.reject_rate = latency_ms, reject_rate
        self.rng = random.Random(seed)
        self.orders: dict[str, Order] = {}
        self.on_update = None              # callback(order, fill_qty, fill_price)
        self._seq = 0

    async def place(self, o: Order) -> str:
        self._seq += 1
        o.broker_id = f"P{int(time.time())}{self._seq:04d}"
        o.status, o.sent_at = "SENT", time.time()
        self.orders[o.broker_id] = o
        await asyncio.sleep(self.rng.uniform(*self.latency_ms) / 1000)     # network + broker latency
        o.ack_ms = (time.time() - o.sent_at) * 1000
        t = self.md.ticks.get(self.key_for(o.ins))
        if self.rng.random() < self.reject_rate:
            return self._reject(o, "RMS: order rejected (simulated broker rejection)")
        if t and t.upper_circuit and (o.price > t.upper_circuit or (t.lower_circuit and o.price < t.lower_circuit)):
            return self._reject(o, "price outside circuit limits")
        o.status = "OPEN"
        self.try_fill(o)
        return o.broker_id

    def _reject(self, o: Order, why: str) -> str:
        o.status, o.reject_reason = "REJECTED", why
        if self.on_update:
            self.on_update(o, 0, 0.0)
        return o.broker_id

    async def modify(self, o: Order, price: float):
        await asyncio.sleep(self.rng.uniform(*self.latency_ms) / 2000)
        if o.active:
            o.price, o.reprices = price, o.reprices + 1
            self.try_fill(o)

    async def cancel(self, o: Order):
        await asyncio.sleep(self.rng.uniform(*self.latency_ms) / 2000)
        if o.active:
            o.status = "CANCELLED"
            if self.on_update:
                self.on_update(o, 0, 0.0)

    def on_tick(self, key: str):
        for o in list(self.orders.values()):
            if o.active and o.status != "SENT" and self.key_for(o.ins) == key:
                self.try_fill(o)

    def try_fill(self, o: Order):
        if not o.active or o.status == "SENT":
            return
        t = self.md.ticks.get(self.key_for(o.ins))
        if not t or t.ltp <= 0:
            return
        fills: list[tuple[int, float]] = []
        need = o.remaining
        if o.side == "BUY":
            book = t.asks if t.asks else ([(t.ltp, max(1, o.ins.lot), 1)] if t.ltp <= o.price else [])
            for px, q, _ in book:
                if px > o.price or need <= 0:
                    break
                take = min(need, int(q))
                if take > 0:
                    fills.append((take, px)); need -= take
        else:
            book = t.bids if t.bids else ([(t.ltp, max(1, o.ins.lot), 1)] if t.ltp >= o.price else [])
            for px, q, _ in book:
                if px < o.price or need <= 0:
                    break
                take = min(need, int(q))
                if take > 0:
                    fills.append((take, px)); need -= take
        if not fills:
            return
        # without depth data, only part of the order is assumed to trade on each tick
        if not (t.asks if o.side == "BUY" else t.bids):
            q, px = fills[0]
            lot = max(1, o.ins.lot)
            q = max(lot, (q // 2) // lot * lot) if q > lot else q
            fills = [(q, px)]
        seg = segment_of(o.ins.itype, o.product)
        for q, px in fills:
            o.add_fill(q, px)
            # brokerage is per executed ORDER, so charges are recomputed on the order's cumulative fill
            o.charges = self.charges.leg(seg, o.side, o.avg_price, o.filled, o.ins.exchange).total
            if self.on_update:
                self.on_update(o, q, px)
