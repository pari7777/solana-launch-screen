"""SmartAPI WebSocket V2 (smart-stream) — async client and binary decoder.

Protocol (official smartapi-python SmartWebSocketV2, v1.5.5):
  URL wss://smartapisocket.angelone.in/smart-stream, headers Authorization / x-api-key / x-client-code / x-feed-token
  subscribe {"correlationID", "action": 1, "params": {"mode": 1|2|3, "tokenList": [{"exchangeType": n, "tokens": [...]}]}}
  heartbeat: send text "ping" every ~10 s, server answers "pong"
  binary packets, little-endian; prices are integers in paise (÷100)
Exchange types: 1 NSE_CM, 2 NSE_FO, 3 BSE_CM, 4 BSE_FO, 5 MCX_FO, 13 CDE_FO.
"""
from __future__ import annotations

import asyncio
import json
import logging
import struct
import time
from dataclasses import dataclass, field
from typing import Awaitable, Callable

import websockets

log = logging.getLogger("angel.ws")

LTP, QUOTE, SNAP = 1, 2, 3
EXCHANGE_TYPE = {"NSE": 1, "NFO": 2, "BSE": 3, "BFO": 4, "MCX": 5, "CDS": 13}
EXCHANGE_NAME = {v: k for k, v in EXCHANGE_TYPE.items()}


@dataclass(slots=True)
class Tick:
    token: str
    exchange_type: int
    mode: int
    ltp: float
    exchange_ts_ms: int
    received_ms: int
    volume: int = 0
    avg_price: float = 0.0
    total_buy_qty: float = 0.0
    total_sell_qty: float = 0.0
    open: float = 0.0
    high: float = 0.0
    low: float = 0.0
    close: float = 0.0
    oi: int = 0
    bids: list[tuple[float, int, int]] = field(default_factory=list)   # (price, qty, orders), best first
    asks: list[tuple[float, int, int]] = field(default_factory=list)
    upper_circuit: float = 0.0
    lower_circuit: float = 0.0

    @property
    def bid(self) -> float:
        return self.bids[0][0] if self.bids else 0.0

    @property
    def ask(self) -> float:
        return self.asks[0][0] if self.asks else 0.0

    @property
    def spread_pct(self) -> float | None:
        if self.bid > 0 and self.ask > 0:
            mid = (self.bid + self.ask) / 2
            return (self.ask - self.bid) / mid * 100
        return None


def _q(b: bytes, a: int) -> int:
    return struct.unpack_from("<q", b, a)[0]


def _d(b: bytes, a: int) -> float:
    return struct.unpack_from("<d", b, a)[0]


def decode(b: bytes, divisor: float = 100.0) -> Tick | None:
    """Decode one binary market-data packet (LTP 51 bytes, QUOTE 123, SNAP_QUOTE 379)."""
    if len(b) < 51:
        return None
    mode, ex = b[0], b[1]
    token = b[2:27].split(b"\x00", 1)[0].decode("ascii", "ignore")
    t = Tick(token=token, exchange_type=ex, mode=mode, ltp=_q(b, 43) / divisor, exchange_ts_ms=_q(b, 35),
             received_ms=int(time.time() * 1000))
    if mode in (QUOTE, SNAP) and len(b) >= 123:
        t.volume = _q(b, 67)
        t.avg_price = _q(b, 59) / divisor
        t.total_buy_qty, t.total_sell_qty = _d(b, 75), _d(b, 83)
        t.open, t.high, t.low, t.close = _q(b, 91) / divisor, _q(b, 99) / divisor, _q(b, 107) / divisor, _q(b, 115) / divisor
    if mode == SNAP and len(b) >= 379:
        t.oi = _q(b, 131)
        bids, asks = [], []
        for i in range(10):
            p = b[147 + i * 20: 167 + i * 20]
            flag = struct.unpack_from("<H", p, 0)[0]
            qty, price, orders = _q(p, 2), _q(p, 10) / divisor, struct.unpack_from("<H", p, 18)[0]
            if price <= 0:
                continue
            # SDK note: packets flagged 0 are the SELL side (the SDK swaps its lists); 1 = BUY side
            (bids if flag == 1 else asks).append((price, qty, orders))
        t.bids = sorted(bids, key=lambda x: -x[0])
        t.asks = sorted(asks, key=lambda x: x[0])
        t.upper_circuit, t.lower_circuit = _q(b, 347) / divisor, _q(b, 355) / divisor
    return t


class MarketStream:
    """Keeps one persistent connection, resubscribes after reconnect, reports staleness."""

    def __init__(self, url: str, headers_fn: Callable[[], dict[str, str]], on_tick: Callable[[Tick], None],
                 on_state: Callable[[str], Awaitable[None] | None] | None = None):
        self.url, self.headers_fn, self.on_tick, self.on_state = url, headers_fn, on_tick, on_state
        self.subs: dict[tuple[int, int], set[str]] = {}       # (mode, exchangeType) → tokens
        self.state = "idle"
        self.last_msg = 0.0
        self.reconnects = 0
        self.packets = 0
        self._ws = None
        self._stop = False

    def subscribe(self, mode: int, exchange: str, tokens: list[str]):
        key = (mode, EXCHANGE_TYPE[exchange])
        new = [t for t in tokens if t not in self.subs.setdefault(key, set())]
        self.subs[key].update(new)
        if new and self._ws is not None:
            asyncio.create_task(self._send_sub(1, mode, key[1], new))

    def unsubscribe(self, mode: int, exchange: str, tokens: list[str]):
        key = (mode, EXCHANGE_TYPE[exchange])
        for t in tokens:
            self.subs.get(key, set()).discard(t)
        if self._ws is not None and tokens:
            asyncio.create_task(self._send_sub(0, mode, key[1], tokens))

    async def _send_sub(self, action: int, mode: int, ex: int, tokens: list[str]):
        for i in range(0, len(tokens), 500):
            msg = {"correlationID": f"aq{int(time.time()) % 100000:05d}", "action": action,
                   "params": {"mode": mode, "tokenList": [{"exchangeType": ex, "tokens": tokens[i:i + 500]}]}}
            try:
                await self._ws.send(json.dumps(msg))
            except Exception as e:
                log.warning("subscribe send failed: %s", e)

    async def _set(self, s: str):
        self.state = s
        if self.on_state:
            r = self.on_state(s)
            if asyncio.iscoroutine(r):
                await r

    async def run(self):
        delay = 1.0
        while not self._stop:
            try:
                await self._set("connecting")
                async with websockets.connect(self.url, additional_headers=self.headers_fn(), ping_interval=None,
                                              max_size=2 ** 22, open_timeout=10) as ws:
                    self._ws = ws
                    await self._set("connected")
                    delay = 1.0
                    for (mode, ex), toks in self.subs.items():
                        if toks:
                            await self._send_sub(1, mode, ex, list(toks))
                    hb = asyncio.create_task(self._heartbeat(ws))
                    try:
                        async for msg in ws:
                            self.last_msg = time.time()
                            if isinstance(msg, bytes):
                                t = decode(msg)
                                if t:
                                    self.packets += 1
                                    self.on_tick(t)
                    finally:
                        hb.cancel()
            except Exception as e:
                log.warning("market stream error: %s", e)
            self._ws = None
            if self._stop:
                break
            self.reconnects += 1
            await self._set(f"reconnecting in {delay:.0f}s")
            await asyncio.sleep(delay)
            delay = min(30.0, delay * 2)

    async def _heartbeat(self, ws):
        while True:
            await asyncio.sleep(10)
            try:
                await ws.send("ping")
            except Exception:
                return

    def stop(self):
        self._stop = True
