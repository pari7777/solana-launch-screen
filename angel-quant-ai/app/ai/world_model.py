"""World Market Brain — the forecast model behind the dashboard's Deep Dive tab.

A line-for-line port of the World Market Brain engine (brain.js) so both give the same odds for the same data.
Per asset class, an online logistic regression over 7 explainable signals. Every forecast is graded 24 h later
against the real price and the signals' weights take one gradient step, so the brain improves with every scan.
Pure functions, no I/O: app/ai/world.py collects the data and stores the state.
"""
from __future__ import annotations

import copy
import math
from datetime import datetime

FEATS = ["mom", "reversal", "news", "risk", "macro", "crowd", "contrarian"]
FEAT_NAMES = {"mom": "Price momentum", "reversal": "Over-extension pullback", "news": "News sentiment", "risk": "Global risk mood",
              "macro": "Intermarket links", "crowd": "Investor sentiment", "contrarian": "Extreme-fear contrarian"}

# id, name, class, group, themes, typical 1-day move s (%; bp/10 for yields), beta to world risk mood, Yahoo ticker
_U = [
    ("SPX", "S&P 500", "eq", "US", ["us", "ai", "global"], 1.2, 1, "^GSPC"),
    ("IXIC", "Nasdaq Composite", "eq", "US", ["us", "ai", "tech", "global"], 1.6, 1.2, "^IXIC"),
    ("DJI", "Dow Jones", "eq", "US", ["us", "global"], 1.0, 0.9, "^DJI"),
    ("RUT", "Russell 2000", "eq", "US", ["us", "smallcap"], 1.6, 1.1, "^RUT"),
    ("NIFTY", "Nifty 50", "eq", "India", ["india", "em"], 1.0, 0.7, "^NSEI"),
    ("SENSEX", "Sensex", "eq", "India", ["india", "em"], 1.0, 0.7, "^BSESN"),
    ("BANKNIFTY", "Nifty Bank", "eq", "India", ["india", "banks", "em"], 1.3, 0.8, "^NSEBANK"),
    ("DAX", "DAX 40", "eq", "Europe", ["europe", "global"], 1.1, 0.9, "^GDAXI"),
    ("FTSE", "FTSE 100", "eq", "Europe", ["europe", "uk"], 0.9, 0.7, "^FTSE"),
    ("SX5E", "Euro Stoxx 50", "eq", "Europe", ["europe", "global"], 1.1, 0.9, "^STOXX50E"),
    ("N225", "Nikkei 225", "eq", "Asia", ["japan", "asia", "ai"], 1.4, 1, "^N225"),
    ("HSI", "Hang Seng", "eq", "Asia", ["china", "asia", "em"], 1.6, 0.9, "^HSI"),
    ("SHCOMP", "Shanghai Comp.", "eq", "Asia", ["china", "asia"], 1.1, 0.5, "000001.SS"),
    ("KOSPI", "KOSPI", "eq", "Asia", ["korea", "asia", "ai", "em"], 1.4, 1.1, "^KS11"),
    ("ASX200", "S&P/ASX 200", "eq", "Asia", ["australia", "asia"], 0.9, 0.7, "^AXJO"),
    ("DXY", "US Dollar Index", "fx", "FX", ["usd", "rates"], 0.5, -0.5, "DX-Y.NYB"),
    ("USDINR", "USD/INR", "fx", "FX", ["inr", "india", "usd"], 0.3, -0.4, "INR=X"),
    ("EURUSD", "EUR/USD", "fx", "FX", ["eur", "usd"], 0.5, 0.3, "EURUSD=X"),
    ("USDJPY", "USD/JPY", "fx", "FX", ["jpy", "usd", "rates"], 0.6, 0.4, "JPY=X"),
    ("US10Y", "US 10Y yield", "rate", "Rates", ["rates", "us", "fed"], 0.6, 0.3, "^TNX"),
    ("VIX", "VIX (fear)", "vol", "Volatility", ["us", "fear"], 7, -1.5, "^VIX"),
    ("XAU", "Gold", "cmd", "Commodities", ["gold", "safe", "fed"], 1.3, -0.4, "GC=F"),
    ("XAG", "Silver", "cmd", "Commodities", ["silver", "gold", "metals"], 2.2, 0.2, "SI=F"),
    ("BRENT", "Brent crude", "cmd", "Commodities", ["oil", "energy", "geopolitics"], 2.0, 0.5, "BZ=F"),
    ("WTI", "WTI crude", "cmd", "Commodities", ["oil", "energy", "geopolitics"], 2.1, 0.5, "CL=F"),
    ("NG", "Natural gas", "cmd", "Commodities", ["gas", "energy"], 3.5, 0.1, "NG=F"),
    ("HG", "Copper", "cmd", "Commodities", ["metals", "china", "global"], 1.4, 0.7, "HG=F"),
    ("BTC", "Bitcoin", "crypto", "Crypto", ["crypto", "btc", "risk"], 3, 1.3, "BTC-USD"),
    ("ETH", "Ethereum", "crypto", "Crypto", ["crypto", "eth", "risk"], 4, 1.5, "ETH-USD"),
    ("SOL", "Solana", "crypto", "Crypto", ["crypto", "alt", "risk"], 5, 1.7, "SOL-USD"),
    ("XRP", "XRP", "crypto", "Crypto", ["crypto", "alt", "risk"], 5, 1.5, "XRP-USD"),
    ("BNB", "BNB", "crypto", "Crypto", ["crypto", "alt", "risk"], 3.5, 1.2, "BNB-USD"),
]
U = [{"id": r[0], "name": r[1], "cls": r[2], "group": r[3], "themes": r[4], "s": r[5], "beta": r[6], "yahoo": r[7]} for r in _U]
BY_ID = {a["id"]: a for a in U}
EXTRA = {"INDIAVIX": "^INDIAVIX"}       # shown on the tab, not forecast

