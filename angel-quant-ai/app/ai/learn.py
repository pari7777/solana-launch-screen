"""Daily learning loop (paper first): after each session the bot reviews every strategy and adjusts — slowly and within
fixed limits — how much it trades each one. Nothing here can raise the overall risk limits or switch on live trading.

At 15:45 IST on trading days, over the last LEARN_LOOKBACK_DAYS of closed trades:
  * size weight per strategy, 0.5× … 1.5×: up 0.1 when it is profitable after charges with profit factor ≥ 1.3, down 0.1
    when it is losing, unchanged with fewer than LEARN_MIN_TRADES trades (too little evidence);
  * pause a strategy for LEARN_PAUSE_DAYS trading days when it has ≥ LEARN_MIN_TRADES trades and profit factor < 0.8;
    it comes back afterwards to be tested again (a fresh chance, not a permanent ban);
  * with ANTHROPIC_API_KEY, Claude writes a short "lessons" note from the day's trades, rejections and news.
Every change is written to the event log and kept in the database, so the dashboard shows what it learned and why.
"""
from __future__ import annotations

import asyncio
import json
import logging
import math
from datetime import datetime, timedelta, timezone

from app.clock import now_ist

log = logging.getLogger("aq.learn")
KEY = "learn_state"


def pf(nets: list[float]) -> float | None:
    w = sum(x for x in nets if x > 0)
    l_ = -sum(x for x in nets if x <= 0)
    return w / l_ if l_ > 0 else (math.inf if w > 0 else None)


def decide(prev: dict, by_strat: dict[str, list[float]], s) -> tuple[dict, list[str]]:
    """Pure function: new state + human-readable changes."""
    st = {"weights": dict(prev.get("weights") or {}), "paused": dict(prev.get("paused") or {}), "notes": prev.get("notes", [])}
    changes = []
    for name, nets in by_strat.items():
        w = float(st["weights"].get(name, 1.0))
        n, net, f = len(nets), sum(nets), pf(nets)
        if n < s.learn_min_trades:
            continue
        if f is not None and f < 0.8 and name not in st["paused"]:
            st["paused"][name] = s.learn_pause_days
            changes.append(f"{name}: paused {s.learn_pause_days} days (profit factor {f:.2f} over {n} trades, net ₹{net:,.0f})")
            continue
        nw = w
        if net > 0 and f is not None and f >= 1.3:
            nw = min(1.5, round(w + 0.1, 2))
        elif net < 0:
            nw = max(0.5, round(w - 0.1, 2))
        if nw != w:
            st["weights"][name] = nw
            changes.append(f"{name}: size {w:.1f}× → {nw:.1f}× (net ₹{net:,.0f}, PF {f if f is None else round(f, 2)}, {n} trades)")
    return st, changes


def tick_pauses(st: dict) -> list[str]:
    back = []
    for k in list(st.get("paused", {})):
        st["paused"][k] -= 1
        if st["paused"][k] <= 0:
            del st["paused"][k]
            back.append(f"{k}: pause over — back in testing")
    return back


class Learner:
    def __init__(self, engine):
        self.e = engine
        self.state = {"weights": {}, "paused": {}, "notes": [], "last_day": None, "log": []}

    def weight(self, strategy: str) -> float:
        return float(self.state["weights"].get(strategy, 1.0))

    def paused(self, strategy: str) -> bool:
        return strategy in self.state.get("paused", {})

    async def load(self):
        try:
            v = await self.e.store.kv_get(KEY)
            if isinstance(v, str):
                v = json.loads(v)
            if isinstance(v, dict):
                self.state.update(v)
        except Exception as ex:  # noqa: BLE001
            log.warning("learn load: %s", ex)

    async def run_once(self) -> list[str]:
        s = self.e.s
        since = datetime.now(timezone.utc) - timedelta(days=s.learn_lookback_days * 7 // 5 + 2)
        rows = await self.e.store.closed(since=since, limit=5000, mode=self.e.mode)
        by: dict[str, list[float]] = {}
        for r in rows:
            by.setdefault(r.get("strategy") or "?", []).append((r.get("gross") or 0) - (r.get("charges") or 0))
        changes = tick_pauses(self.state)
        st, ch = decide(self.state, by, s)
        self.state.update(st)
        changes += ch
        note = await self._lessons(by, changes)
        day = now_ist().date().isoformat()
        self.state["last_day"] = day
        self.state["log"] = ([{"day": day, "changes": changes or ["no change — not enough evidence yet"], "note": note}]
                             + self.state.get("log", []))[:40]
        self.e.store.kv_put(KEY, self.state)
        for c in changes or ["learning: no change today (not enough evidence yet)"]:
            self.e.event("learn", c)
        return changes

    async def _lessons(self, by: dict[str, list[float]], changes: list[str]) -> str:
        cl = self.e.claude
        if not cl.enabled or not cl._budget_ok():
            return ""
        data = {"per_strategy": {k: {"trades": len(v), "net": round(sum(v), 2), "pf": (round(pf(v), 2) if pf(v) not in (None, math.inf) else pf(v))}
                                 for k, v in by.items()},
                "top_rejections": dict(list(self.e.risk.snapshot(self.e.equity()).get("rejects", {}).items())[:10]),
                "news": {k: v.get("score") for k, v in self.e.news.by_stock.items()}, "changes": changes,
                "regime": self.e.regime.as_dict()}
        try:
            return (await cl._ask("You review an Indian intraday paper-trading bot after the close. In at most 4 short bullet lines, say "
                                  "what worked, what did not, and one concrete thing to watch tomorrow. Facts from the data only; no "
                                  "promises of profit.", json.dumps(data, default=str), max_tokens=260))[:900]
        except Exception as ex:  # noqa: BLE001
            log.warning("lessons: %s", ex)
            return ""

    async def loop(self):
        await self.load()
        while True:
            try:
                n = now_ist()
                if n.weekday() < 5 and (n.hour, n.minute) >= (15, 45) and self.state.get("last_day") != n.date().isoformat():
                    await self.run_once()
            except Exception as ex:  # noqa: BLE001
                log.warning("learn loop: %s", ex)
            await asyncio.sleep(60)
