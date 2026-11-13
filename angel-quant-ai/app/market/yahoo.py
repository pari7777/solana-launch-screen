"""Past 1-minute candles from Yahoo Finance's public chart data, used when Angel One refuses getCandleData (AG8004).

No account or key. Only used once at start-up to warm up indicators; live trading still uses Angel One's own tick feed.
Yahoo keeps 1-minute bars for the last ~7 days. Rows come back in the same shape as getCandleData: [iso_ts, o, h, l, c, v].
"""
from __future__ import annotations

import asyncio
import logging
from datetime import datetime, timezone
from urllib.parse import quote
from zoneinfo import ZoneInfo

import httpx

log = logging.getLogger("aq.yahoo")
IST = ZoneInfo("Asia/Kolkata")
URL = "https://query1.finance.yahoo.com/v8/finance/chart/{sym}"
UA = {"User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/124 Safari/537.36", "Accept": "application/json"}
INDEX = {"NIFTY": "^NSEI", "BANKNIFTY": "^NSEBANK", "INDIAVIX": "^INDIAVIX", "FINNIFTY": "NIFTY_FIN_SERVICE.NS"}


def ticker(symbol: str, index: bool = False) -> str:
    return INDEX.get(symbol.upper(), symbol) if index else f"{symbol.upper()}.NS"


def parse(j: dict) -> list[list]:
    """Yahoo chart JSON -> [[iso_ts_ist, o, h, l, c, v], ...] (bars with missing prices are dropped)."""
    res = ((j or {}).get("chart") or {}).get("result") or []
    if not res:
        return []
    r = res[0]
    ts = r.get("timestamp") or []
    q = ((r.get("indicators") or {}).get("quote") or [{}])[0]
    o, h, lo, c, v = (q.get(k) or [] for k in ("open", "high", "low", "close", "volume"))
    out = []
    for i, t in enumerate(ts):
        try:
            if None in (o[i], h[i], lo[i], c[i]):
                continue
            iso = datetime.fromtimestamp(t, timezone.utc).astimezone(IST).isoformat()
            out.append([iso, o[i], h[i], lo[i], c[i], (v[i] if i < len(v) and v[i] is not None else 0)])
        except IndexError:
            break
    return out


async def candles_many(items: list[tuple[str, str]], days: int = 5, parallel: int = 4) -> dict[str, list[list]]:
    """items: [(key, yahoo_ticker)]. Returns {key: rows}; a failing ticker is just skipped."""
    out: dict[str, list[list]] = {}
    sem = asyncio.Semaphore(parallel)
    async with httpx.AsyncClient(timeout=15, headers=UA, follow_redirects=True) as c:
        async def one(key: str, tk: str):
            async with sem:
                try:
                    r = await c.get(URL.format(sym=quote(tk, safe="^._")), params={"interval": "1m", "range": f"{days}d"})
                    if r.status_code == 200:
                        rows = parse(r.json())
                        if rows:
                            out[key] = rows
                    else:
                        log.info("yahoo %s: %s", tk, r.status_code)
                except (httpx.HTTPError, ValueError) as e:
                    log.info("yahoo %s: %s", tk, e)
        await asyncio.gather(*(one(k, t) for k, t in items))
    return out
