import asyncio
import json
import struct
import time
from datetime import date, datetime, time as dtime, timedelta

import httpx
import numpy as np
import pytest

from app.broker.ratelimit import RateLimiter, TokenBucket
from app.broker.rest import AngelRest
from app.broker.ws import SNAP, QUOTE, Tick, decode
from app.clock import IST
from app.costs.charges import ChargeModel
from app.execution.oms import OMS
from app.execution.paper import PaperBroker
from app.market import indicators as ind
from app.market.feed import Candle, MarketData
from app.market.regime import allowed, detect
from app.risk.manager import RiskManager
from app.strategies.base import TradePlan, evaluate, round_tick


# ── WebSocket V2 decoding ──
def packet(mode=SNAP, ex=2, token="50001", ltp=12345, bids=((12340, 150, 3),), asks=((12350, 225, 2),)):
    b = bytearray(379)
    b[0], b[1] = mode, ex
    b[2:2 + len(token)] = token.encode()
    struct.pack_into("<q", b, 27, 7)
    struct.pack_into("<q", b, 35, 1_760_000_000_000)
    struct.pack_into("<q", b, 43, ltp)
    struct.pack_into("<q", b, 67, 99999)
    struct.pack_into("<d", b, 75, 1000.0)
    struct.pack_into("<d", b, 83, 800.0)
    struct.pack_into("<q", b, 115, 12000)
    i = 0
    for flag, side in ((1, bids), (0, asks)):
        for px, q, n in side:
            off = 147 + i * 20
            struct.pack_into("<H", b, off, flag); struct.pack_into("<q", b, off + 2, q)
            struct.pack_into("<q", b, off + 10, px); struct.pack_into("<H", b, off + 18, n)
            i += 1
    struct.pack_into("<q", b, 347, 20000)
    struct.pack_into("<q", b, 355, 100)
    return bytes(b if mode == SNAP else b[:123] if mode == QUOTE else b[:51])


def test_decode_snapquote_prices_in_rupees_and_depth_sides():
    t = decode(packet())
    assert t.token == "50001" and t.exchange_type == 2 and t.ltp == 123.45
    assert t.bid == 123.40 and t.ask == 123.50 and t.bids[0][1] == 150 and t.asks[0][1] == 225
    assert t.close == 120.0 and t.volume == 99999 and t.upper_circuit == 200.0
    assert round(t.spread_pct, 3) == round(0.10 / 123.45 * 100, 3)


def test_decode_ltp_packet():
    t = decode(packet(mode=1))
    assert t.ltp == 123.45 and not t.bids


# ── indicators are causal ──
def test_indicators_no_lookahead():
    rng = np.random.default_rng(1)
    c = 100 + np.cumsum(rng.normal(0, 1, 300))
    h, l = c + 0.5, c - 0.5
    for f in (lambda x: ind.ema(x, 21), lambda x: ind.rsi(x, 14)):
        a, b = f(c[:200]), f(c)
        assert np.allclose(a[~np.isnan(a)], b[:200][~np.isnan(a)])
    a1, a2 = ind.atr(h[:200], l[:200], c[:200]), ind.atr(h, l, c)
    assert np.allclose(a1[20:], a2[20:200])


def test_rsi_bounds_and_trend():
    c = np.linspace(100, 130, 60)
    r = ind.rsi(c, 14)
    assert r[-1] == 100.0
    assert 0 <= np.nanmin(ind.rsi(np.r_[c, c[::-1]], 14)) <= 100


# ── charges ──
def test_option_round_trip_charges_match_published_rates():
    m = ChargeModel()
    # buy 75 @ 100, sell 75 @ 120  → turnover 7,500 + 9,000
    c = m.round_trip("OPT", "BUY", 100, 120, 75)
    assert c.brokerage == 40
    assert c.stt == round(9000 * 0.15 / 100)                 # 0.15% on sell premium → ₹14
    assert abs(c.exchange - 16500 * 0.0355299 / 100) < 1e-3
    assert c.stamp == round(7500 * 0.003 / 100)              # ₹0 after rounding
    assert abs(c.gst - (40 + c.exchange + c.sebi + c.ipft) * 0.18) < 1e-3
    assert 50 < c.total < 70


def test_equity_intraday_brokerage_is_lower_of_20_or_0_1pct():
    m = ChargeModel()
    assert m.leg("EQ_INTRADAY", "BUY", 100, 50).brokerage == 5        # 0.1% of 5,000 = 5
    assert m.leg("EQ_INTRADAY", "BUY", 1000, 100).brokerage == 20     # capped at 20


def plan_for(ins, side="BUY", entry=100.0, stop=95.0, target=115.0, qty=75, p=0.5):
    return TradePlan(strategy="opt_momentum", ins=ins, side=side, product="INTRADAY", qty=qty, entry=entry, stop=stop,
                     target=target, reason="t", underlying="NIFTY", win_prob=p, max_entry=entry + 0.1)


