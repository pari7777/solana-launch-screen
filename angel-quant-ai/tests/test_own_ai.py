"""The bot's own AI: news relevance filter, FinBERT aggregation, and the self-learning trade scorer."""
import time
from types import SimpleNamespace as N

import numpy as np

from app.ai import nlp
from app.ai.scorer import FEATURES, Shadow, TradeBrain, auc
from app.config import Settings
from app.market.feed import Candle, Series
from app.storage.db import Store


def test_relevance_filter_drops_other_companies():
    names = nlp.aliases("DIXON", "Dixon Technologies (India) Ltd.")
    assert "dixon technologies" in names and "dixon" in names
    assert nlp.relevant("Dixon Technologies shares jump on new order", names)
    assert not nlp.relevant("SHALPAINTS Share Price Today - Shalimar Paints on NSE/BSE", names)
    tata = nlp.aliases("TATACHEM", "Tata Chemicals Ltd.")
    assert "tata" not in tata                                    # too common on its own
    assert not nlp.relevant("Tata Motors PV shares plunge 9% after Q2 results", tata)
    assert nlp.relevant("Tata Chemicals shares jump 5.4%", tata)


def test_aggregate_weights_confident_headlines():
    assert nlp.aggregate([(0.9, 0.95), (0.02, 0.05)]) > 0.8
    assert nlp.aggregate([]) == 0.0


def test_auc():
    y = np.array([0, 0, 1, 1]); assert auc(y, np.array([0.1, 0.2, 0.8, 0.9])) == 1.0
    assert abs(auc(y, np.array([0.5, 0.5, 0.5, 0.5])) - 0.5) < 1e-9


def _engine(tmp_path):
    s = Settings(_env_file=None, data_dir=str(tmp_path), brain_min_samples=300)
    return N(s=s, store=Store(""), md=N(series={}), key_for=lambda ins: ins.token)


def _feats(x):
    f = {k: 0.0 for k in FEATURES}
    f["news"] = x
    return f


async def test_scorer_learns_real_edge_and_rejects_noise(tmp_path):
    rng = np.random.default_rng(1)
    e = _engine(tmp_path)
    t = time.time() - 86400 * 10
    for i in range(800):                                         # wins come when news is positive
        x = float(rng.uniform(-1, 1))
        e.store.mem_ml.append({"t": t + i, "label": int(rng.random() < (0.75 if x > 0 else 0.2)), "feats": _feats(x)})
    b = TradeBrain(e)
    msg = await b.train()
    assert "ADOPTED" in msg[0] and b.state.model is not None
    assert b.predict(_feats(0.8)) > b.predict(_feats(-0.8))

    e2 = _engine(tmp_path / "n")
    for i in range(800):                                         # pure noise → must NOT adopt
        e2.store.mem_ml.append({"t": t + i, "label": int(rng.random() < 0.4), "feats": _feats(float(rng.uniform(-1, 1)))})
    b2 = TradeBrain(e2)
    assert "not adopted" in (await b2.train())[0] and b2.state.model is None


async def test_too_few_lessons(tmp_path):
    e = _engine(tmp_path)
    e.store.mem_ml.extend({"t": i, "label": i % 2, "feats": _feats(0)} for i in range(50))
    assert "needs" in (await TradeBrain(e).train())[0]


def test_shadow_outcome_stop_first_is_a_loss(tmp_path):
    e = _engine(tmp_path)
    b = TradeBrain(e)
    now = time.time()
    ser = Series(live=False)
    t0 = int(now // 60 * 60)
    ser.candles.append(Candle(t0 + 60, 100, 100.5, 99.0, 99.5, 10))   # touches stop 98? no
    ser.candles.append(Candle(t0 + 120, 99.5, 103.5, 97.5, 103, 10))  # stop AND target in same bar → loss
    e.md.series["k"] = ser
    sh = Shadow("k", "stock_orb", "X", "BUY", 100, 98, 103.2, 10, 20, -25, 5, {}, now)
    b.open.append(sh)
    b.update()
    assert sh.done and e.store.mem_ml[-1]["label"] == 0


def test_pretrain_replay_makes_lessons_without_lookahead():
    from datetime import datetime, timedelta
    from app.ai.pretrain import _regime_timeline, _replay_stock
    from app.clock import IST
    from app.costs.charges import ChargeModel
    s = Settings(_env_file=None)
    ins = N(token="1", symbol="TEST-EQ", name="TEST", exchange="NSE", itype="", expiry=None, strike=0, lot=1, tick=0.05, is_option=False)
    im = N(equity={"TEST": ins})
    rng = np.random.default_rng(3)
    cs, nif, p, q = [], [], 1000.0, 24000.0
    d0 = datetime(2026, 9, 1, 9, 15, tzinfo=IST)
    for day in range(5):
        for m in range(375):
            ts = int((d0 + timedelta(days=day, minutes=m)).timestamp())
            o = p; p *= 1 + rng.normal(0, 0.0015)
            cs.append(Candle(ts, o, max(o, p) * 1.0005, min(o, p) * 0.9995, p, float(rng.integers(1000, 9000))))
            o2 = q; q *= 1 + rng.normal(0, 0.0005)
            nif.append(Candle(ts, o2, max(o2, q), min(o2, q), q, 0))
    L = _replay_stock(s, im, "TEST", cs, _regime_timeline(nif, {}), {}, ChargeModel())
    assert L and all(set(FEATURES) <= set(x["feats"]) for x in L)
    assert all(x["outcome"] in ("stop", "target", "square-off") for x in L)
    assert all(abs(x["feats"]["stop_pct"] - 2.0) < 0.1 for x in L)        # live 2 % stop rule


def _flow():
    from app.market.flow import FlowBrain
    return FlowBrain(N(s=Settings(_env_file=None)))


def test_guard_hype_pump_and_vertical_run():
    from app.market.flow import Flow
    fb = _flow()
    f = fb.by.setdefault("X", Flow()); f.big_sell, f.big_buy = 6, 1
    assert "hype pump" in fb.gate("X", "LONG", session_move_pct=7, vol_ratio=4, news_score=0.8)
    now = time.time()
    g = fb.by.setdefault("Y", Flow())
    g.px = [(now - 900 + i * 60, 100 + i * 0.4) for i in range(16)]          # +6 % in 15 min
    assert "not chasing" in fb.gate("Y", "LONG", news_score=0.0)
    h = fb.by.setdefault("Z", Flow())
    h.px = [(now - 1700 + i * 60, p) for i, p in enumerate([100, 101, 102, 103, 104, 105, 104, 103, 102.5, 102, 102, 102])]
    assert "dump under way" in fb.gate("Z", "LONG", news_score=0.0)


def test_guard_spoofing_detects_vanishing_buy_wall():
    from app.market.flow import Flow, FlowBrain
    f = Flow(); now = time.time()
    f.book = [(now - 100 + i * 2, 10_000.0, 10_000.0, 50_000.0) for i in range(35)]   # normal book
    f.book += [(now - 20, 40_000.0, 10_000.0, 50_000.0), (now - 15, 40_000.0, 10_000.0, 50_100.0),
               (now - 10, 30_000.0, 10_000.0, 50_200.0), (now - 1, 10_500.0, 10_000.0, 50_300.0)]   # wall appears, vanishes
    FlowBrain._spoof_check(f, now)
    assert f.spoof_buy_at and f.spoofs == 1