W0 = {
    "eq": [0.05, 0.35, 0.45, 0.9, 0.7, 0.6, 0.35, 0.3],
    "fx": [0, 0.3, 0.4, 0.6, 0.5, 0.7, 0.2, 0.1],
    "rate": [0, 0.3, 0.4, 0.7, 0.4, 0.6, 0.2, 0.1],
    "vol": [-0.1, 0.2, 0.6, 0.6, 0.8, 0.4, 0.2, 0.2],
    "cmd": [0, 0.35, 0.45, 0.9, 0.5, 0.7, 0.25, 0.25],
    "crypto": [0, 0.35, 0.4, 0.8, 0.8, 0.6, 0.3, 0.45],
}


def clip(x: float, a: float, b: float) -> float:
    return max(a, min(b, x))


def sig(x: float) -> float:
    return 1 / (1 + math.exp(-x))


def _num(v):
    return v if isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v) else None


def chg(snap: dict, i: str):
    return _num(((snap.get("prices") or {}).get(i) or {}).get("chg"))


def last(snap: dict, i: str):
    return _num(((snap.get("prices") or {}).get(i) or {}).get("last"))


def z(snap: dict, i: str, s: float) -> float:
    c = chg(snap, i)
    return 0.0 if c is None else math.tanh(c / s)


# Model league: every version forecasts every market on every scan, every version is graded, the most accurate leads.
VARIANTS = {
    "core": {"lr": 0.06, "mask": [1, 1, 1, 1, 1, 1, 1], "label": "Core brain"},
    "fast": {"lr": 0.15, "mask": [1, 1, 1, 1, 1, 1, 1], "label": "Fast learner"},
    "steady": {"lr": 0.02, "mask": [1, 1, 1, 1, 1, 1, 1], "label": "Steady learner"},
    "trend": {"lr": 0.06, "mask": [1, 0, 1, 1, 1, 1, 0], "label": "Trend follower"},
    "reversal": {"lr": 0.06, "mask": [0, 1, 1, 1, 1, 0, 1], "label": "Mean reversion"},
}
SAMPLE_W = 0.25          # hourly forecasts overlap (24 a day), so each graded one counts a quarter
EMA_A = 0.01             # accuracy memory: about the last 100 graded calls per version
MIN_LEAD_N = 200         # a version needs this many graded calls before it can take the lead
CALIB_MIN_N = 100        # odds are re-calibrated only after this many graded calls
BUCKETS = [("50–55%", 0.05), ("55–60%", 0.10), ("60–65%", 0.15), ("65%+", 1.0)]


