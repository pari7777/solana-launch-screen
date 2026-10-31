"""In-memory market state: latest tick per instrument and 1-minute candles built from ticks.
No database access on the tick path. Candles can be seeded from SmartAPI historical data."""
from __future__ import annotations

import time
from collections import deque
from dataclasses import dataclass, field

import numpy as np

from app.broker.ws import Tick
from app.clock import IST


@dataclass(slots=True)
class Candle:
    ts: int          # minute start, epoch seconds
    o: float
    h: float
    l: float
    c: float
    v: float


@dataclass
class Series:
    candles: deque = field(default_factory=lambda: deque(maxlen=800))
    last_cum_vol: int = -1
    live: bool = True            # live: the newest candle is still forming and is excluded from signals

    def arrays(self, include_open: bool = False):
        cs = list(self.candles) if (include_open or not self.live) else list(self.candles)[:-1]
        if not cs:
            z = np.array([])
            return z, z, z, z, z, z
        return (np.array([x.ts for x in cs]), np.array([x.o for x in cs]), np.array([x.h for x in cs]),
                np.array([x.l for x in cs]), np.array([x.c for x in cs]), np.array([x.v for x in cs]))

    def session(self, include_open: bool = False):
        """Arrays for today's IST session only (for VWAP / opening range)."""
        ts, o, h, l, c, v = self.arrays(include_open)
        if not len(ts):
            return ts, o, h, l, c, v
        # IST day boundary
        day = (ts + 19800) // 86400
        m = day == day[-1]
        return ts[m], o[m], h[m], l[m], c[m], v[m]


class MarketData:
    def __init__(self):
        self.ticks: dict[str, Tick] = {}
        self.series: dict[str, Series] = {}
        self.last_tick_at = 0.0
        self.tick_count = 0

    @staticmethod
    def key(exchange_type: int, token: str) -> str:
        return f"{exchange_type}:{token}"

    def on_tick(self, t: Tick):
        k = self.key(t.exchange_type, t.token)
        self.ticks[k] = t
        self.last_tick_at = time.time()
        self.tick_count += 1
        if t.ltp <= 0:
            return
        s = self.series.setdefault(k, Series())
        sec = (t.exchange_ts_ms // 1000) if t.exchange_ts_ms > 1e12 else int(time.time())
        minute = sec - sec % 60
        dv = 0.0
        if t.volume:
            dv = 0.0 if s.last_cum_vol < 0 else max(0, t.volume - s.last_cum_vol)
            s.last_cum_vol = t.volume
        if s.candles and s.candles[-1].ts == minute:
            cd = s.candles[-1]
            cd.h, cd.l, cd.c, cd.v = max(cd.h, t.ltp), min(cd.l, t.ltp), t.ltp, cd.v + dv
        elif not s.candles or minute > s.candles[-1].ts:
            s.candles.append(Candle(minute, t.ltp, t.ltp, t.ltp, t.ltp, dv))

    def seed(self, k: str, rows: list[list]):
        """rows from getCandleData: [iso_ts, o, h, l, c, v]."""
        from datetime import datetime
        s = self.series.setdefault(k, Series())
        existing = {c.ts for c in s.candles}
        new = []
        for r in rows:
            try:
                ts = int(datetime.fromisoformat(str(r[0])).astimezone(IST).timestamp())
            except ValueError:
                continue
            if ts not in existing:
                new.append(Candle(ts, float(r[1]), float(r[2]), float(r[3]), float(r[4]), float(r[5])))
        merged = sorted(list(s.candles) + new, key=lambda c: c.ts)
        s.candles.clear()
        s.candles.extend(merged[-s.candles.maxlen:])

    def age(self, k: str) -> float:
        t = self.ticks.get(k)
        return (time.time() * 1000 - t.received_ms) / 1000 if t else 1e9

    def ltp(self, k: str) -> float:
        t = self.ticks.get(k)
        return t.ltp if t else 0.0
