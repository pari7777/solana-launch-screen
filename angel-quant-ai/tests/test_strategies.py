from datetime import datetime, time as dtime

import numpy as np
import pytest
from fastapi.testclient import TestClient

from app.backtest.engine import run, walk_forward
from app.clock import IST
from app.market.feed import Candle
from app.strategies.stock_intraday import OpeningRangeBreakout


def orb_day(day=30, base=1000.0, breakout=True):
    """15 quiet minutes in a 990–1010 range, then a high-volume breakout and a trend."""
    start = int(datetime(2026, 10, day, 9, 15, tzinfo=IST).timestamp())
    out, px = [], base
    rng = np.random.default_rng(day)
    for i in range(360):
        ts = start + i * 60
        if i < 15:
            o = base + rng.uniform(-8, 8); c = base + rng.uniform(-8, 8); h, l = max(o, c, base + 10) if i == 3 else max(o, c) + 1, min(o, c, base - 10) if i == 5 else min(o, c) - 1
            v = 10_000
        elif i == 16 and breakout:
            o, c, h, l, v = 1009, 1016, 1017, 1008, 60_000
        elif i > 16 and breakout:
            px = 1016 + (i - 16) * 0.35
            o, c, h, l, v = px - 0.35, px, px + 0.5, px - 0.6, 15_000
        else:
            o = c = base + rng.uniform(-5, 5); h, l, v = c + 1, c - 1, 8_000
        out.append(Candle(ts, float(o), float(h), float(l), float(c), float(v)))
    return out


def test_orb_backtest_trades_on_next_bar_open_with_costs(settings, im):
    s = settings.model_copy(update={"min_net_reward_rupees": 50})
    res = run(OpeningRangeBreakout, s, im, {"RELIANCE": orb_day()}, capital=100_000)
    assert res.trades, res.rejected
    t = res.trades[0]
    assert t.side == "BUY" and t.entry > 1016            # filled at the next bar's open + slippage, not the signal close
    assert t.charges > 0 and abs(t.net - (t.gross - t.charges)) < 1e-6
    m = res.metrics(100_000)
    assert m["trades"] == len(res.trades) and m["charges"] > 0


def test_no_trade_without_breakout(settings, im):
    res = run(OpeningRangeBreakout, settings, im, {"RELIANCE": orb_day(breakout=False)})
    assert not res.trades


def test_walk_forward_scores_only_unseen_days(settings, im):
    s = settings.model_copy(update={"min_net_reward_rupees": 50})
    candles = {"RELIANCE": sum((orb_day(d) for d in range(1, 13)), [])}
    out = walk_forward(OpeningRangeBreakout, s, im, candles, grid=[{"OR_MIN": 15}, {"OR_MIN": 10}], train_days=6, test_days=3)
    assert len(out) == 2 and all("test" in w and w["train"] != w["test"] for w in out)


def test_dashboard_requires_password(settings, monkeypatch):
    from app.api.server import build_app
    from app.engine import Engine
    s = settings.model_copy(update={"angel_api_key": "", "database_url": ""})
    from pydantic import SecretStr
    s = s.model_copy(update={"angel_api_key": SecretStr("")})
    e = Engine(s)
    app = build_app(e, "pw123")
    c = TestClient(app)
    assert c.get("/health").json()["ok"]
    assert c.get("/").status_code == 401
    assert c.get("/", auth=("any", "pw123")).status_code == 200
    st = c.get("/api/state", auth=("any", "pw123")).json()
    assert st["mode"] == "paper" and st["live_blockers"]
    assert c.post("/api/control/pause", auth=("any", "pw123")).json()["msg"].startswith("new entries paused")
    assert e.risk.st.paused
    r = c.get("/api/report/full?fmt=xlsx", auth=("any", "pw123"))
    assert r.status_code == 200 and r.content[:2] == b"PK"


@pytest.mark.asyncio
async def test_engine_pipeline_cost_check_risk_and_paper_order(settings, im, monkeypatch):
    """One plan through the whole engine path: regime gate → budget → risk → (Claude off) → OMS → paper fill."""
    import asyncio, time as _t
    from app.broker.ws import SNAP, Tick
    from app.engine import Engine
    from app.market.regime import Regime
    from app.strategies.base import TradePlan
    s = settings.model_copy(update={"no_new_entries_after": dtime(23, 59), "square_off_intraday_at": dtime(23, 59, 59)})
    e = Engine(s)
    e.im = im
    e.oms.im = im
    e.regime = Regime(label="BULL_TREND", trend=0.8)
    ins = [i for i in im.options["NIFTY"] if i.right == "CE"][5]
    now_ms = int(_t.time() * 1000)
    e._on_tick(Tick(token=ins.token, exchange_type=2, mode=SNAP, ltp=100, exchange_ts_ms=now_ms, received_ms=now_ms,
                    bids=[(99.95, 750, 4)], asks=[(100.0, 750, 3)]))
    e.broker.latency_ms, e.broker.reject_rate = (1, 2), 0

    class Fake:
        name, enabled = "opt_momentum", True
        def on_bar(self):
            return [TradePlan(strategy="opt_momentum", ins=ins, side="BUY", product="INTRADAY", qty=75, entry=100.0, stop=96.0,
                              target=110.0, reason="test", underlying="NIFTY", win_prob=0.5, max_entry=100.1)]
    e.strategies = [Fake()]
    await e._run_strategies()
    await asyncio.sleep(0.05)
    sig = e.store.mem_signals[0]
    assert sig["decision"] == "TRADED", sig
    pos = next(iter(e.oms.positions.values()))
    assert pos.status == "OPEN" and pos.qty == 75
    # a plan that cannot cover its costs is rejected before any order
    class Tiny(Fake):
        def on_bar(self):
            p = super().on_bar()[0]; p.target, p.stop = 100.5, 99.5; return [p]
    e.strategies = [Tiny()]
    await e._run_strategies()
    assert e.store.mem_signals[0]["decision"] == "REJECTED"