def _variant(weights: dict) -> dict:
    return {"weights": copy.deepcopy(weights), "assetBias": {}, "n": 0, "hits": 0, "ema": 0.25}


def migrate(model: dict | None) -> dict:
    """Bring a saved model (v1 or v2) up to v2; v1 weights seed every league version, so nothing learned is lost."""
    if not model:
        model = {"version": 1, "lr": 0.06, "weights": copy.deepcopy(W0), "featHits": {f: {"n": 0, "h": 0} for f in FEATS},
                 "totals": {"n": 0, "hits": 0, "brier": 0}, "daily": {}, "classStats": {}, "updatedAt": None}
    if not model.get("variants"):
        model["variants"] = {k: _variant(model.get("weights") or W0) for k in VARIANTS}
    for k in VARIANTS:
        model["variants"].setdefault(k, _variant(W0))
    model.setdefault("champion", "core")
    model.setdefault("calib", {"a": 1.0, "b": 0.0, "n": 0})
    model.setdefault("buckets", {b: {"n": 0, "hits": 0} for b, _ in BUCKETS})
    model.setdefault("baselines", {"momentum": {"n": 0, "hits": 0}, "alwaysUp": {"n": 0, "hits": 0}})
    model.setdefault("log", [])
    model["version"] = 2
    model["weights"] = model["variants"][model["champion"]]["weights"]      # what the dashboard shows
    return model


def fresh_model() -> dict:
    return migrate(None)


def _logit(p: float) -> float:
    p = clip(p, 1e-4, 1 - 1e-4)
    return math.log(p / (1 - p))


def calibrate(model: dict, p: float) -> float:
    c = model.get("calib") or {}
    if c.get("n", 0) < CALIB_MIN_N:
        return p
    return sig(c["a"] * _logit(p) + c["b"])


def bucket(p: float) -> str:
    d = abs(p - 0.5)
    for name, top in BUCKETS:
        if d < top:
            return name
    return BUCKETS[-1][0]


def risk_mood(snap: dict) -> float:
    vals = [math.tanh(c / 1.2) for c in (chg(snap, i) for i in ("SPX", "IXIC", "NIFTY", "DAX", "N225", "HSI")) if c is not None]
    eq = sum(vals) / len(vals) if vals else 0.0
    vix = last(snap, "VIX")
    vix_l = 0.0 if vix is None else clip(-(vix - 19) / 12, -1, 1)
    vix_c = -z(snap, "VIX", 8)
    dxy = -z(snap, "DXY", 0.6)
    fgv = _num((snap.get("sentiment") or {}).get("fg"))
    fg = (fgv - 50) / 50 if fgv is not None else 0.0
    return clip(0.35 * eq + 0.25 * vix_l + 0.2 * vix_c + 0.1 * dxy + 0.1 * fg, -1, 1)


def news_score(snap: dict, a: dict) -> float:
    num = den = 0.0
    for it in snap.get("news") or []:
        w, e = it.get("impact") or 1, it.get("effects") or {}
        for t in a["themes"]:
            v = _num(e.get(t))
            if v is not None:
                num += w * v
                den += w
    return clip(num / max(den, 2), -1, 1) if den else 0.0


def _fii(snap: dict) -> float:
    v = _num((snap.get("flows") or {}).get("indiaFiiCr"))
    return math.tanh(v / 4000) if v else 0.0