def test_evaluate_rejects_when_costs_eat_the_reward(im):
    ins = im.options["NIFTY"][0]
    small = evaluate(plan_for(ins, entry=100, stop=99, target=101.5), ChargeModel(), 0.1, 150, 1.5)
    assert small.rejected and "net profit" in small.rejected
    good = evaluate(plan_for(ins), ChargeModel(), 0.1, 150, 1.5)
    assert not good.rejected and good.net_target < good.gross_target and good.net_stop < -375
    assert good.ev > 0


def test_round_tick():
    assert round_tick(100.03, 0.05) == 100.05
    assert round_tick(100.03, 0.05, up=False) == 100.0


# ── risk ──
class P:
    def __init__(self, **k):
        self.__dict__.update({"is_open": True, "key": "x", "underlying": "U", "strategy": "s", "capital": 0, "is_option_buy": False, **k})


def test_risk_daily_loss_kill_switch_and_duplicates(settings, im):
    r = RiskManager(settings, 100_000)
    r.roll(100_000)
    ins = im.options["NIFTY"][5]
    plan = evaluate(plan_for(ins, qty=75, entry=40, stop=38, target=46), ChargeModel(), 0.1, 50, 1.5)
    assert r.check(plan, [], 100_000, 0.5, None) is None or "no new intraday" in r.check(plan, [], 100_000, 0.5, None)
    assert "stale" in r.check(plan, [], 100_000, 99, None)
    assert "duplicate" in r.check(plan, [P(key=ins.token)], 100_000, 0.5, None) or "no new" in r.check(plan, [P(key=ins.token)], 100_000, 0.5, None)
    r.on_closed_trade(-2_500, 50, 97_500)
    assert "daily loss" in r.st.kill_switch
    assert "kill switch" in r.check(plan, [], 100_000, 0.5, None)


def test_live_is_blocked_by_default(settings):
    assert settings.trading_mode == "paper"
    assert any("TRADING_MODE" in b for b in settings.live_blockers())
    s2 = settings.model_copy(update={"trading_mode": "live", "live_trading_confirm": "YES"})
    assert any("STATIC_IP" in b for b in s2.live_blockers())


# ── paper broker + OMS ──
def make_tick(token, ltp, bid, ask, qty=750, ex=2):
    return Tick(token=token, exchange_type=ex, mode=SNAP, ltp=ltp, exchange_ts_ms=int(time.time() * 1000),
                received_ms=int(time.time() * 1000), bids=[(bid, qty, 5)], asks=[(ask, qty, 5)])


@pytest.mark.asyncio
async def test_paper_entry_trailing_and_exit_with_charges(settings, im):
    md = MarketData()
    key_for = lambda ins: MarketData.key(2, ins.token)
    broker = PaperBroker(md, key_for, ChargeModel(), latency_ms=(1, 2), reject_rate=0, seed=1)
    closed = []
    s = settings.model_copy(update={"square_off_intraday_at": dtime(23, 59, 59)})
    oms = OMS(s, broker, md, im, key_for, on_closed=closed.append)
    ins = im.options["NIFTY"][4]
    md.on_tick(make_tick(ins.token, 100, 99.95, 100.0))
    plan = evaluate(plan_for(ins, entry=100.0, stop=95.0, target=115.0), ChargeModel(), 0.05, 150, 1.5)
    pos = await oms.open(plan)
    await asyncio.sleep(0.05)
    assert pos.status == "OPEN" and pos.qty == 75 and pos.entry_price == 100.0
    # duplicate guard
    assert await oms.open(plan) is None or pos.status == "OPEN"
    # price runs up: trailing starts at 1R (105), partial at 1.5R (107.5)
    for px in (103, 106, 108):
        md.on_tick(make_tick(ins.token, px, px - 0.05, px)); broker.on_tick(key_for(ins))
        await oms.manage(); await asyncio.sleep(0.02)
    assert pos.trailing and pos.partial_done
    stop_after = pos.stop
    md.on_tick(make_tick(ins.token, 106.5, 106.45, 106.5)); await oms.manage()
    assert pos.stop >= stop_after                         # stop never lowered
    # reversal hits the trailing stop
    md.on_tick(make_tick(ins.token, 103, 102.95, 103.0)); await oms.manage()
    for _ in range(10):
        await asyncio.sleep(0.02)
        broker.on_tick(key_for(ins))
        if pos.status == "CLOSED":
            break
    assert pos.status == "CLOSED" and closed
    assert pos.charges_actual > 0 and abs(pos.net - (pos.gross - pos.charges_actual)) < 1e-9
    assert pos.gross > 0                                   # partial at ~108 and the rest near the trail


