"""Central token-bucket rate limiter. Every REST call goes through one bucket per endpoint group,
so all strategies together can never exceed SmartAPI's limits."""
from __future__ import annotations

import asyncio
import time


class TokenBucket:
    def __init__(self, rate_per_sec: float, burst: float | None = None):
        self.rate = rate_per_sec
        self.capacity = burst if burst is not None else max(1.0, rate_per_sec)
        self.tokens = self.capacity
        self.updated = time.monotonic()
        self._lock = asyncio.Lock()

    async def acquire(self, n: float = 1.0) -> float:
        """Wait until n tokens are available. Returns seconds waited."""
        waited = 0.0
        async with self._lock:
            while True:
                now = time.monotonic()
                self.tokens = min(self.capacity, self.tokens + (now - self.updated) * self.rate)
                self.updated = now
                if self.tokens >= n:
                    self.tokens -= n
                    return waited
                need = (n - self.tokens) / self.rate
                waited += need
                await asyncio.sleep(need)


class RateLimiter:
    def __init__(self, order: float, quote: float, candle: float, other: float):
        self.buckets = {"order": TokenBucket(order, 1), "quote": TokenBucket(quote), "candle": TokenBucket(candle, 1),
                        "other": TokenBucket(other, 1), "login": TokenBucket(0.5, 1)}

    async def acquire(self, group: str) -> float:
        return await self.buckets.get(group, self.buckets["other"]).acquire()
