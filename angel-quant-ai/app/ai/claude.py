"""Claude as a decision-SUPPORT layer.

Claude sees a compact, factual summary of a trade that has ALREADY passed the rule engine, the cost check and the
risk manager, and may only APPROVE or VETO it (with a reason). It cannot create trades, change size, move stops or
override risk limits. If Claude is unavailable, slow, or over its hourly budget, the rule-based decision stands
(CLAUDE_REQUIRED=true makes that a skip instead).
Claude also writes a short market note for the dashboard every 15 minutes.
"""
from __future__ import annotations

import asyncio
import json
import logging
import time

log = logging.getLogger("claude")

SYSTEM = (
    "You are the risk-review layer of an Indian intraday trading system (NSE, Angel One). You receive one trade that "
    "has already passed rule-based signals, an all-in cost check (brokerage, STT, exchange fees, GST, stamp duty, "
    "slippage) and portfolio risk limits. Your only job is to VETO trades that look poor given the context, or APPROVE "
    "them. Look for: signal contradicting the market regime or breadth, entering into an obvious level, expiry-day "
    "gamma/theta risk on option buys, costs eating most of the reward, stretched moves likely to mean-revert, too little "
    "time left in the session. Be conservative but not obstructive. Reply with JSON only: "
    '{"verdict":"APPROVE"|"VETO","confidence":0.0-1.0,"reason":"<one short sentence>"}'
)


class ClaudeReviewer:
    def __init__(self, s):
        self.s = s
        self.enabled = bool(s.anthropic_api_key.get_secret_value()) and s.claude_review_trades
        self.client = None
        if self.enabled:
            import anthropic
            self.client = anthropic.AsyncAnthropic(api_key=s.anthropic_api_key.get_secret_value())
        self.calls: list[float] = []
        self.stats = {"approve": 0, "veto": 0, "error": 0, "skipped_budget": 0}
        self.last_note = {"text": "", "at": 0.0}
        self.recent: list[dict] = []

    def _budget_ok(self) -> bool:
        now = time.time()
        self.calls = [t for t in self.calls if t > now - 3600]
        return len(self.calls) < self.s.claude_max_calls_per_hour

    async def _ask(self, system: str, user: str, max_tokens: int = 200) -> str:
        self.calls.append(time.time())
        r = await asyncio.wait_for(self.client.messages.create(model=self.s.claude_model, max_tokens=max_tokens, system=system,
                                                               messages=[{"role": "user", "content": user}]),
                                   timeout=self.s.claude_timeout_s)
        return "".join(getattr(b, "text", "") for b in r.content).strip()

    async def review(self, plan_summary: dict, context: dict) -> dict:
        """Returns {"verdict", "confidence", "reason", "source"}."""
        if not self.enabled:
            return {"verdict": "APPROVE", "confidence": None, "reason": "Claude review off", "source": "rules"}
        if not self._budget_ok():
            self.stats["skipped_budget"] += 1
            return {"verdict": "APPROVE", "confidence": None, "reason": "Claude hourly budget used", "source": "rules"}
        try:
            txt = await self._ask(SYSTEM, json.dumps({"trade": plan_summary, "context": context}, default=str))
            j = json.loads(txt[txt.find("{"): txt.rfind("}") + 1])
            v = "VETO" if str(j.get("verdict", "")).upper() == "VETO" else "APPROVE"
            out = {"verdict": v, "confidence": float(j.get("confidence") or 0), "reason": str(j.get("reason", ""))[:200], "source": "claude"}
        except Exception as e:
            self.stats["error"] += 1
            log.warning("Claude review failed: %s", e)
            v = "VETO" if self.s.claude_required else "APPROVE"
            return {"verdict": v, "confidence": None, "reason": f"Claude unavailable ({type(e).__name__})", "source": "rules"}
        self.stats["approve" if out["verdict"] == "APPROVE" else "veto"] += 1
        self.recent.insert(0, {"symbol": plan_summary.get("symbol"), "strategy": plan_summary.get("strategy"), **out, "at": time.time()})
        del self.recent[30:]
        return out

    async def market_note(self, context: dict) -> None:
        if not self.enabled or time.time() - self.last_note["at"] < 900 or not self._budget_ok():
            return
        try:
            txt = await self._ask("You are a concise Indian equity-market analyst. In at most 3 short sentences, describe the current "
                                  "intraday regime from the data and what kind of setups it favours or argues against. No predictions "
                                  "of price levels, no advice to the reader.", json.dumps(context, default=str), max_tokens=160)
            self.last_note = {"text": txt[:600], "at": time.time()}
        except Exception as e:
            log.warning("Claude note failed: %s", e)
            self.last_note["at"] = time.time()
