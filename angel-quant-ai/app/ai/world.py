"""World Market Brain on the bot server — data for the dashboard's Deep Dive tab.

Every WORLD_EVERY_MIN minutes (default 60, all day, every day) it:
  1. reads daily prices for 32 world markets from Yahoo Finance (indices, FX, US 10Y, VIX, metals, energy, crypto),
     plus India VIX, and the crypto Fear & Greed index (alternative.me);
  2. reads world headlines from Google News RSS (US, AI, Fed, India, FII, Europe, Asia, oil, gold, dollar, crypto,
     geopolitics), scores them with Claude when a key is set, else the bot's FinBERT, else the word list, and turns each
     into pushes on market themes;
  3. runs world_model.step(): grades the forecast made ~24 h earlier against real prices, re-weights the signals, and
     makes a fresh 24 h forecast;
  4. saves everything in the bot's kv store, so learning survives restarts.
Display only: nothing here places, sizes or blocks a trade.
"""
from __future__ import annotations

import asyncio
import json
import logging
import time
from datetime import datetime, timezone

import httpx

from app.ai import world_model as W
from app.ai.news import UA, lexicon_score, parse_rss
from app.ai.nlp import FINBERT
from app.market import yahoo

log = logging.getLogger("aq.world")
KV = "world_brain"
FNG = "https://api.alternative.me/fng/?limit=1"
RSS = "https://news.google.com/rss/search?q={q}+when:1d&hl=en-US&gl=US&ceid=US:en"

# query → how a positive headline pushes each theme (negative headline pushes the other way)
QUERIES = [
    ("Wall Street stocks today", {"us": 1, "global": 0.4, "smallcap": 0.6}, "us"),
    ("Nvidia AI chip stocks", {"ai": 1, "tech": 1, "korea": 0.3, "japan": 0.2}, "us"),
    ("Federal Reserve interest rates inflation", {"us": 0.6, "global": 0.4, "gold": 0.4, "rates": -0.4}, "us"),
    ("Sensex Nifty market today", {"india": 1, "banks": 0.5}, "india"),
    ("FII DII flows India equities", {"india": 1, "inr": -0.4}, "india"),
    ("European stocks DAX FTSE", {"europe": 1, "uk": 0.6}, "europe"),
    ("Asian markets Nikkei Hang Seng Kospi", {"asia": 1, "japan": 0.6, "china": 0.6, "korea": 0.5, "australia": 0.3}, "asia"),
    ("crude oil prices", {"oil": 1, "energy": 1, "india": -0.3, "inr": 0.2}, None),
    ("gold prices", {"gold": 1, "silver": 0.6, "safe": 0.6}, None),
    ("dollar index currency markets", {"usd": 1, "eur": -0.6, "inr": 0.3}, None),
    ("bitcoin crypto market", {"crypto": 1, "btc": 1, "alt": 0.8, "eth": 0.8}, "crypto"),
    ("geopolitics war sanctions markets", {"global": 0.6, "geopolitics": 0.6, "gold": -0.4, "oil": -0.3, "fear": -0.5}, None),
]
PER_QUERY = 4


def _iso_hour(ts: float | None = None) -> str:
    d = datetime.fromtimestamp(ts or time.time(), timezone.utc).replace(minute=0, second=0, microsecond=0)
    return d.strftime("%Y-%m-%dT%H:%M:%SZ")


def prices_from_daily(rows_by_id: dict[str, list[list]]) -> tuple[dict, dict]:
    """{id: yahoo daily rows} -> (prices {id: {last, chg}}, history {id: [closes…]}). US10Y change is in bp/10."""
    prices, hist = {}, {}
    for i, rows in rows_by_id.items():
        closes = [r[4] for r in rows if r and r[4] is not None]
        if not closes:
            continue
        lastv = closes[-1]
        prev = closes[-2] if len(closes) > 1 else None
        if i == "US10Y":
            c = round((lastv - prev) * 10, 3) if prev is not None else None        # 1 bp = 0.01 → bp/10
        else:
            c = round((lastv / prev - 1) * 100, 3) if prev else None
        prices[i] = {"last": round(lastv, 4), "chg": c, "chg5": round((lastv / closes[-6] - 1) * 100, 2) if len(closes) >= 6 and i != "US10Y" else None}
        hist[i] = [round(x, 4) for x in closes[-22:]]
    return prices, hist


def effects_for(score: float, coefs: dict) -> dict:
    return {k: round(score * v, 3) for k, v in coefs.items() if abs(score * v) >= 0.02}


