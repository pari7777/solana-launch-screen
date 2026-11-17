"""Research rule: momentum. Stocks that rose most over the past ~4 weeks tend to keep outperforming for a while
(cross-sectional momentum, well documented in Indian equities — NSE even runs a Nifty200 Momentum 30 index).

Each morning the bot ranks every universe stock by its 20-trading-day return up to yesterday's close:
percentile 1.0 = strongest, 0.0 = weakest. The engine then avoids buying the weakest names and shorting the strongest.
"""
from __future__ import annotations

import logging
from datetime import datetime

from app.clock import IST
from app.market import yahoo

log = logging.getLogger("aq.momentum")


def ranks(closes: dict[str, list[tuple[str, float]]], asof: str | None = None, lookback: int = 20) -> dict[str, float]:
    """closes: sym → [(YYYY-MM-DD, close)] sorted. Uses only days BEFORE `asof` (no look-ahead). Returns percentiles."""
    ret = {}
    for sym, rows in closes.items():
        r = [c for d, c in rows if asof is None or d < asof]
        if len(r) > lookback and r[-lookback - 1] > 0:
            ret[sym] = r[-1] / r[-lookback - 1] - 1
    if len(ret) < 5:
        return {}
    order = sorted(ret, key=ret.get)
    n = len(order) - 1
    return {s: round(i / n, 3) for i, s in enumerate(order)}


async def daily_closes(stocks: list[str], days: str = "6mo") -> dict[str, list[tuple[str, float]]]:
    got = await yahoo.chart_many([(s, yahoo.ticker(s)) for s in stocks], {"interval": "1d", "range": days})
    out = {}
    for s, rows in got.items():
        out[s] = sorted({datetime.fromisoformat(r[0]).astimezone(IST).date().isoformat(): float(r[4]) for r in rows}.items())
    return out


class Momentum:
    def __init__(self):
        self.pct: dict[str, float] = {}
        self.day = ""
        self.note = "not loaded yet"

    async def refresh(self, stocks: list[str]):
        today = datetime.now(IST).date().isoformat()
        try:
            closes = await daily_closes(stocks)
            self.pct = ranks(closes, asof=today)
            self.day = today
            top = sorted(self.pct, key=self.pct.get, reverse=True)[:5]
            self.note = f"{len(self.pct)} stocks ranked · strongest: {', '.join(top)}" if self.pct else "daily prices unavailable"
        except Exception as ex:  # noqa: BLE001
            self.note = f"daily prices unavailable ({type(ex).__name__})"
            log.warning("momentum: %s", ex)

    def get(self, sym: str) -> float | None:
        return self.pct.get(sym)
