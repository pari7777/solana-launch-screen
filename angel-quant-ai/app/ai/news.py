"""News & sentiment for the AI brain.

Every 30 minutes during the trading day (08:45–15:15 IST) it collects recent headlines for the market and for each stock on
the day's shortlist from Google News RSS (India edition, last 24 h), and scores each stock from −1 (clearly negative)
to +1 (clearly positive):
  * with ANTHROPIC_API_KEY: Claude reads the headlines and scores them (one batched call), flags results/board-meeting
    days and anything that makes intraday trading unusually risky;
  * without it: a simple word list (upgrade, wins order, profit up … / downgrade, fraud, raid, loss widens …).
Used by the engine to (a) block entries against strongly opposite news, (b) skip stocks with a pending event,
(c) give Claude's trade review the headlines. It never creates a trade by itself.
"""
from __future__ import annotations

import asyncio
import html
import json
import logging
import re
import time
import xml.etree.ElementTree as ET
from urllib.parse import quote_plus

import httpx

from app.clock import market_open, now_ist

log = logging.getLogger("aq.news")
RSS = "https://news.google.com/rss/search?q={q}+when:1d&hl=en-IN&gl=IN&ceid=IN:en"
UA = {"User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/124 Safari/537.36"}
POS = ("upgrade", "jump", "buy rating", "target raised", "wins order", "bags order", "order win", "profit rises", "profit up", "profit jumps",
       "record high", "beats estimate", "strong results", "approval", "acquires", "dividend", "bonus", "buyback", "rally", "surges",
       "jumps", "gains", "expansion", "partnership")
NEG = ("downgrade", "sell rating", "target cut", "fraud", "raid", "probe", "sebi order", "penalty", "default", "loss widens",
       "profit falls", "profit down", "misses estimate", "weak results", "resigns", "pledge", "plunges", "slumps", "crashes",
       "falls", "tumbles", "lawsuit", "ban", "fire at", "shutdown", "strike")
EVENT = ("board meeting", "q1 results", "q2 results", "q3 results", "q4 results", "quarterly results", "results today", "earnings today",
         "record date", "agm")


_RX = {w: re.compile(r"\b" + re.escape(w) + r"\b") for w in POS + NEG}


def lexicon_score(titles: list[str]) -> tuple[float, bool]:
    s, n, ev = 0, 0, False
    for t in titles:
        tl = t.lower()
        p = sum(bool(_RX[w].search(tl)) for w in POS)       # whole words only ("Bank" is not "ban")
        q = sum(bool(_RX[w].search(tl)) for w in NEG)
        if p or q:
            s += (p - q) / max(p + q, 1)
            n += 1
        ev = ev or any(w in tl for w in EVENT)
    return (round(max(-1.0, min(1.0, s / n)), 2) if n else 0.0), ev


def parse_rss(text: str, limit: int = 8) -> list[dict]:
    out = []
    try:
        root = ET.fromstring(text)
    except ET.ParseError:
        return out
    for it in root.iter("item"):
        t = html.unescape((it.findtext("title") or "").strip())
        if t:
            out.append({"title": t[:200], "source": (it.findtext("source") or "").strip()[:60], "at": (it.findtext("pubDate") or "")[:40]})
        if len(out) >= limit:
            break
    return out