def macro(snap: dict, a: dict) -> float:
    c = lambda i, s: z(snap, i, s)  # noqa: E731
    i = a["id"]
    if i in ("XAU", "XAG"):
        return clip(-0.5 * c("DXY", 0.5) - 0.4 * c("US10Y", 0.6) - 0.2 * risk_mood(snap), -1, 1)
    if i in ("BRENT", "WTI"):
        return clip(0.4 * c("HG", 1.4) - 0.3 * c("DXY", 0.5) + 0.3 * c("SPX", 1.2), -1, 1)
    if i == "NG":
        return 0.3 * c("BRENT", 2)
    if i == "HG":
        return clip(0.5 * c("HSI", 1.6) - 0.3 * c("DXY", 0.5), -1, 1)
    if i in ("NIFTY", "SENSEX", "BANKNIFTY"):
        return clip(0.35 * c("GIFTNIFTY", 0.8) + 0.25 * _fii(snap) - 0.2 * c("BRENT", 2) - 0.2 * c("USDINR", 0.3) + 0.15 * c("SPX", 1.2), -1, 1)
    if i == "USDINR":
        return clip(0.4 * c("DXY", 0.5) + 0.3 * c("BRENT", 2) - 0.3 * _fii(snap), -1, 1)
    if i == "DXY":
        return clip(0.5 * c("US10Y", 0.6) - 0.3 * risk_mood(snap), -1, 1)
    if i == "EURUSD":
        return clip(-0.6 * c("DXY", 0.5), -1, 1)
    if i == "USDJPY":
        return clip(0.6 * c("US10Y", 0.6) + 0.2 * risk_mood(snap), -1, 1)
    if i == "US10Y":
        return clip(0.3 * c("BRENT", 2) + 0.3 * c("SPX", 1.2), -1, 1)
    if i == "VIX":
        return clip(-0.6 * c("SPX", 1.2) - 0.3 * c("IXIC", 1.6), -1, 1)
    if i == "BTC":
        return clip(0.5 * c("IXIC", 1.6) - 0.3 * c("DXY", 0.5) - 0.2 * c("US10Y", 0.6), -1, 1)
    if i in ("ETH", "SOL", "XRP", "BNB"):
        return clip(0.6 * c("BTC", 3) + 0.3 * c("IXIC", 1.6), -1, 1)
    if a["cls"] == "eq":
        return clip(0.35 * c("SPX", 1.2) + 0.2 * c("IXIC", 1.6) - 0.25 * c("DXY", 0.5) - 0.2 * c("US10Y", 0.6), -1, 1)
    return 0.0


def crowd(snap: dict, a: dict) -> float:
    s = snap.get("sentiment") or {}
    key = "crypto" if a["cls"] == "crypto" else {"India": "india", "Europe": "europe", "Asia": "asia"}.get(a["group"], "us")
    v = _num(s.get(key)) or 0.0
    return -v if a["beta"] < 0 else v


def contrarian(snap: dict, a: dict) -> float:
    s = snap.get("sentiment") or {}
    fg = _num(s.get("fg"))
    if a["cls"] == "crypto" and fg is not None:
        return clip((25 - fg) / 25, 0, 1) - clip((fg - 80) / 20, 0, 1)
    vix = last(snap, "VIX")
    if vix is None:
        return 0.0
    v = clip((vix - 28) / 12, 0, 1) - clip((13 - vix) / 4, 0, 1)
    return -v if a["id"] == "VIX" else (v if a["beta"] > 0 else -v * 0.5)


def features(snap: dict, a: dict) -> list[float]:
    c = chg(snap, a["id"])
    mom = 0.0 if c is None else math.tanh(c / a["s"])
    rev = -math.copysign(1, c) * clip((abs(c) / a["s"] - 1.5) / 2.5, 0, 1) if c else 0.0
    return [mom, rev, news_score(snap, a), clip(risk_mood(snap) * a["beta"], -1, 1), macro(snap, a), crowd(snap, a), contrarian(snap, a)]


