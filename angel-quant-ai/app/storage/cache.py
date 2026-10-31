"""Optional Redis mirror of real-time state (positions, risk, kill switch) for monitoring and fast recovery.
Without REDIS_URL this is a no-op; nothing on the trading path waits for it."""
from __future__ import annotations

import json
import logging

log = logging.getLogger("redis")


class Cache:
    def __init__(self, url: str):
        self.url, self.r = url, None

    async def open(self):
        if not self.url:
            return
        try:
            import redis.asyncio as redis
            self.r = redis.from_url(self.url, socket_timeout=2)
            await self.r.ping()
        except Exception as e:
            log.warning("Redis unavailable (%s) — continuing without it", e)
            self.r = None

    @property
    def kind(self) -> str:
        return "redis" if self.r else "off"

    async def put(self, key: str, value, ttl: int = 30):
        if self.r:
            try:
                await self.r.set(f"aq:{key}", json.dumps(value, default=str), ex=ttl)
            except Exception:
                pass

    async def get(self, key: str):
        if not self.r:
            return None
        try:
            v = await self.r.get(f"aq:{key}")
            return json.loads(v) if v else None
        except Exception:
            return None