class WorldBrain:
    def __init__(self, engine):
        self.e = engine
        self.state: dict = {"model": None, "pending": [], "scores": [], "snap": None, "pred": None, "hist": {}, "log": []}
        self.last_run = 0.0
        self.running = False
        self.error = ""

    async def load(self) -> None:
        try:
            st = await self.e.store.kv_get(KV)
            if isinstance(st, dict):
                self.state.update(st)
        except Exception as ex:  # noqa: BLE001
            log.warning("world load: %s", ex)

    def save(self) -> None:
        try:
            self.e.store.kv_put(KV, self.state)
        except Exception as ex:  # noqa: BLE001
            log.warning("world save: %s", ex)

    # ── collection ──
    async def _prices(self) -> tuple[dict, dict]:
        items = [(a["id"], a["yahoo"]) for a in W.U] + list(W.EXTRA.items())
        rows = await yahoo.chart_many(items, {"interval": "1d", "range": "1mo"}, parallel=6)
        return prices_from_daily(rows)

    async def _fng(self, c: httpx.AsyncClient) -> tuple[int | None, str]:
        try:
            r = await c.get(FNG)
            d = r.json()["data"][0]
            return int(d["value"]), str(d.get("value_classification", ""))[:30]
        except Exception as ex:  # noqa: BLE001
            log.info("fear&greed: %s", ex)
            return None, ""

    async def _headlines(self, c: httpx.AsyncClient) -> list[tuple[int, dict]]:
        out = []
        for qi, (q, _, _) in enumerate(QUERIES):
            try:
                r = await c.get(RSS.format(q=q.replace(" ", "+")))
                hs = parse_rss(r.text, limit=PER_QUERY) if r.status_code == 200 else []
            except httpx.HTTPError as ex:
                log.info("world news %s: %s", q, ex)
                hs = []
            out += [(qi, h) for h in hs]
            await asyncio.sleep(0.3)
        return out

    async def _score(self, titles: list[str]) -> tuple[list[tuple[float, float]], str]:
        """[(score −1..1, confidence 0..1)] per title, and which reader scored them."""
        cl = self.e.claude
        if titles and cl.enabled and cl._budget_ok():
            try:
                txt = await cl._ask("You score world market headlines for a market dashboard. For each numbered headline give "
                                    "score -1..1 = how positive it is for the asset or market it is about (e.g. 'oil jumps' = +0.7 for oil, "
                                    "'stocks slump' = -0.7), and impact 1-3. JSON only: [[score, impact], ...] in the same order.",
                                    "\n".join(f"{i}. {t}" for i, t in enumerate(titles)), max_tokens=900, timeout=40)
                arr = json.loads(txt[txt.find("["): txt.rfind("]") + 1])
                if isinstance(arr, list) and len(arr) == len(titles):
                    return [(W.clip(float(x[0]), -1, 1), min(1.0, max(1, int(x[1])) / 3)) for x in arr], "Claude"
            except Exception as ex:  # noqa: BLE001
                log.info("world Claude scoring: %s", ex)
        res = await FINBERT.score_titles(titles)
        if res:
            return res, "FinBERT"
        return [(lexicon_score([t])[0], 0.5) for t in titles], "word list"

    async def scan(self) -> dict:
        async with httpx.AsyncClient(timeout=15, headers=UA, follow_redirects=True) as c:
            (prices, hist), (fg, fgl), heads = await asyncio.gather(self._prices(), self._fng(c), self._headlines(c))
        seen, uniq = set(), []
        for qi, h in heads:
            k = h["title"].lower()[:80]
            if k not in seen:
                seen.add(k)
                uniq.append((qi, h))
        scored, reader = await self._score([h["title"] for _, h in uniq])
        news, region = [], {}
        for (qi, h), (sc, conf) in zip(uniq, scored):
            _, coefs, reg = QUERIES[qi]
            impact = 3 if conf >= 0.9 and abs(sc) >= 0.6 else 2 if conf >= 0.6 else 1
            news.append({"h": h["title"][:160], "src": h.get("source", "")[:40], "impact": impact, "score": round(sc, 2),
                         "effects": effects_for(sc, coefs), "topic": QUERIES[qi][0]})
            if reg:
                region.setdefault(reg, []).append(sc * conf)
        news.sort(key=lambda n: -abs(n["score"]) * n["impact"])
        sent = {k: round(W.clip(sum(v) / max(len(v), 1) * 1.5, -1, 1), 2) for k, v in region.items()}
        snap = {"at": _iso_hour(), "prices": prices, "sentiment": {**{k: sent.get(k, 0) for k in ("us", "india", "europe", "asia", "crypto")},
                                                                    "fg": fg, "fgLabel": fgl},
                "flows": {}, "news": news[:24], "reader": reader,
                "notes": f"{len(prices)} prices from Yahoo Finance (daily closes, latest bar may be live), {len(news)} headlines scored by {reader}."}
        return {"snap": snap, "hist": hist}

    async def run_once(self) -> None:
        if self.running:
            return
        self.running = True
        try:
            got = await self.scan()
            snap = got["snap"]
            n = sum(1 for a in W.U if W.last(snap, a["id"]) is not None)
            st = self.state
            if n < 8:
                self.error = f"only {n} prices reachable — forecast skipped this hour"
                st["snap"], st["hist"] = snap, got["hist"] or st.get("hist", {})
                return
            res = W.step(snap, st.get("model"), st.get("pending") or [])
            done = set(res["scoredAts"])
            pend = [p for p in (st.get("pending") or []) if p["at"] not in done and p["at"] != snap["at"]] + [res["prediction"]]
            st.update(model=res["model"], pending=pend[-40:], snap=snap, pred=res["prediction"], hist=got["hist"],
                      scores=(res["scores"] + (st.get("scores") or []))[:60])
            graded = sum(s["n"] for s in res["scores"])
            msg = f"world scan: {n} markets, {len(snap['news'])} headlines ({snap.get('reader', '—')}), mood {res['prediction']['mood']:+.2f}" + \
                  (f", graded {graded} calls ({sum(s['hits'] for s in res['scores'])} right)" if graded else "")
            st["log"] = ([{"at": snap["at"], "msg": msg}] + (st.get("log") or []))[:24]
            self.error = ""
            self.e.event("world", msg)
            self.save()
        except Exception as ex:  # noqa: BLE001
            self.error = f"{type(ex).__name__}: {str(ex)[:140]}"
            log.warning("world scan: %s", ex)
        finally:
            self.running = False
            self.last_run = time.time()

    async def loop(self) -> None:
        await self.load()
        await asyncio.sleep(20)                       # let the bot finish starting up first
        while True:
            last_at = (self.state.get("snap") or {}).get("at")
            if self.e.s.world_every_min >= 60:
                due = last_at != _iso_hour()          # once per clock hour
            else:
                due = time.time() - self.last_run >= self.e.s.world_every_min * 60
            if due and time.time() - self.last_run >= 300:
                await self.run_once()
            await asyncio.sleep(60)

    async def ask(self, q: str) -> str:
        cl = self.e.claude
        if not cl.enabled:
            return "Claude is off on this bot. Add ANTHROPIC_API_KEY to let it reason over the Deep Dive data."
        if not cl._budget_ok():
            return "Claude's hourly budget for this bot is used up. Try again later."
        st = self.state
        pred = st.get("pred") or {}
        data = {"scan": st.get("snap"), "odds": {k: {"name": W.BY_ID[k]["name"], "pUp": v["p"], "expMove": v["exp"], "topDriver": W.FEAT_NAMES[v["top"]]}
                                                 for k, v in (pred.get("items") or {}).items()},
                "riskMood": pred.get("mood"), "trackRecord": (st.get("model") or {}).get("totals")}
        sys = ("You are the reasoning layer of a world-market dashboard attached to an Indian intraday paper-trading bot. Use ONLY the "
               "JSON given. Reason like a senior macro strategist: intermarket links, sentiment extremes, event risk. Give probabilities, "
               "not certainties, and say where the model may be wrong. Analysis only, not investment advice; never tell the reader to "
               "buy or sell. Plain text, short headings, under 300 words.")
        try:
            return (await cl._ask(sys, f"QUESTION: {q[:600]}\n\nDATA: {json.dumps(data, default=str)[:24000]}", max_tokens=900, timeout=60))[:6000]
        except Exception as ex:  # noqa: BLE001
            return f"Claude could not answer just now ({type(ex).__name__})."

    def snapshot(self) -> dict:
        st = self.state
        m = st.get("model") or W.fresh_model()
        return {"universe": [{k: a[k] for k in ("id", "name", "cls", "group", "themes", "s", "beta")} for a in W.U],
                "feats": W.FEATS, "featNames": W.FEAT_NAMES, "snap": st.get("snap"), "pred": st.get("pred"), "hist": st.get("hist") or {},
                "model": {k: m.get(k) for k in ("weights", "featHits", "totals", "daily", "classStats", "updatedAt")},
                "scores": (st.get("scores") or [])[:3], "log": (st.get("log") or [])[:8], "error": self.error, "running": self.running,
                "every_min": self.e.s.world_every_min, "claude": self.e.claude.enabled}
