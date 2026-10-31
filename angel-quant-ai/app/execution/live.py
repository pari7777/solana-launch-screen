"""Live broker adapter for Angel One. LIMIT orders only (SEBI: no market/IOC orders for API algos),
every order carries ORDER_TAG for the audit trail, and fills are learnt by polling the broker order book.
This class refuses to start unless Settings.live_blockers() is empty."""
from __future__ import annotations

import asyncio
import logging
import time

from app.broker.rest import AngelError, AngelRest
from app.config import Settings
from app.execution.models import Order

log = logging.getLogger("live")

DONE = {"complete": "FILLED", "rejected": "REJECTED", "cancelled": "CANCELLED"}


class LiveBroker:
    name = "live"

    def __init__(self, s: Settings, rest: AngelRest):
        blockers = s.live_blockers()
        if blockers:
            raise RuntimeError("live trading blocked: " + "; ".join(blockers))
        self.s, self.rest = s, rest
        self.orders: dict[str, Order] = {}
        self.on_update = None
        self.last_sync = 0.0
        self.sync_errors = 0

    def _params(self, o: Order) -> dict:
        return {"variety": "NORMAL", "tradingsymbol": o.ins.symbol, "symboltoken": o.ins.token, "transactiontype": o.side,
                "exchange": o.ins.exchange, "ordertype": "LIMIT", "producttype": o.product, "duration": "DAY",
                "price": f"{o.price:.2f}", "quantity": str(o.qty), "squareoff": "0", "stoploss": "0",
                "ordertag": self.s.order_tag[:20]}

    async def place(self, o: Order) -> str:
        o.status, o.sent_at = "SENT", time.time()
        try:
            d = await self.rest.place_order(self._params(o))
        except AngelError as e:
            o.status, o.reject_reason = "REJECTED", str(e)
            if self.on_update:
                self.on_update(o, 0, 0.0)
            return ""
        o.ack_ms = (time.time() - o.sent_at) * 1000
        o.broker_id = str(d.get("orderid", ""))
        o.status = "OPEN"
        self.orders[o.broker_id] = o
        return o.broker_id

    async def modify(self, o: Order, price: float):
        if not o.active or not o.broker_id:
            return
        p = self._params(o)
        p.update({"orderid": o.broker_id, "price": f"{price:.2f}", "quantity": str(o.qty)})
        try:
            await self.rest.modify_order(p)
            o.price, o.reprices = price, o.reprices + 1
        except AngelError as e:
            log.warning("modify %s failed: %s", o.broker_id, e)

    async def cancel(self, o: Order):
        if o.active and o.broker_id:
            try:
                await self.rest.cancel_order("NORMAL", o.broker_id)
            except AngelError as e:
                log.warning("cancel %s failed: %s", o.broker_id, e)

    def on_tick(self, key: str):
        pass

    async def sync(self):
        """Order-book reconciliation: new fills, rejections and cancellations."""
        try:
            book = await self.rest.order_book()
            self.sync_errors = 0
        except AngelError as e:
            self.sync_errors += 1
            log.warning("order book sync failed: %s", e)
            return
        self.last_sync = time.time()
        for row in book or []:
            o = self.orders.get(str(row.get("orderid")))
            if not o or not o.active:
                continue
            filled = int(float(row.get("filledshares") or 0))
            avg = float(row.get("averageprice") or 0)
            if filled > o.filled and avg > 0:
                # derive the price of the newly filled quantity from the cumulative average
                new_q = filled - o.filled
                new_px = (avg * filled - o.avg_price * o.filled) / new_q
                o.add_fill(new_q, new_px)
                if self.on_update:
                    self.on_update(o, new_q, new_px)
            st = str(row.get("status", "")).lower()
            if st in DONE and DONE[st] != "FILLED":
                o.status, o.reject_reason = DONE[st], str(row.get("text", ""))[:120]
                if self.on_update:
                    self.on_update(o, 0, 0.0)

    async def broker_positions(self) -> dict[str, int]:
        rows = await self.rest.positions()
        return {str(r.get("symboltoken")): int(float(r.get("netqty") or 0)) for r in rows or []}

    async def run_sync(self):
        while True:
            if any(o.active for o in self.orders.values()):
                await self.sync()
            await asyncio.sleep(1.5)
