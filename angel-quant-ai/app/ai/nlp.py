"""The bot's own language model for news — runs on the server, no API key, no monthly cost.

* FinBERT (ProsusAI/finbert, a BERT model trained on financial news) reads each headline and gives
  P(positive), P(negative), P(neutral). Headline score = P(positive) − P(negative); a stock's score is the
  confidence-weighted mean of its RELEVANT headlines, −1 … +1.
* Relevance filter: a headline only counts for a stock when it actually names that company (short company name
  from the NSE index file, or the NSE symbol). Google News often returns other companies for a symbol search —
  those headlines are dropped instead of being blamed on the wrong stock.
* If the model cannot load (no RAM, no download), everything falls back to the word list, so the bot keeps running.
"""
from __future__ import annotations

import asyncio
import logging
import os
import re
import threading

log = logging.getLogger("aq.nlp")
MODEL = os.environ.get("NLP_MODEL", "ProsusAI/finbert")

_SUFFIX = re.compile(r"\b(limited|ltd|ltd\.|pvt|private|co|company|corporation|corp|inc|plc|\(india\)|india)\b\.?", re.I)
# first words that are too common to identify a company on their own
_COMMON = {"indian", "india", "national", "state", "bharat", "federal", "tata", "union", "power", "bank", "steel", "oil", "great",
           "general", "city", "central", "new", "global", "life", "the", "bajaj", "adani", "aditya", "hindustan", "jsw", "mahindra",
           "kotak", "godrej", "reliance", "birla", "larsen", "sun", "the", "first", "max", "star", "gold", "trent", "sai", "ge"}


def short_name(company: str) -> str:
    """'Ashok Leyland Ltd.' → 'ashok leyland'; 'Dixon Technologies (India) Ltd.' → 'dixon technologies'."""
    n = _SUFFIX.sub(" ", company or "")
    n = re.sub(r"[^a-z0-9&' ]", " ", n.lower())
    return " ".join(n.split()[:2])


def aliases(symbol: str, company: str = "") -> list[str]:
    out = []
    sym = (symbol or "").replace("-EQ", "").lower()
    sn = short_name(company)
    if sn:
        out.append(sn)
        first = sn.split()[0]
        if len(first) >= 5 and first not in _COMMON:
            out.append(first)
    if len(sym) >= 4 and sym.isalpha():
        out.append(sym)
    return list(dict.fromkeys(out))


def relevant(title: str, names: list[str]) -> bool:
    t = " " + re.sub(r"[^a-z0-9&' ]", " ", title.lower()) + " "
    return any(f" {n} " in t for n in names if n)


class FinBert:
    """Lazy, thread-safe FinBERT. load() runs once in a worker thread; score() is async and never blocks the event loop."""

    def __init__(self):
        self.pipe = None
        self.state = "not loaded"
        self._lock = threading.Lock()

    def _load(self):
        with self._lock:
            if self.pipe is not None or self.state.startswith("failed"):
                return
            try:
                import torch  # noqa: F401
                from transformers import pipeline
                torch.set_num_threads(max(1, (os.cpu_count() or 2) // 2))   # leave CPU for the trading loop
                self.state = "loading"
                self.pipe = pipeline("text-classification", model=MODEL, tokenizer=MODEL, top_k=None, truncation=True, device=-1)
                self.state = f"ready ({MODEL})"
                log.info("FinBERT ready")
            except Exception as ex:  # noqa: BLE001
                self.state = f"failed: {type(ex).__name__}: {str(ex)[:120]}"
                log.warning("FinBERT unavailable, word list will be used: %s", ex)

    async def ensure(self) -> bool:
        if self.pipe is None and not self.state.startswith("failed"):
            await asyncio.to_thread(self._load)
        return self.pipe is not None

    def _score_sync(self, titles: list[str]) -> list[tuple[float, float]]:
        res = self.pipe(titles, batch_size=16)
        out = []
        for r in res:
            p = {d["label"].lower(): float(d["score"]) for d in r}
            pos, neg = p.get("positive", 0.0), p.get("negative", 0.0)
            out.append((pos - neg, max(pos, neg)))          # (score, confidence that it is not neutral)
        return out

    async def score_titles(self, titles: list[str]) -> list[tuple[float, float]] | None:
        if not titles or not await self.ensure():
            return None
        try:
            return await asyncio.to_thread(self._score_sync, titles)
        except Exception as ex:  # noqa: BLE001
            log.warning("FinBERT scoring failed: %s", ex)
            return None


def aggregate(scored: list[tuple[float, float]]) -> float:
    """Confidence-weighted mean; neutral headlines barely move it."""
    w = sum(c for _, c in scored)
    if w <= 0:
        return 0.0
    return round(max(-1.0, min(1.0, sum(s * c for s, c in scored) / w)), 2)


FINBERT = FinBert()