def _r(v: float, n: int = 3) -> float:
    return round(v + 0.0, n)


def _raw(model: dict, name: str, a: dict, f: list[float]) -> tuple[float, list[float]]:
    v, mask = model["variants"][name], VARIANTS[name]["mask"]
    w = v["weights"][a["cls"]]
    contrib = [w[i + 1] * f[i] * mask[i] for i in range(len(f))]
    x = w[0] + sum(contrib) + v["assetBias"].get(a["id"], 0.0)
    return clip(sig(x), 0.03, 0.97), contrib


def predict(snap: dict, model: dict | None = None) -> dict:
    model = migrate(model)
    champ = model["champion"]
    out = {}
    for a in U:
        if last(snap, a["id"]) is None:
            continue
        f = features(snap, a)
        praw, contrib = _raw(model, champ, a, f)
        pv = {k: _r(_raw(model, k, a, f)[0]) for k in VARIANTS}
        p = clip(calibrate(model, praw), 0.03, 0.97)
        contrib = [_r(c) for c in contrib]
        top = max(range(len(contrib)), key=lambda i: (abs(contrib[i]), -i))
        c0 = chg(snap, a["id"])
        out[a["id"]] = {"p": _r(p), "praw": _r(praw), "pv": pv, "c0": (1 if c0 > 0 else -1 if c0 < 0 else 0) if c0 is not None else 0,
                        "ref": last(snap, a["id"]), "exp": round((p - 0.5) * 2 * a["s"], 2), "band": a["s"],
                        "f": [_r(v) for v in f], "contrib": contrib, "top": FEATS[top]}
    return {"at": snap.get("at"), "horizonH": 24, "mood": _r(risk_mood(snap)), "items": out, "modelVersion": 2, "champion": champ}


def score_and_learn(pred: dict, later: dict, model: dict) -> dict:
    model = migrate(model)
    items, n, hits, brier = {}, 0, 0, 0.0
    for i, it in (pred.get("items") or {}).items():
        now_p, a = last(later, i), BY_ID.get(i)
        if now_p is None or not a or it.get("ref") is None or now_p == it["ref"]:
            continue
        y = 1 if now_p > it["ref"] else 0
        p = it["p"]
        hit = 1 if (1 if p >= 0.5 else 0) == y else 0
        n += 1
        hits += hit
        brier += (p - y) ** 2
        # how the shown odds did: by confidence, and against two simple rules
        b = model["buckets"].setdefault(bucket(p), {"n": 0, "hits": 0})
        b["n"] += 1
        b["hits"] += hit
        c0 = it.get("c0", 0)
        if c0:
            bm = model["baselines"]["momentum"]
            bm["n"] += 1
            bm["hits"] += 1 if (1 if c0 > 0 else 0) == y else 0
        bu = model["baselines"]["alwaysUp"]
        bu["n"] += 1
        bu["hits"] += y
        # every league version learns from its own forecast
        pv = it.get("pv") or {"core": it.get("praw", p)}
        for name, vp in pv.items():
            if name not in VARIANTS:
                continue
            v, mask = model["variants"][name], VARIANTS[name]["mask"]
            lr = VARIANTS[name]["lr"] * SAMPLE_W / (1 + v["n"] / 3000)       # learn slower as evidence grows
            if not it.get("pv"):
                lr = model.get("lr", 0.06)                                    # v1 forecast: learn exactly as v1 did
            g = y - vp
            w = v["weights"][a["cls"]]
            w[0] += lr * g * 0.5
            for k, fv in enumerate(it["f"]):
                if mask[k]:
                    w[k + 1] = clip(w[k + 1] + lr * g * fv, -2.5, 2.5)
            if it.get("pv"):
                v["assetBias"][i] = round(clip(v["assetBias"].get(i, 0.0) + lr * g * 0.5, -1, 1), 5)
            v["n"] += 1
            v["hits"] += 1 if (1 if vp >= 0.5 else 0) == y else 0
            v["ema"] = round(v["ema"] * (1 - EMA_A) + EMA_A * (vp - y) ** 2, 6)
        # odds calibration (online Platt scaling on the leading version's raw odds)
        if it.get("praw") is not None:
            c = model["calib"]
            L = _logit(it["praw"])
            gc = y - sig(c["a"] * L + c["b"])
            c["a"] = round(clip(c["a"] + 0.01 * SAMPLE_W * gc * L, 0.3, 3), 5)
            c["b"] = round(clip(c["b"] + 0.01 * SAMPLE_W * gc, -1, 1), 5)
            c["n"] += 1
        for k, fv in enumerate(it["f"]):
            if abs(fv) > 0.05:
                fh = model["featHits"][FEATS[k]]
                fh["n"] += 1
                fh["h"] += 1 if (1 if fv > 0 else 0) == y else 0
        cs = model["classStats"].setdefault(a["cls"], {"n": 0, "hits": 0})
        cs["n"] += 1
        cs["hits"] += hit
        items[i] = {"p": p, "y": y, "hit": hit, "move": round((now_p / it["ref"] - 1) * 100, 2)}
    day = (later.get("at") or "")[:10]
    d = model["daily"].setdefault(day, {"n": 0, "hits": 0, "brier": 0})
    d["n"] += n
    d["hits"] += hits
    d["brier"] += brier
    model["totals"]["n"] += n
    model["totals"]["hits"] += hits
    model["totals"]["brier"] += brier
    model["updatedAt"] = later.get("at")
    _pick_champion(model, day)
    return {"at": later.get("at"), "predAt": pred.get("at"), "n": n, "hits": hits, "brier": round(brier / n, 3) if n else None, "items": items}


