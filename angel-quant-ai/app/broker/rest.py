"""Async Angel One SmartAPI REST client.

Endpoints and headers follow the official smartapi-python SDK (v1.5.5, SmartConnect._routes/requestHeaders).
- Login: clientcode + MPIN + TOTP → jwtToken, refreshToken, feedToken. Tokens expire at 00:00 IST every day.
- Every call is rate-limited centrally and timed (latency is recorded for the dashboard).
- On an auth error the client logs in again once and retries.
"""
from __future__ import annotations

import asyncio
import logging
import time
from dataclasses import dataclass, field
from typing import Any

import httpx
import pyotp

from app.broker.ratelimit import RateLimiter
from app.config import Settings

log = logging.getLogger("angel.rest")

ROUTES = {
    "login": ("/rest/auth/angelbroking/user/v1/loginByPassword", "login"),
    "token": ("/rest/auth/angelbroking/jwt/v1/generateTokens", "login"),
    "logout": ("/rest/secure/angelbroking/user/v1/logout", "other"),
    "profile": ("/rest/secure/angelbroking/user/v1/getProfile", "other"),
    "rms": ("/rest/secure/angelbroking/user/v1/getRMS", "other"),
    "place": ("/rest/secure/angelbroking/order/v1/placeOrder", "order"),
    "modify": ("/rest/secure/angelbroking/order/v1/modifyOrder", "order"),
    "cancel": ("/rest/secure/angelbroking/order/v1/cancelOrder", "order"),
    "orderbook": ("/rest/secure/angelbroking/order/v1/getOrderBook", "other"),
    "tradebook": ("/rest/secure/angelbroking/order/v1/getTradeBook", "other"),
    "positions": ("/rest/secure/angelbroking/order/v1/getPosition", "other"),
    "holdings": ("/rest/secure/angelbroking/portfolio/v1/getHolding", "other"),
    "order_details": ("/rest/secure/angelbroking/order/v1/details/", "other"),
    "quote": ("/rest/secure/angelbroking/market/v1/quote", "quote"),
    "candles": ("/rest/secure/angelbroking/historical/v1/getCandleData", "candle"),
    "estimate_charges": ("/rest/secure/angelbroking/brokerage/v1/estimateCharges", "other"),
    "margin": ("/rest/secure/angelbroking/margin/v1/batch", "other"),
    "option_greeks": ("/rest/secure/angelbroking/marketData/v1/optionGreek", "other"),
}
AUTH_ERRORS = {"AG8001", "AG8002", "AG8003", "AB8050", "AB8051", "AB1010"}


class AngelError(Exception):
    def __init__(self, code: str, message: str):
        super().__init__(f"{code}: {message}")
        self.code, self.message = code, message


@dataclass
class Session:
    jwt: str = ""
    refresh: str = ""
    feed: str = ""
    client_code: str = ""
    logged_in_at: float = 0.0
    name: str = ""


