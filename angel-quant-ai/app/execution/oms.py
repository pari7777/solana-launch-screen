"""Order and position manager.

Entries: passive-aggressive LIMIT orders. Start at the plan price, step one tick toward the market every few seconds,
never past the plan's max price, cancel what is left after ENTRY_TIMEOUT. A partial fill is kept and sized as filled.
Combos: long legs first, short legs only after the long legs are filled → never naked short. If a short leg cannot be
filled the long legs are closed.
Exits: marketable LIMIT orders (at/through the touch), re-priced every 2 s until done — an exit is never abandoned.
Profit booking: trailing stop from TRAIL_START_R, partial booking at PARTIAL_BOOK_R, stops only ever tighten.
"""
from __future__ import annotations

import asyncio
import itertools
import logging
import math
import time

from app.clock import now_ist
from app.execution.models import Leg, Order, Position
from app.strategies.base import TradePlan, round_tick

log = logging.getLogger("oms")
ENTRY_STEP_S, ENTRY_TIMEOUT_S, EXIT_STEP_S, COMBO_SHORT_TIMEOUT_S = 3.0, 20.0, 2.0, 15.0


class OMS:
    def __init__(self, s, broker, md, im, key_for, on_closed=None, on_event=None):
        self.s, self.broker, self.md, self.im, self.key_for = s, broker, md, im, key_for
        self.on_closed, self.on_event = on_closed, on_event or (lambda *_: None)
        self.positions: dict[int, Position] = {}
        self.orders: dict[str, Order] = {}           # client_ref → order
        self._ids = itertools.count(int(time.time()) % 1_000_000)
        self.broker.on_update = self._on_update
        self.inflight: set[str] = set()              # instrument tokens with an order in flight (duplicate guard)

    # ── helpers ──
    def _tick(self, ins):
        return self.md.ticks.get(self.key_for(ins))

    def _touch(self, ins, side: str) -> float:
        t = self._tick(ins)
        if not t:
            return 0.0
        if side == "BUY":
            return t.ask or t.ltp
        return t.bid or t.ltp

    def mark(self, p: Position) -> float:
        def mid(ins):
            t = self._tick(ins)
            if not t:
                return 0.0
            return (t.bid + t.ask) / 2 if t.bid and t.ask else t.ltp
        if not p.is_combo:
            return mid(p.legs[0].ins)
        sgn = 1 if p.side == "BUY" else -1
        return sgn * sum(mid(l.ins) * (1 if l.side == "BUY" else -1) for l in p.legs)

    async def _send(self, o: Order):
        self.orders[o.client_ref] = o
        self.inflight.add(o.ins.token)
        await self.broker.place(o)

    # ── entry ──
    async def open(self, plan: TradePlan) -> Position | None:
        tokens = [lg["token"] for lg in plan.meta.get("legs", [])] or [plan.ins.token]
        if any(t in self.inflight for t in tokens):
            return None                                   # duplicate-order protection
        pid = next(self._ids)
        if plan.meta.get("combo"):
            legs = [Leg(ins=self.im.get(plan.ins.exchange, lg["token"]), side=lg["side"]) for lg in plan.meta["legs"]]
            if any(l.ins is None for l in legs):
                return None
        else:
            legs = [Leg(ins=plan.ins, side=plan.side)]
        p = Position(id=pid, strategy=plan.strategy, underlying=plan.underlying, product=plan.product, side=plan.side,
                     target_qty=plan.qty, entry_plan=plan.entry, stop=plan.stop, target=plan.target, initial_stop=plan.stop,
                     legs=legs, reason=plan.reason, plan_summary=plan.summary(), charges_est=plan.charges_target,
                     slippage=plan.slippage, capital=plan.capital, signal_ms=plan.meta.get("signal_ms"))
        self.positions[pid] = p
        if p.is_combo:
            for i, (l, lg) in enumerate(zip(legs, plan.meta["legs"])):
                if l.side == "BUY":
                    await self._send(Order(ins=l.ins, side="BUY", qty=plan.qty, price=round_tick(lg["price"], l.ins.tick), product=plan.product,
                                           purpose="ENTRY", position_id=pid, leg=i, max_price=round_tick(lg["price"] + 2 * l.ins.tick, l.ins.tick)))
        else:
            await self._send(Order(ins=plan.ins, side=plan.side, qty=plan.qty, price=plan.entry, product=plan.product, purpose="ENTRY",
                                   position_id=pid, max_price=plan.max_entry or plan.entry))
        self.on_event("entry_sent", p)
        return p

    def _leg_index(self, o: Order) -> int:
        return o.leg

    def _on_update(self, o: Order, q: int, px: float):
        p = self.positions.get(o.position_id)
        if not p:
            return
        if not o.active:
            self.inflight.discard(o.ins.token)
        leg = p.legs[o.leg]
        if q > 0:
            if o.purpose == "ENTRY":
                tot = leg.entry_price * leg.qty + px * q
                leg.qty += q
                leg.entry_price = tot / leg.qty
            else:
                tot = leg.exit_price * leg.exit_qty + px * q
                leg.exit_qty += q
                leg.exit_price = tot / leg.exit_qty
        if o.status == "REJECTED":
            self.on_event("rejected", p, o.reject_reason)
        asyncio.get_running_loop().create_task(self._advance(p))

    async def _advance(self, p: Position):
        """State machine after any order update."""
        entries = [o for o in self.orders.values() if o.position_id == p.id and o.purpose == "ENTRY"]
        exits = [o for o in self.orders.values() if o.position_id == p.id and o.purpose != "ENTRY"]
        if p.status == "PENDING" and entries and not any(o.active for o in entries):
            if p.is_combo:
                longs = [l for l in p.legs if l.side == "BUY"]
                shorts = [l for l in p.legs if l.side == "SELL"]
                sent_shorts = [o for o in entries if o.side == "SELL"]
                filled_long = min((l.qty for l in longs), default=0)
                if not sent_shorts and filled_long > 0 and shorts:
                    for i, l in enumerate(p.legs):
                        if l.side == "SELL":
                            px = self._touch(l.ins, "SELL") or p.plan_summary.get("entry", 0)
                            await self._send(Order(ins=l.ins, side="SELL", qty=filled_long, price=round_tick(px, l.ins.tick),
                                                   product=p.product, purpose="ENTRY", position_id=p.id, leg=i,
                                                   max_price=round_tick(px - 2 * l.ins.tick, l.ins.tick)))
                    return
                if p.qty <= 0 or any(l.qty == 0 for l in p.legs):
                    if any(l.qty for l in p.legs):          # legging failed: close whatever was bought
                        p.status = "OPEN"
                        await self.exit(p, "combo legging incomplete — closing filled legs")
                    else:
                        p.status = "CANCELLED"; p.closed_at = time.time()
                        self.on_event("cancelled", p)
                    return
            elif p.legs[0].qty == 0:
                p.status = "CANCELLED"; p.closed_at = time.time()
                self.on_event("cancelled", p)
                return
            p.status = "OPEN"
            p.mark = p.best = self.mark(p) or p.entry_price
            # stop/target were planned on the plan price; keep the same distances from the actual fill
            shift = p.entry_price - p.entry_plan
            p.stop, p.initial_stop, p.target = p.stop + shift, p.initial_stop + shift, p.target + shift
            self.on_event("opened", p)
        if p.status == "EXITING" and exits and not any(o.active for o in exits):
            if all(l.exit_qty >= l.qty for l in p.legs):
                self._close(p)
            else:
                await self._exit_orders(p, aggressive=True)

    def _close(self, p: Position):
        p.status, p.closed_at = "CLOSED", time.time()
        gross = 0.0
        for l in p.legs:
            d = 1 if l.side == "BUY" else -1
            gross += (l.exit_price - l.entry_price) * d * l.exit_qty
        p.gross = gross
        p.charges_actual = sum(o.charges for o in self.orders.values() if o.position_id == p.id)
        for l in p.legs:
            self.inflight.discard(l.ins.token)
        self.on_event("closed", p)
        if self.on_closed:
            self.on_closed(p)

    # ── exit ──
    async def exit(self, p: Position, reason: str, fraction: float = 1.0):
        if p.status not in ("OPEN", "EXITING"):
            return
        if fraction >= 1.0:
            p.status, p.exit_reason = "EXITING", reason
            await self._cancel_entries(p)
            await self._exit_orders(p)
        else:
            lot = max(1, p.legs[0].ins.lot)
            q = int(math.floor(p.qty * fraction / lot) * lot)
            if q <= 0 or q >= p.qty:
                return
            for i, l in enumerate(self._exit_order_legs(p)):
                await self._send(self._exit_order(p, i, l, q, "PARTIAL"))
            self.on_event("partial", p, reason)

    def _exit_order_legs(self, p: Position):
        # combos: buy back short legs before selling long legs (keeps the position defined-risk while exiting)
        return sorted(p.legs, key=lambda l: 0 if l.side == "SELL" else 1)

    def _exit_order(self, p: Position, _i: int, l: Leg, q: int, purpose: str, aggressive: bool = False) -> Order:
        side = "SELL" if l.side == "BUY" else "BUY"
        touch = self._touch(l.ins, side) or l.entry_price
        ticks = 3 if aggressive else 1
        px = touch - ticks * l.ins.tick if side == "SELL" else touch + ticks * l.ins.tick
        t = self._tick(l.ins)
        if t and t.lower_circuit and side == "SELL":
            px = max(px, t.lower_circuit)
        if t and t.upper_circuit and side == "BUY":
            px = min(px, t.upper_circuit)
        return Order(ins=l.ins, side=side, qty=q, price=round_tick(max(px, l.ins.tick), l.ins.tick), product=p.product,
                     purpose=purpose, position_id=p.id, leg=p.legs.index(l))

    async def _exit_orders(self, p: Position, aggressive: bool = False):
        for l in self._exit_order_legs(p):
            left = l.qty - l.exit_qty - sum(o.remaining for o in self.orders.values()
                                              if o.position_id == p.id and o.active and o.purpose != "ENTRY" and o.leg == p.legs.index(l))
            if left > 0:
                await self._send(self._exit_order(p, 0, l, left, "EXIT", aggressive))

    async def _cancel_entries(self, p: Position):
        for o in list(self.orders.values()):
            if o.position_id == p.id and o.purpose == "ENTRY" and o.active:
                await self.broker.cancel(o)

    async def square_off_all(self, reason: str):
        for p in list(self.positions.values()):
            if p.status == "PENDING":
                await self._cancel_entries(p)
            if p.status in ("OPEN", "EXITING"):
                await self.exit(p, reason)

    # ── periodic: re-pricing and position management ──
    async def reprice(self):
        now = time.time()
        for o in list(self.orders.values()):
            if not o.active or o.status == "SENT":
                continue
            age = now - o.created
            if o.purpose == "ENTRY":
                if age > ENTRY_TIMEOUT_S or (o.side == "SELL" and self.positions[o.position_id].is_combo and age > COMBO_SHORT_TIMEOUT_S):
                    await self.broker.cancel(o)
                elif age > ENTRY_STEP_S * (o.reprices + 1):
                    step = o.ins.tick if o.side == "BUY" else -o.ins.tick
                    new = round_tick(o.price + step, o.ins.tick)
                    if (o.side == "BUY" and new <= o.max_price) or (o.side == "SELL" and new >= o.max_price):
                        await self.broker.modify(o, new)
            elif age > EXIT_STEP_S * (o.reprices + 1):
                touch = self._touch(o.ins, o.side)
                if touch:
                    k = 2 * (o.reprices + 1) * o.ins.tick
                    new = round_tick(touch - k if o.side == "SELL" else touch + k, o.ins.tick)
                    if new > 0 and new != o.price:
                        await self.broker.modify(o, new)

    async def manage(self):
        s = self.s
        n = now_ist()
        for p in list(self.positions.values()):
            if p.status != "OPEN":
                continue
            m = self.mark(p)
            if m <= 0 and not p.is_combo:
                continue
            p.mark = m
            d = 1 if p.side == "BUY" else -1
            risk = abs(p.entry_price - p.initial_stop) or 1e-9
            p.best = max(p.best, m) if d > 0 else min(p.best, m) if p.best else m
            r_now = (m - p.entry_price) * d / risk
            # hard stop
            if (m - p.stop) * d <= 0:
                await self.exit(p, f"{'trailing' if p.trailing else 'stop-loss'} hit at {m:.2f} (stop {p.stop:.2f})")
                continue
            if p.product == "INTRADAY" and n.time() >= s.square_off_intraday_at:
                await self.exit(p, f"intraday square-off {s.square_off_intraday_at:%H:%M}")
                continue
            # partial booking at the milestone, then move the stop to at least break-even
            if not p.partial_done and r_now >= s.partial_book_r:
                p.partial_done = True
                await self.exit(p, f"partial profit at {r_now:.1f}R", fraction=s.partial_book_fraction)
                be = p.entry_price + d * (p.charges_est / max(1, p.target_qty))
                p.stop = max(p.stop, be) if d > 0 else min(p.stop, be)
            # trailing stop: only ever tightens
            if r_now >= s.trail_start_r:
                p.trailing = True
            if p.trailing:
                trail = p.best - d * s.trail_gap_r * risk
                p.stop = max(p.stop, trail) if d > 0 else min(p.stop, trail)
            # fixed target applies only until the partial is booked; the rest rides the trailing stop
            if not p.partial_done and (m - p.target) * d >= 0:
                await self.exit(p, f"target {p.target:.2f} reached")
