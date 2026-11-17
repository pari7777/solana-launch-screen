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
