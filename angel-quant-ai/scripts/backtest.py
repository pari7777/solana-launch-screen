"""Backtest stock strategies on Angel One historical 1-minute candles with full costs, plus walk-forward.

  python -m scripts.backtest --days 60 --strategy stock_orb
Needs Angel One credentials in the environment (historical data API)."""
from __future__ import annotations

import argparse
import asyncio
import json
from datetime import datetime, timedelta

from app.backtest.engine import run, walk_forward
from app.broker.instruments import InstrumentMaster
from app.broker.ratelimit import RateLimiter
from app.broker.rest import AngelRest
from app.clock import IST
from app.config import get_settings
from app.market.feed import Candle
from app.strategies.stock_intraday import OpeningRangeBreakout, VwapReversion, VwapTrendPullback

STRATS = {"stock_orb": OpeningRangeBreakout, "stock_vwap_trend": VwapTrendPullback, "stock_vwap_reversion": VwapReversion}
GRIDS = {"stock_orb": [{"OR_MIN": 15}, {"OR_MIN": 30}], "stock_vwap_trend": [{}], "stock_vwap_reversion": [{}]}


async def fetch(days: int):
    s = get_settings()
    rest = AngelRest(s, RateLimiter(1, 1, s.candle_rate_per_sec, 1))
    await rest.login()
    im = InstrumentMaster(s.scrip_master_url, s.data_dir)
    await im.load()
    out = {}
    end = datetime.now(IST)
    for name in s.stocks:
        ins = im.equity.get(name)
        if not ins:
            continue
        rows, t = [], end - timedelta(days=days)
        while t < end:                        # SmartAPI returns at most ~30 days of 1-minute data per call
            t2 = min(end, t + timedelta(days=25))
            rows += await rest.candles("NSE", ins.token, "ONE_MINUTE", t.strftime("%Y-%m-%d 09:15"), t2.strftime("%Y-%m-%d 15:30"))
            t = t2
        out[name] = sorted({int(datetime.fromisoformat(r[0]).timestamp()): Candle(int(datetime.fromisoformat(r[0]).timestamp()),
                            *map(float, r[1:6])) for r in rows}.values(), key=lambda c: c.ts)
    await rest.close()
    return s, im, out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--days", type=int, default=60)
    ap.add_argument("--strategy", default="stock_orb", choices=list(STRATS))
    ap.add_argument("--capital", type=float, default=100_000)
    a = ap.parse_args()
    s, im, candles = asyncio.run(fetch(a.days))
    res = run(STRATS[a.strategy], s, im, candles, a.capital)
    print(json.dumps({"full_period": res.metrics(a.capital), "rejected": res.rejected}, indent=2))
    print(json.dumps(walk_forward(STRATS[a.strategy], s, im, candles, GRIDS[a.strategy], capital=a.capital), indent=2, default=str))


if __name__ == "__main__":
    main()
