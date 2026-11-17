"""Self-learning trade scorer — the bot's own machine-learning model (runs on the server, no API key).

1. OBSERVE: every stock signal a strategy produces — traded or rejected — is recorded with ~30 facts known at that
   moment (strategy, side, market regime, ADX, VIX, time of day, stop %, target %, reward/risk, news score from
   FinBERT, big-player flow, spread, move since open, volume surge …).
2. SHADOW OUTCOME: the bot then watches the real price for that signal as if it had taken it: target hit first = win,
   stop hit first = loss (same minute = loss, to stay conservative), still open at square-off = closed at that price
   after charges. So even rejected signals become lessons — dozens a day instead of a handful of trades.
3. TRAIN (nightly, after the close): a gradient-boosted tree model learns P(win | facts) from the last 60 days.
   It is ADOPTED only if it beats chance on the most recent 20% of days it never saw while learning
   (time-ordered hold-out, AUC ≥ BRAIN_MIN_AUC). Otherwise the previous model (or none) stays — it cannot learn
   nonsense from noise and it never touches the risk limits.
4. USE: with an adopted model, each new signal gets a win chance; below BRAIN_MIN_PROB it is skipped, and size is
   scaled 0.5×–1.5× by how much better than average the signal looks.
"""
from __future__ import annotations

import asyncio
import logging
import math
import os
import pickle
import time
from dataclasses import dataclass, field

import numpy as np

from app.clock import minutes_since_open, now_ist

log = logging.getLogger("aq.brain")
STRATS = ("stock_orb", "stock_vwap_trend", "stock_vwap_reversion")
REGIMES = ("BULL_TREND", "BEAR_TREND", "SIDEWAYS", "VOL_EXPANSION", "REVERSAL_UP", "REVERSAL_DOWN", "UNKNOWN")
NUM = ("side", "minutes", "stop_pct", "target_pct", "rr", "win_prob", "news", "has_news", "news_event", "market_news",
       "flow", "book", "spread_pct", "move_pct", "vol_ratio", "trend", "adx", "atr_pct", "vix", "vix_chg", "gap_pct", "breadth",
       "momentum")
FEATURES = NUM + tuple(f"s_{x}" for x in STRATS) + tuple(f"r_{x}" for x in REGIMES)


def vector(f: dict) -> list[float]:
    out = []
    for k in FEATURES:
        v = f.get(k)
        out.append(float(v) if isinstance(v, (int, float)) and v is not None and math.isfinite(v) else float("nan"))
    return out


def auc(y: np.ndarray, p: np.ndarray) -> float:
    """Rank AUC without sklearn.metrics (0.5 = chance)."""
    pos, neg = p[y == 1], p[y == 0]
    if not len(pos) or not len(neg):
        return 0.5
    from scipy.stats import rankdata                 # average ranks, so ties count as half
    ranks = rankdata(np.concatenate([pos, neg]))
    return float((ranks[: len(pos)].sum() - len(pos) * (len(pos) + 1) / 2) / (len(pos) * len(neg)))


@dataclass
class Shadow:
    key: str
    strategy: str
    symbol: str
    side: str
    entry: float
    stop: float
    target: float
    qty: int
    net_target: float
    net_stop: float
    charges: float
    feats: dict
    t0: float
    traded: bool = False
    done: bool = False


@dataclass
class BrainState:
    model: object = None
    meta: dict = field(default_factory=dict)       # n, auc, base_rate, trained_at, features