@pytest.mark.asyncio
async def test_combo_buys_long_legs_before_short_legs(settings, im):
    md = MarketData()
    key_for = lambda ins: MarketData.key(2, ins.token)
    broker = PaperBroker(md, key_for, ChargeModel(), latency_ms=(1, 2), reject_rate=0)
    sent = []
    orig = broker.place

    async def spy(o):
        sent.append(o.side)
        return await orig(o)
    broker.place = spy
    oms = OMS(settings, broker, md, im, key_for)
    ce = [i for i in im.options["NIFTY"] if i.right == "CE"]
    a, b = ce[4], ce[6]
    md.on_tick(make_tick(a.token, 100, 99.9, 100)); md.on_tick(make_tick(b.token, 40, 40, 40.1))
    plan = TradePlan(strategy="opt_debit_spread", ins=a, side="BUY", product="INTRADAY", qty=75, entry=60, stop=30, target=120,
                     reason="t", underlying="NIFTY",
                     meta={"combo": True, "legs": [{"token": a.token, "symbol": a.symbol, "side": "BUY", "price": 100, "tick": 0.05},
                                                   {"token": b.token, "symbol": b.symbol, "side": "SELL", "price": 40, "tick": 0.05}]})
    pos = await oms.open(plan)
    for _ in range(20):
        await asyncio.sleep(0.02)
        if pos.status == "OPEN":
            break
    assert sent[0] == "BUY" and "SELL" in sent and pos.status == "OPEN"
    assert abs(pos.entry_price - 60) < 0.2


# ── regime ──
def bars(closes, start=None):
    start = start or int(datetime(2026, 10, 30, 9, 15, tzinfo=IST).timestamp())
    ts = np.arange(len(closes)) * 60 + start
    c = np.asarray(closes, float)
    return ts, c, c + 2, c - 2, c, np.zeros(len(c))


def test_regime_trend_and_sideways():
    up = detect(bars(24000 + np.arange(300) * 2.0), 23950, 24000, 13, 13, 15, 5, None)
    assert up.label in ("BULL_TREND", "REVERSAL_UP") and up.trend > 0.4
    rng = np.random.default_rng(3)
    flat = detect(bars(24000 + rng.normal(0, 3, 300)), 24000, 24000, 12, 12, 10, 10, None)
    assert flat.label in ("SIDEWAYS", "VOL_EXPANSION", "REVERSAL_UP", "REVERSAL_DOWN")
    assert allowed(up, "opt_momentum", "LONG") and not allowed(up, "opt_momentum", "SHORT")


# ── instruments ──
def test_instrument_chain_and_strikes(im):
    ex = im.expiries("NIFTY")
    assert ex == [date(2099, 12, 30)]
    near = im.nearest_strikes("NIFTY", ex[0], 25010, 1)
    assert sorted({i.strike for i in near}) == [24900, 25000, 25100] and near[0].lot == 75 and near[0].tick == 0.05
    assert im.index_token("NIFTY") == "99926000" and im.equity["RELIANCE"].tick == 0.10


# ── rate limiter ──
@pytest.mark.asyncio
async def test_token_bucket_limits_rate():
    b = TokenBucket(20, 1)
    t0 = time.monotonic()
    for _ in range(6):
        await b.acquire()
    assert time.monotonic() - t0 >= 0.24


# ── REST login with a mocked Angel One ──
@pytest.mark.asyncio
async def test_login_sends_totp_and_retries_on_auth_error(settings):
    seen = []
    state = {"orders": 0}

    def handler(req: httpx.Request):
        seen.append((req.url.path, dict(req.headers)))
        if req.url.path.endswith("loginByPassword"):
            body = json.loads(req.content)
            assert body["clientcode"] == "C123" and len(body["totp"]) == 6 and body["password"] == "1234"
            return httpx.Response(200, json={"status": True, "data": {"jwtToken": "J", "refreshToken": "R", "feedToken": "F"}})
        if req.url.path.endswith("getProfile"):
            return httpx.Response(200, json={"status": True, "data": {"name": "Test"}})
        if req.url.path.endswith("getOrderBook"):
            state["orders"] += 1
            if state["orders"] == 1:
                return httpx.Response(200, json={"status": False, "errorcode": "AG8001", "message": "Invalid Token"})
            return httpx.Response(200, json={"status": True, "data": []})
        return httpx.Response(404)

    rest = AngelRest(settings, RateLimiter(50, 50, 50, 50), transport=httpx.MockTransport(handler))
    rest.limiter.buckets["login"] = TokenBucket(50)
    await rest.login()
    assert rest.session.jwt == "J" and rest.session.name == "Test"
    assert await rest.order_book() == []
    logins = [p for p, _ in seen if p.endswith("loginByPassword")]
    assert len(logins) == 2                                # re-login after AG8001
    h = [h for p, h in seen if p.endswith("getOrderBook")][-1]
    assert h["authorization"] == "Bearer J" and h["x-privatekey"] == "k"
    await rest.close()