@dataclass
class Latency:
    samples: dict[str, list[float]] = field(default_factory=dict)
    errors: int = 0
    calls: int = 0

    def add(self, name: str, ms: float):
        s = self.samples.setdefault(name, [])
        s.append(ms)
        if len(s) > 200:
            del s[0]

    def summary(self) -> dict[str, dict[str, float]]:
        out = {}
        for k, v in self.samples.items():
            if v:
                sv = sorted(v)
                out[k] = {"p50": round(sv[len(sv) // 2], 1), "p95": round(sv[int(len(sv) * 0.95) - 1 if len(sv) > 1 else 0], 1), "n": len(sv)}
        return out


class AngelRest:
    def __init__(self, s: Settings, limiter: RateLimiter, transport: httpx.AsyncBaseTransport | None = None):
        self.s = s
        self.limiter = limiter
        self.session = Session()
        self.latency = Latency()
        self._login_lock = asyncio.Lock()
        self.http = httpx.AsyncClient(base_url=s.angel_root, timeout=httpx.Timeout(8.0, connect=5.0), transport=transport,
                                      limits=httpx.Limits(max_keepalive_connections=10, keepalive_expiry=60))

    # ── headers ──
    def _headers(self, auth: bool) -> dict[str, str]:
        h = {"Content-Type": "application/json", "Accept": "application/json", "X-UserType": "USER", "X-SourceID": "WEB",
             "X-ClientLocalIP": self.s.client_local_ip, "X-ClientPublicIP": self.s.client_public_ip,
             "X-MACAddress": self.s.client_mac, "X-PrivateKey": self.s.angel_api_key.get_secret_value()}
        if auth and self.session.jwt:
            h["Authorization"] = f"Bearer {self.session.jwt}"
        return h

    @property
    def logged_in(self) -> bool:
        return bool(self.session.jwt)

    # ── auth ──
    async def login(self) -> Session:
        async with self._login_lock:
            if not self.s.has_angel_credentials:
                raise AngelError("NOCREDS", "Angel One credentials are not set")
            totp = pyotp.TOTP(self.s.angel_totp_secret.get_secret_value().replace(" ", "")).now()
            body = {"clientcode": self.s.angel_client_code, "password": self.s.angel_mpin.get_secret_value(), "totp": totp}
            data = await self._call("login", body, auth=False, retry_auth=False)
            self.session = Session(jwt=data["jwtToken"], refresh=data["refreshToken"], feed=data["feedToken"],
                                   client_code=self.s.angel_client_code, logged_in_at=time.time())
            try:
                prof = await self._call("profile", {"refreshToken": self.session.refresh}, method="GET", retry_auth=False)
                self.session.name = str(prof.get("name", ""))
            except Exception as e:  # profile is informational
                log.warning("profile failed: %s", e)
            log.info("Angel One login ok for %s", self.s.angel_client_code)
            return self.session

    async def renew(self) -> None:
        if not self.session.refresh:
            await self.login(); return
        try:
            data = await self._call("token", {"refreshToken": self.session.refresh}, retry_auth=False)
            self.session.jwt, self.session.feed = data["jwtToken"], data.get("feedToken", self.session.feed)
            self.session.refresh = data.get("refreshToken", self.session.refresh)
        except AngelError:
            await self.login()

    # ── core call ──
    async def _call(self, name: str, body: dict | None = None, method: str = "POST", auth: bool = True,
                    retry_auth: bool = True, suffix: str = "") -> Any:
        path, group = ROUTES[name]
        await self.limiter.acquire(group)
        t0 = time.perf_counter()
        self.latency.calls += 1
        try:
            if method == "GET":
                r = await self.http.get(path + suffix, headers=self._headers(auth), params=body or None)
            else:
                r = await self.http.post(path + suffix, headers=self._headers(auth), json=body or {})
        except httpx.HTTPError as e:
            self.latency.errors += 1
            raise AngelError("NETWORK", str(e)) from e
        finally:
            self.latency.add(name, (time.perf_counter() - t0) * 1000)
        if r.status_code == 403 or r.status_code == 401:
            self.latency.errors += 1
            if retry_auth and auth:
                await self.login()
                return await self._call(name, body, method, auth, retry_auth=False, suffix=suffix)
            raise AngelError(f"HTTP{r.status_code}", r.text[:200])
        try:
            j = r.json()
        except ValueError:
            self.latency.errors += 1
            raise AngelError(f"HTTP{r.status_code}", r.text[:200])
        if not j.get("status", False) and j.get("message") != "SUCCESS":
            self.latency.errors += 1
            code = str(j.get("errorcode") or j.get("errorCode") or "UNKNOWN")
            if retry_auth and auth and code in AUTH_ERRORS:
                await self.login()
                return await self._call(name, body, method, auth, retry_auth=False, suffix=suffix)
            raise AngelError(code, str(j.get("message", "")))
        return j.get("data")

    # ── typed helpers ──
    async def rms(self) -> dict:
        return await self._call("rms", method="GET") or {}

    async def quote(self, mode: str, exchange_tokens: dict[str, list[str]]) -> list[dict]:
        """mode: LTP | OHLC | FULL. Max 50 tokens per request."""
        d = await self._call("quote", {"mode": mode, "exchangeTokens": exchange_tokens}) or {}
        return d.get("fetched", [])

    async def candles(self, exchange: str, token: str, interval: str, from_: str, to: str) -> list[list]:
        """interval: ONE_MINUTE, THREE_MINUTE, FIVE_MINUTE, TEN_MINUTE, FIFTEEN_MINUTE, THIRTY_MINUTE, ONE_HOUR, ONE_DAY.
        from_/to: 'YYYY-MM-DD HH:MM' IST. Returns [ts, o, h, l, c, v] rows."""
        return await self._call("candles", {"exchange": exchange, "symboltoken": token, "interval": interval,
                                            "fromdate": from_, "todate": to}) or []

    async def estimate_charges(self, orders: list[dict]) -> dict:
        return await self._call("estimate_charges", {"orders": orders}) or {}

    async def option_greeks(self, name: str, expiry: str) -> list[dict]:
        return await self._call("option_greeks", {"name": name, "expirydate": expiry}) or []

    async def place_order(self, params: dict) -> dict:
        return await self._call("place", params) or {}

    async def modify_order(self, params: dict) -> dict:
        return await self._call("modify", params) or {}

    async def cancel_order(self, variety: str, order_id: str) -> dict:
        return await self._call("cancel", {"variety": variety, "orderid": order_id}) or {}

    async def order_book(self) -> list[dict]:
        return await self._call("orderbook", method="GET") or []

    async def trade_book(self) -> list[dict]:
        return await self._call("tradebook", method="GET") or []

    async def positions(self) -> list[dict]:
        return await self._call("positions", method="GET") or []

    async def close(self):
        await self.http.aclose()