class TradeBrain:
    def __init__(self, engine):
        self.e = engine
        self.s = engine.s
        self.open: list[Shadow] = []
        self.recent: dict[tuple, float] = {}       # (strategy, symbol, side) → last time recorded
        self.state = BrainState()
        self.today = {"observed": 0, "won": 0, "lost": 0, "skipped": 0}
        self.path = os.path.join(self.s.data_dir, "trade_brain.pkl")
        self.last_log: list[str] = []

    # ── features at signal time ──
    def features(self, plan, side: str, spread: float | None) -> dict:
        r = self.e.regime
        news = self.e.news.get(plan.underlying) if self.s.news_enabled else None
        fl = self.e.flow.summary(plan.underlying) if self.s.flow_enabled else {}
        mv = vr = None
        ser = self.e.md.series.get(self.e.key_for(plan.ins))
        if ser:
            ts, o, h, l, c, v = ser.session()
            if len(c) >= 5 and o[0] > 0:
                mv = (c[-1] / o[0] - 1) * 100
                vr = float(v[-5:].mean() / v[:-5].mean()) if len(v) > 10 and v[:-5].mean() > 0 else None
        e = plan.entry or 0
        f = {"side": 1 if plan.side == "BUY" else -1, "minutes": minutes_since_open(),
             "stop_pct": abs(plan.entry - plan.stop) / e * 100 if e else None,
             "target_pct": abs(plan.target - plan.entry) / e * 100 if e else None,
             "rr": plan.rr, "win_prob": plan.win_prob,
             "news": news["score"] if news else 0.0, "has_news": 1.0 if news and news.get("headlines") else 0.0,
             "news_event": 1.0 if news and news.get("event") else 0.0,
             "market_news": (self.e.news.market or {}).get("score") if self.s.news_enabled else None,
             "flow": fl.get("flow_score"), "book": fl.get("book_pressure"),
             "spread_pct": (spread / e * 100) if spread and e else None, "move_pct": mv, "vol_ratio": vr,
             "trend": r.trend, "adx": r.adx, "atr_pct": r.atr_pct, "vix": r.vix, "vix_chg": r.vix_change_pct,
             "gap_pct": r.gap_pct, "breadth": r.breadth,
             "momentum": self.e.momentum.get(plan.underlying) if hasattr(self.e, "momentum") else None}
        for x in STRATS:
            f[f"s_{x}"] = 1.0 if plan.strategy == x else 0.0
        for x in REGIMES:
            f[f"r_{x}"] = 1.0 if r.label == x else 0.0
        return f

    # ── 1. observe ──
    def observe(self, plan, feats: dict) -> Shadow | None:
        if plan.product != "INTRADAY" or plan.ins.lot > 1 or not plan.qty or plan.entry <= 0:
            return None
        k = (plan.strategy, plan.ins.symbol, plan.side)
        now = time.time()
        if now - self.recent.get(k, 0) < 15 * 60:        # the same signal repeats every minute — count it once
            return None
        self.recent[k] = now
        sh = Shadow(self.e.key_for(plan.ins), plan.strategy, plan.ins.symbol, plan.side, plan.entry, plan.stop, plan.target,
                    plan.qty, plan.net_target, plan.net_stop, plan.charges_target, feats, now)
        self.open.append(sh)
        self.today["observed"] += 1
        return sh

    # ── 2. shadow outcome ──
    def update(self):
        if not self.open:
            return
        n = now_ist()
        sq = n.time() >= self.s.square_off_intraday_at
        for sh in self.open:
            ser = self.e.md.series.get(sh.key)
            if not ser:
                continue
            ts, o, h, l, c, v = ser.session()
            m = ts >= sh.t0 - 1
            if not m.any():
                continue
            hh, ll, cc = h[m], l[m], c[m]
            buy = sh.side == "BUY"
            hit_stop = (ll <= sh.stop) if buy else (hh >= sh.stop)
            hit_tgt = (hh >= sh.target) if buy else (ll <= sh.target)
            i_s = int(np.argmax(hit_stop)) if hit_stop.any() else None
            i_t = int(np.argmax(hit_tgt)) if hit_tgt.any() else None
            if i_s is not None and (i_t is None or i_s <= i_t):
                self._resolve(sh, 0, sh.net_stop, "stop")
            elif i_t is not None:
                self._resolve(sh, 1, sh.net_target, "target")
            elif sq:
                gross = (float(cc[-1]) - sh.entry) * (1 if buy else -1) * sh.qty
                net = gross - sh.charges
                self._resolve(sh, 1 if net > 0 else 0, net, "square-off")
        self.open = [x for x in self.open if not x.done]
        if n.hour < 9:                                   # new day: drop yesterday's leftovers
            self.open.clear()

    def _resolve(self, sh: Shadow, label: int, net: float, how: str):
        sh.done = True
        self.today["won" if label else "lost"] += 1
        self.e.store.ml_sample(sh.strategy, sh.symbol, sh.side, sh.traded, label, net, how, sh.feats, sh.t0)

    # ── 3. train ──
    async def load(self):
        try:
            with open(self.path, "rb") as fh:
                d = pickle.load(fh)
            if d.get("features") == list(FEATURES):
                self.state = BrainState(d["model"], d["meta"])
        except FileNotFoundError:
            pass
        except Exception as ex:  # noqa: BLE001
            log.warning("brain load: %s", ex)

    async def train(self, rows: list[dict] | None = None, arrays: tuple | None = None) -> list[str]:
        """rows: [{t, label, feats|x}] (sorted here by time), or arrays=(t, X, y) already built (pre-training)."""
        if arrays is not None:
            t_, X, y = arrays
            o = np.argsort(t_, kind="stable")
            X, y = np.asarray(X, dtype=float)[o], np.asarray(y)[o]
        else:
            rows = rows if rows is not None else await self.e.store.ml_samples(days=self.s.brain_pretrain_days + 30)
            if not rows:
                return ["trade brain: no signals recorded yet"]
            rows.sort(key=lambda r: r["t"])
            X = np.array([r["x"] if "x" in r else vector(r["feats"]) for r in rows], dtype=float)
            y = np.array([int(r["label"]) for r in rows])
        if not len(y):
            return ["trade brain: no signals recorded yet"]
        n, pos = len(y), int(y.sum())
        need = self.s.brain_min_samples
        if n < need or pos < 25 or n - pos < 25:
            return [f"trade brain: {n} lessons so far ({pos} wins) — needs {need}+ with 25+ wins and losses before it learns"]
        cut = int(n * 0.8)
        try:
            res = await asyncio.to_thread(self._fit, X, y, cut)
        except Exception as ex:  # noqa: BLE001
            log.warning("brain train: %s", ex)
            return [f"trade brain: training failed ({type(ex).__name__})"]
        model, a, base = res
        old = self.state.meta.get("auc")
        if a < self.s.brain_min_auc:
            return [f"trade brain: new model not adopted — hold-out AUC {a:.2f} < {self.s.brain_min_auc} (no real edge found yet; "
                    f"{n} lessons, win rate {base:.0%})" + (f"; keeping previous model (AUC {old:.2f})" if old else "")]
        self.state = BrainState(model, {"n": n, "auc": round(a, 3), "base_rate": round(base, 3), "trained_at": time.time(),
                                        "day": now_ist().date().isoformat()})
        try:
            os.makedirs(self.s.data_dir, exist_ok=True)
            with open(self.path, "wb") as fh:
                pickle.dump({"model": model, "meta": self.state.meta, "features": list(FEATURES)}, fh)
        except OSError as ex:
            log.warning("brain save: %s", ex)
        return [f"trade brain: ADOPTED new model — hold-out AUC {a:.2f} on the latest {n - cut} unseen lessons "
                f"(trained on {n}, base win rate {base:.0%})"]

    @staticmethod
    def _fit(X, y, cut):
        from sklearn.ensemble import HistGradientBoostingClassifier
        mk = lambda: HistGradientBoostingClassifier(max_depth=3, max_iter=200, learning_rate=0.05, l2_regularization=1.0,  # noqa: E731
                                                    min_samples_leaf=20, random_state=7)
        m = mk().fit(X[:cut], y[:cut])
        a = auc(y[cut:], m.predict_proba(X[cut:])[:, 1])
        final = mk().fit(X, y)                       # adopted model uses every lesson, incl. the newest days
        return final, a, float(y.mean())

    # ── 4. use ──
    def predict(self, feats: dict) -> float | None:
        m = self.state.model
        if m is None:
            return None
        try:
            return float(m.predict_proba(np.array([vector(feats)], dtype=float))[0, 1])
        except Exception:  # noqa: BLE001
            return None

    def gate(self, plan, feats: dict) -> str | None:
        p = self.predict(feats)
        if p is None:
            return None
        plan.meta["brain_p"] = round(p, 3)
        if p < self.s.brain_min_prob:
            self.today["skipped"] += 1
            return f"trade brain: win chance {p:.0%} < {self.s.brain_min_prob:.0%}"
        base = self.state.meta.get("base_rate") or 0.4
        w = max(0.5, min(1.5, p / base))
        if plan.qty > 1 and abs(w - 1) > 0.05:
            plan.qty = max(1, int(plan.qty * w))
            plan.meta["brain_weight"] = round(w, 2)
        return None

    def snapshot(self) -> dict:
        return {"model": "active" if self.state.model is not None else "learning", "meta": self.state.meta, "today": self.today,
                "watching": len(self.open), "min_prob": self.s.brain_min_prob, "log": self.last_log[:3]}