def _pick_champion(model: dict, day: str) -> None:
    """The version with the lowest recent error leads, once it has enough graded calls and is clearly better."""
    cur = model["champion"]
    ready = {k: v for k, v in model["variants"].items() if v["n"] >= MIN_LEAD_N}
    if not ready:
        return
    best = min(ready, key=lambda k: ready[k]["ema"])
    if best != cur and ready[best]["ema"] < model["variants"][cur]["ema"] - 0.002:
        model["champion"] = best
        model["log"] = ([f"{day}: {VARIANTS[best]['label']} took the lead from {VARIANTS[cur]['label']} "
                         f"(recent error {ready[best]['ema']:.3f} vs {model['variants'][cur]['ema']:.3f})"] + model["log"])[:20]
    model["weights"] = model["variants"][model["champion"]]["weights"]


def league(model: dict) -> list[dict]:
    model = migrate(model)
    return sorted(({"id": k, "label": VARIANTS[k]["label"], "n": v["n"], "hitRate": round(v["hits"] / v["n"], 3) if v["n"] else None,
                    "error": v["ema"], "leader": k == model["champion"]} for k, v in model["variants"].items()),
                  key=lambda r: (r["n"] < MIN_LEAD_N, r["error"]))


def _hours(a: str, b: str) -> float:
    return (datetime.fromisoformat(b.replace("Z", "+00:00")) - datetime.fromisoformat(a.replace("Z", "+00:00"))).total_seconds() / 3600


def step(snapshot: dict, model: dict | None, pending: list[dict]) -> dict:
    """One scan: grade forecasts that are 23–30 h old (older ones are retired), learn, then forecast from this scan."""
    model = migrate(model)
    scores, done = [], []
    for pr in pending or []:
        h = _hours(pr["at"], snapshot["at"])
        if 23 <= h <= 30:
            scores.append(score_and_learn(pr, snapshot, model))
            done.append(pr["at"])
        elif h > 30:
            done.append(pr["at"])
    return {"prediction": predict(snapshot, model), "scores": scores, "model": model, "scoredAts": done}
