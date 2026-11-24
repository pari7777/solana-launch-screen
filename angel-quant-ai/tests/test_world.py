import asyncio
import copy

from app.ai import world_model as W
from app.ai.world import WorldBrain, effects_for, prices_from_daily

SNAP = {
    "at": "2026-11-24T16:00:00Z",
    "prices": {"SPX": {"last": 7237.17, "chg": 4.73}, "IXIC": {"last": 24089.56, "chg": 6.51}, "DJI": {"last": 49595.31, "chg": 3.01},
               "NIFTY": {"last": 25349.65, "chg": -1.75}, "SENSEX": {"last": 82435.99, "chg": -1.77}, "GIFTNIFTY": {"last": None, "chg": 0.4},
               "VIX": {"last": 28.28, "chg": 6.2}, "DXY": {"last": 104.19, "chg": -0.1}, "US10Y": {"last": 4.93, "chg": -0.3},
               "USDJPY": {"last": 159.33, "chg": None}, "XAU": {"last": 3648, "chg": 3.1}, "BRENT": {"last": 89.53, "chg": 0.18},
               "WTI": {"last": 80.34, "chg": 0.21}, "BTC": {"last": 60458.7, "chg": -1.1}},
    "sentiment": {"us": 0.2, "india": -0.2, "europe": 0, "asia": 0.1, "crypto": -0.7, "fg": 11},
    "flows": {"indiaFiiCr": 5672},
    "news": [{"h": "a", "impact": 3, "effects": {"ai": 0.9, "tech": 0.9, "us": 0.6, "korea": 0.4, "japan": 0.3, "global": 0.4}},
             {"h": "b", "impact": 2, "effects": {"us": -0.4, "global": -0.2}},
             {"h": "c", "impact": 2, "effects": {"us": -0.4, "fear": 0.5, "risk": -0.3}},
             {"h": "d", "impact": 2, "effects": {"india": -0.5, "banks": -0.6}},
             {"h": "e", "impact": 2, "effects": {"india": 0.7, "inr": -0.4, "banks": 0.4}},
             {"h": "f", "impact": 1, "effects": {"india": 0.5}},
             {"h": "g", "impact": 2, "effects": {"oil": -0.6, "energy": -0.5, "india": 0.3, "inr": -0.2}},
             {"h": "h", "impact": 2, "effects": {"gold": 0.3, "fed": -0.3, "rates": -0.2}},
             {"h": "i", "impact": 1, "effects": {"gold": -0.5, "silver": -0.3}},
             {"h": "j", "impact": 2, "effects": {"fear": 0.2, "rates": 0.1}},
             {"h": "k", "impact": 2, "effects": {"crypto": -0.6, "btc": -0.6}},
             {"h": "l", "impact": 1, "effects": {"crypto": 0.4, "btc": 0.4}},
             {"h": "m", "impact": 1, "effects": {"crypto": -0.3}}],
}
# odds the JavaScript engine (World Market Brain, brain.js) gives for this exact scan
JS = {"SPX": 0.621, "IXIC": 0.633, "DJI": 0.63, "NIFTY": 0.52, "SENSEX": 0.521, "DXY": 0.457, "USDJPY": 0.433, "US10Y": 0.509,
      "VIX": 0.508, "XAU": 0.581, "BRENT": 0.445, "WTI": 0.446, "BTC": 0.455}


def test_same_odds_as_js_engine():
    p = W.predict(SNAP)
    assert p["mood"] == -0.256
    assert {k: v["p"] for k, v in p["items"].items()} == JS
    assert p["items"]["SPX"]["top"] == "reversal" and p["items"]["BTC"]["contrib"][6] == 0.252


def test_grading_and_learning():
    model = W.fresh_model()
    pred = W.predict(SNAP, model)
    later = copy.deepcopy(SNAP)
    later["at"] = "2026-11-25T16:00:00Z"
    for v in later["prices"].values():
        if v["last"]:
            v["last"] *= 1.004                                  # everything rose
    before = list(model["weights"]["eq"])
    r = W.step(later, model, [pred])
    s = r["scores"][0]
    assert s["n"] == 13 and s["hits"] == 8 and s["brier"] == 0.236
    assert r["scoredAts"] == [SNAP["at"]] and r["model"]["totals"]["n"] == 13
    assert r["model"]["weights"]["eq"] != before and r["model"]["daily"]["2026-11-25"]["n"] == 13
    # too young: not graded; too old: retired without grading
    assert W.step(SNAP, W.fresh_model(), [pred])["scores"] == []
    old = dict(pred, at="2026-11-20T00:00:00Z")
    r2 = W.step(SNAP, W.fresh_model(), [old])
    assert r2["scores"] == [] and r2["scoredAts"] == [old["at"]]


def test_prices_from_daily():
    rows = {"SPX": [["d", 0, 0, 0, 100.0, 0], ["d", 0, 0, 0, 102.0, 0]], "US10Y": [["d", 0, 0, 0, 4.96, 0], ["d", 0, 0, 0, 4.93, 0]],
            "BTC": [["d", 0, 0, 0, 50000.0, 0]]}
    p, h = prices_from_daily(rows)
    assert p["SPX"]["chg"] == 2.0 and p["US10Y"]["chg"] == -0.3 and p["BTC"]["chg"] is None and h["SPX"] == [100.0, 102.0]
    assert effects_for(-0.5, {"oil": 1, "india": -0.3, "x": 0.01}) == {"oil": -0.5, "india": 0.15}