class NewsBrain:
    def __init__(self, engine):
        self.e = engine
        self.by_stock: dict[str, dict] = {}       # symbol → {score, event, headlines, why, at, source}
        self.market: dict = {"score": 0.0, "headlines": [], "why": "", "at": 0}
        self.last_run = 0.0

    def get(self, sym: str) -> dict | None:
        d = self.by_stock.get(sym)
        return d if d and time.time() - d["at"] < 3 * 3600 else None

    def gate(self, sym: str, side: str) -> str | None:
        """Reason to skip an entry because of the news, or None."""
        d = self.get(sym)
        if not d:
            return None
        if d.get("event"):
            return f"news: event day for {sym} (results/board meeting) — intraday too risky"
        lim = self.e.s.news_block_score
        why = d.get("why") or (d["headlines"][0]["title"] if d.get("headlines") else "")
        if side == "LONG" and d["score"] <= -lim:
            return f"news against long ({d['score']:+.2f}): {why}"[:180]
        if side == "SHORT" and d["score"] >= lim:
            return f"news against short ({d['score']:+.2f}): {why}"[:180]
        return None

    async def _fetch(self, c: httpx.AsyncClient, q: str) -> list[dict]:
        try:
            r = await c.get(RSS.format(q=quote_plus(q)))
            return parse_rss(r.text) if r.status_code == 200 else []
        except httpx.HTTPError as ex:
            log.warning("news %s: %s", q, ex)
            return []

    async def refresh(self) -> None:
        syms = list(self.e.shortlist())[: self.e.s.shortlist_size or 10]
        async with httpx.AsyncClient(timeout=12, headers=UA, follow_redirects=True) as c:
            market = await self._fetch(c, "Sensex Nifty stock market today")
            got = {}
            for sym in syms:
                ins = self.e.im.equity.get(sym)
                name = (getattr(ins, "name", "") or sym).replace("-EQ", "")
                got[sym] = await self._fetch(c, f"{name} share NSE")
                await asyncio.sleep(0.4)
        scored = await self._claude_score(market, got) if self.e.claude.enabled else None
        now = time.time()
        ms, mev = lexicon_score([h["title"] for h in market])
        self.market = {"score": (scored or {}).get("_market", {}).get("score", ms), "headlines": market[:5],
                       "why": (scored or {}).get("_market", {}).get("why", ""), "at": now}
        for sym, hs in got.items():
            sc, ev = lexicon_score([h["title"] for h in hs])
            src = "words"
            why = ""
            if scored and sym in scored:
                sc, ev, why, src = scored[sym].get("score", sc), bool(scored[sym].get("event", ev)), scored[sym].get("why", ""), "claude"
            self.by_stock[sym] = {"score": round(float(sc), 2), "event": ev, "headlines": hs[:4], "why": str(why)[:160], "at": now, "source": src}
        self.e.event("news", f"news & sentiment for {len(got)} stocks + market ({'Claude' if scored else 'word list'}): "
                     + ", ".join(f"{k} {v['score']:+.1f}" for k, v in list(self.by_stock.items())[:10] if k in got))

    async def _claude_score(self, market: list[dict], got: dict[str, list[dict]]) -> dict | None:
        cl = self.e.claude
        if not cl._budget_ok():
            return None
        data = {"market": [h["title"] for h in market[:6]], "stocks": {k: [h["title"] for h in v[:6]] for k, v in got.items()}}
        sys = ("You score Indian stock news for an intraday trading risk filter. For the market and for each stock, give a "
               "sentiment score from -1 (clearly negative for the price today) to +1 (clearly positive), 0 if mixed/irrelevant/old, "
               "event=true if results, a board meeting or a record date is today or tomorrow, and a reason of at most 12 words. "
               "Ignore generic market-wrap noise. JSON only: "
               '{"_market":{"score":0,"why":""},"SYMBOL":{"score":0,"event":false,"why":""}}')
        try:
            txt = await cl._ask(sys, json.dumps(data), max_tokens=900)
            j = json.loads(txt[txt.find("{"): txt.rfind("}") + 1])
            return j if isinstance(j, dict) else None
        except Exception as ex:  # noqa: BLE001
            log.warning("Claude news scoring failed: %s", ex)
            return None

    async def run(self) -> None:
        while True:
            try:
                n = now_ist()
                inday = n.weekday() < 5 and (8, 45) <= (n.hour, n.minute) <= (15, 15)
                if inday and time.time() - self.last_run >= self.e.s.news_every_min * 60:
                    self.last_run = time.time()
                    await self.refresh()
            except Exception as ex:  # noqa: BLE001
                log.warning("news loop: %s", ex)
            await asyncio.sleep(30)

    def snapshot(self) -> dict:
        return {"market": self.market, "stocks": {k: v for k, v in self.by_stock.items() if time.time() - v["at"] < 6 * 3600},
                "every_min": self.e.s.news_every_min, "block_score": self.e.s.news_block_score, "_open": market_open()}