class _Claude:
    enabled = False


class _Store:
    def __init__(self):
        self.kv = {}

    async def kv_get(self, k, d=None):
        return self.kv.get(k, d)

    def kv_put(self, k, v):
        self.kv[k] = copy.deepcopy(v)


class _S:
    world_every_min = 60


class _Eng:
    def __init__(self):
        self.claude, self.store, self.s, self.events = _Claude(), _Store(), _S(), []

    def event(self, kind, msg):
        self.events.append((kind, msg))


def test_scan_cycle_saves_and_reloads(monkeypatch):
    e = _Eng()
    wb = WorldBrain(e)

    async def fake_scan():
        return {"snap": copy.deepcopy(SNAP), "hist": {"SPX": [1, 2]}}
    monkeypatch.setattr(wb, "scan", fake_scan)
    asyncio.run(wb.run_once())
    assert wb.error == "" and wb.state["pred"]["items"]["SPX"]["p"] == 0.621 and len(wb.state["pending"]) == 1
    assert e.events and e.events[0][0] == "world" and "world_brain" in e.store.kv
    snap = wb.snapshot()
    assert snap["pred"]["mood"] == -0.256 and len(snap["universe"]) == 32 and snap["claude"] is False
    wb2 = WorldBrain(e)
    asyncio.run(wb2.load())
    assert wb2.state["pred"]["items"]["NIFTY"]["p"] == 0.52
    assert "Claude is off" in asyncio.run(wb2.ask("hi"))


def test_too_few_prices_skips_forecast(monkeypatch):
    wb = WorldBrain(_Eng())

    async def fake_scan():
        return {"snap": {"at": "2026-11-24T17:00:00Z", "prices": {"SPX": {"last": 1, "chg": 0}}, "news": []}, "hist": {}}
    monkeypatch.setattr(wb, "scan", fake_scan)
    asyncio.run(wb.run_once())
    assert "forecast skipped" in wb.error and wb.state["pred"] is None


def _simulate(days=20, edge=0.7, seed=1):
    """A made-up world where news pushes prices the OPPOSITE way to the brain's starting belief; it must learn that."""
    import random
    from datetime import datetime, timedelta, timezone
    rnd, model, pending = random.Random(seed), None, []
    prices = {a["id"]: 100.0 for a in W.U}
    t0 = datetime(2026, 11, 1, tzinfo=timezone.utc)
    themes = sorted({t for a in W.U for t in a["themes"]})
    news = None
    for h in range(days * 24):
        at = (t0 + timedelta(hours=h)).strftime("%Y-%m-%dT%H:%M:%SZ")
        if h % 72 == 0:
            news = {t: rnd.uniform(-1, 1) for t in themes}
        for a in W.U:
            s = sum(news[t] for t in a["themes"]) / len(a["themes"])
            d = (1 if s < 0 else -1) if rnd.random() < edge else (1 if rnd.random() < 0.5 else -1)
            prices[a["id"]] *= 1 + d * 0.0006 * (1 + rnd.random())
        snap = {"at": at, "prices": {k: {"last": round(v, 4), "chg": 0.0} for k, v in prices.items()},
                "news": [{"h": "x", "impact": 2, "effects": news}], "sentiment": {}}
        r = W.step(snap, model, pending)
        model = r["model"]
        pending = [p for p in pending if p["at"] not in set(r["scoredAts"])] + [r["prediction"]]
    return model


def test_learns_day_by_day_toward_higher_accuracy():
    m = _simulate()
    rates = [m["daily"][d]["hits"] / m["daily"][d]["n"] for d in sorted(m["daily"]) if m["daily"][d]["n"]]
    first, late = sum(rates[:2]) / 2, sum(rates[-8:]) / 8
    assert first < 0.4 and late > 0.6, rates                 # starts wrong-footed, ends clearly better than a coin flip
    assert m["weights"]["eq"][3] < 0                          # it learned that news works backwards in this world
    top = m["buckets"]["65%+"]
    assert top["hits"] / top["n"] > late - 0.05               # confident calls are at least as good as average
    assert sum(b["n"] for b in m["buckets"].values()) == m["totals"]["n"]
    assert m["calib"]["n"] == m["totals"]["n"] and m["log"]   # odds were re-calibrated; the league changed leader at least once
    lg = W.league(m)
    assert lg[0]["leader"] or any(r["leader"] for r in lg) and len(lg) == 5


def test_v1_model_migrates_without_losing_learning():
    v1 = W.fresh_model()
    v1 = {k: v1[k] for k in ("lr", "featHits", "totals", "daily", "classStats", "updatedAt")} | {"version": 1, "weights": copy.deepcopy(W.W0)}
    v1["weights"]["eq"][3] = 1.7
    v1["totals"] = {"n": 40, "hits": 25, "brier": 9}
    m = W.migrate(v1)
    assert m["version"] == 2 and m["champion"] == "core" and set(m["variants"]) == set(W.VARIANTS)
    assert all(v["weights"]["eq"][3] == 1.7 for v in m["variants"].values()) and m["totals"]["n"] == 40
    assert W.predict(SNAP, m)["items"]["SPX"]["pv"]["core"] == W.predict(SNAP, m)["items"]["SPX"]["praw"]
