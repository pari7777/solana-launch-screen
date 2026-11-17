"""Big-player flow & manipulation guard — what large buyers/sellers are doing, from data that is public or in our own feed.

Intraday, from every tick of each stock (Angel One SnapQuote):
  * book pressure: total pending buy vs sell quantity on the exchange (−1 = sellers dominate … +1 = buyers dominate),
    smoothed so one order cannot swing it;
  * big prints: a single tick whose traded value is ≥ ₹10 lakh and ≥ 8× the stock's normal tick — a large player
    hitting the market; counted on the buy side if it traded at/above the ask, sell side at/below the bid.
Daily, before the open (best effort; skipped if NSE does not answer):
  * yesterday's NSE bulk and block deals: institutions or large clients buying or selling the stock.
Manipulation guard (the bot stays OUT, it never tries to ride these):
  * within 1.5 % of the upper/lower circuit limit;
  * hype pump: strongly positive news + a big jump on heavy volume while big players are SELLING into it (no long);
  * spoofing: a wall of buy (sell) orders appears in the book and vanishes within ~30 s with little traded — fake demand
    (supply); for 10 minutes the bot ignores book pressure for that stock and will not trade in the faked direction;
  * pump then dump: a vertical run (+4 % within 15 min) is not chased, and a stock that ran +4 % within 30 min and has
    already dropped 2 % from that top is not bought (the dump has started) — mirror rules for shorts;
  * a small-cap spike: up/down > 8 % on the day on > 5× normal volume with no news to explain it (classic pump/dump);
  * the stock is on the NSE surveillance list (ASM/GSM), if that list could be read.
The result is a score per stock and a reason; the engine blocks entries against strong big-player pressure and passes the
summary to Claude's review. Nothing here places or sizes a trade.
"""
from __future__ import annotations

import csv
import io
import logging
import time
from dataclasses import dataclass, field

import httpx

log = logging.getLogger("aq.flow")
UA = {"User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/124 Safari/537.36", "Accept": "text/csv,*/*",
      "Referer": "https://www.nseindia.com/"}
DEALS = {"bulk": "https://nsearchives.nseindia.com/content/equities/bulk.csv",
         "block": "https://nsearchives.nseindia.com/content/equities/block.csv"}
ASM = ("https://nsearchives.nseindia.com/content/cm/ASM_Short_Term.csv", "https://nsearchives.nseindia.com/content/cm/ASM_Long_Term.csv",
       "https://nsearchives.nseindia.com/content/cm/GSM.csv")


@dataclass
class Flow:
    pressure: float = 0.0          # smoothed book imbalance −1…+1
    big_buy: int = 0
    big_sell: int = 0
    tick_vals: list[float] = field(default_factory=list)
    last_cum_vol: int = -1
    near_circuit: str = ""
    at: float = 0.0
    book: list = field(default_factory=list)        # (time, total_buy_qty, total_sell_qty, cum_volume), last ~2 min
    px: list = field(default_factory=list)          # (time, ltp), last 30 min
    spoof_buy_at: float = 0.0
    spoof_sell_at: float = 0.0
    spoofs: int = 0


def imbalance(buy: float, sell: float) -> float:
    tot = (buy or 0) + (sell or 0)
    return 0.0 if tot <= 0 else round((buy - sell) / tot, 3)


def parse_deals(text: str) -> dict[str, list[dict]]:
    out: dict[str, list[dict]] = {}
    for r in csv.DictReader(io.StringIO(text)):
        r = {k.strip(): (v or "").strip() for k, v in r.items() if k}
        sym = (r.get("Symbol") or "").upper()
        if not sym:
            continue
        side = (r.get("Buy/Sell") or "").upper()
        try:
            qty = float((r.get("Quantity Traded") or "0").replace(",", ""))
            px = float((r.get("Trade Price / Wght. Avg. Price") or r.get("Trade Price/Wght. Avg. Price") or "0").replace(",", ""))
        except ValueError:
            qty, px = 0.0, 0.0
        out.setdefault(sym, []).append({"client": (r.get("Client Name") or "")[:60], "side": side, "qty": qty, "value_cr": round(qty * px / 1e7, 2)})
    return out


def parse_symbols(text: str) -> set[str]:
    syms = set()
    for r in csv.DictReader(io.StringIO(text)):
        for k, v in r.items():
            if k and k.strip().lower() in ("symbol", "nse symbol") and v:
                syms.add(v.strip().upper())
    return syms


class FlowBrain:
    def __init__(self, engine):
        self.e = engine
        self.by: dict[str, Flow] = {}
        self.deals: dict[str, list[dict]] = {}
        self.surveillance: set[str] = set()
        self.daily_day = None
        self.daily_note = ""

    # ── intraday, called for every stock tick ──
    def on_tick(self, sym: str, t) -> None:
        f = self.by.setdefault(sym, Flow())
        if t.total_buy_qty or t.total_sell_qty:
            f.pressure = round(0.9 * f.pressure + 0.1 * imbalance(t.total_buy_qty, t.total_sell_qty), 3)
        if t.volume:
            dv = 0 if f.last_cum_vol < 0 else max(0, t.volume - f.last_cum_vol)
            f.last_cum_vol = t.volume
            val = dv * t.ltp
            if val > 0:
                hist = f.tick_vals
                normal = sorted(hist)[len(hist) // 2] if len(hist) >= 30 else None
                if normal and val >= self.e.s.flow_big_print_rupees and val >= 8 * normal:
                    if t.ask and t.ltp >= t.ask:
                        f.big_buy += 1
                    elif t.bid and t.ltp <= t.bid:
                        f.big_sell += 1
                hist.append(val)
                del hist[:-300]
        now = time.time()
        if t.ltp:
            if not f.px or now - f.px[-1][0] >= 5:
                f.px.append((now, t.ltp))
                while f.px and now - f.px[0][0] > 1800:
                    f.px.pop(0)
        if t.total_buy_qty or t.total_sell_qty:
            f.book.append((now, float(t.total_buy_qty or 0), float(t.total_sell_qty or 0), float(t.volume or 0)))
            while f.book and now - f.book[0][0] > 120:
                f.book.pop(0)
            self._spoof_check(f, now)
        f.near_circuit = ""
        if t.upper_circuit and t.ltp >= t.upper_circuit * 0.985:
            f.near_circuit = "upper"
        elif t.lower_circuit and t.ltp <= t.lower_circuit * 1.015:
            f.near_circuit = "lower"
        f.at = time.time()

    @staticmethod
    def _spoof_check(f: Flow, now: float) -> None:
        """A side's resting quantity spikes ≥ 1.6× its normal level and is withdrawn within 30 s, while far less than
        the spike actually traded → fake orders on that side."""
        b = f.book
        if len(b) < 20:
            return
        base = [x for x in b if now - x[0] > 30]
        recent = [x for x in b if now - x[0] <= 30]
        if len(base) < 8 or len(recent) < 4:
            return
        for side, idx in (("buy", 1), ("sell", 2)):
            normal = sorted(x[idx] for x in base)[len(base) // 2]
            if normal <= 0:
                continue
            peak = max(recent, key=lambda x: x[idx])
            cur = recent[-1]
            wall = peak[idx] - normal
            traded = cur[3] - peak[3]
            if peak[idx] >= 1.6 * normal and cur[idx] <= 1.15 * normal and cur[0] > peak[0] and traded < 0.2 * wall:
                if side == "buy" and now - f.spoof_buy_at > 60:
                    f.spoof_buy_at, f.spoofs = now, f.spoofs + 1
                elif side == "sell" and now - f.spoof_sell_at > 60:
                    f.spoof_sell_at, f.spoofs = now, f.spoofs + 1

    @staticmethod
    def _spoofed(f: Flow | None) -> bool:
        return bool(f) and time.time() - max(f.spoof_buy_at, f.spoof_sell_at) < 600

    @staticmethod
    def run_and_drop(f: Flow | None) -> tuple[float | None, float | None, float | None]:
        """(move % over the last 15 min, rise % from the 30-min low to the 30-min high, drop % from that high)."""
        if not f or len(f.px) < 10:
            return None, None, None
        now, last = f.px[-1]
        p15 = next((p for t_, p in f.px if now - t_ <= 900), None)
        lo = min(p for _, p in f.px); hi = max(p for _, p in f.px)
        i_lo = next(i for i, (_, p) in enumerate(f.px) if p == lo); i_hi = max(i for i, (_, p) in enumerate(f.px) if p == hi)
        mv15 = (last / p15 - 1) * 100 if p15 else None
        if lo <= 0 or hi <= 0:
            return mv15, None, None
        swing = (hi / lo - 1) * 100 if i_lo < i_hi else (lo / hi - 1) * 100   # + run-up, − sell-off (in time order)
        return mv15, swing, (last / hi - 1) * 100

    def score(self, sym: str) -> float:
        f = self.by.get(sym)
        if not f:
            return 0.0
        prints = (f.big_buy - f.big_sell) / max(f.big_buy + f.big_sell, 1) if (f.big_buy + f.big_sell) >= 2 else 0.0
        deals = 0.0
        for d in self.deals.get(sym, []):
            deals += 0.3 if d["side"].startswith("B") else -0.3 if d["side"].startswith("S") else 0
        book = 0.0 if self._spoofed(f) else f.pressure        # a faked order book is not evidence
        return round(max(-1.0, min(1.0, 0.6 * book + 0.4 * prints + max(-0.3, min(0.3, deals)))), 2)

    def gate(self, sym: str, side: str, session_move_pct: float | None = None, vol_ratio: float | None = None,
             news_score: float | None = None, smallcap: bool = True) -> str | None:
        """Reason to stay out (manipulation guard, or big players clearly on the other side), or None."""
        f = self.by.get(sym)
        if sym in self.surveillance:
            return f"guard: {sym} is on the NSE surveillance list (ASM/GSM)"
        if f and f.near_circuit:
            return f"guard: {sym} is near its {f.near_circuit} circuit limit"
        if smallcap and session_move_pct is not None and vol_ratio is not None and abs(session_move_pct) > 8 and vol_ratio > 5 \
                and (news_score is None or abs(news_score) < 0.3):
            return f"guard: {sym} moved {session_move_pct:+.1f}% on {vol_ratio:.0f}× volume with no news (possible pump/dump)"
        # hype pump: good news + a jump on heavy volume, but big players are selling into the buyers it attracts
        if f and side == "LONG" and news_score is not None and news_score >= 0.5 and session_move_pct is not None \
                and session_move_pct >= 5 and (vol_ratio or 0) >= 3 and f.big_sell > f.big_buy:
            return (f"guard: {sym} hype pump — news {news_score:+.1f}, up {session_move_pct:.1f}% on {vol_ratio:.0f}× volume, "
                    f"big sellers {f.big_sell} vs buyers {f.big_buy}")
        if f and side == "SHORT" and news_score is not None and news_score <= -0.5 and session_move_pct is not None \
                and session_move_pct <= -5 and (vol_ratio or 0) >= 3 and f.big_buy > f.big_sell:
            return f"guard: {sym} panic dump being absorbed by big buyers — no short"
        # spoofing: fake order walls in the direction we would trade
        now = time.time()
        if f and side == "LONG" and now - f.spoof_buy_at < 600:
            return f"guard: fake buy orders seen in {sym}'s order book in the last 10 min (spoofing)"
        if f and side == "SHORT" and now - f.spoof_sell_at < 600:
            return f"guard: fake sell orders seen in {sym}'s order book in the last 10 min (spoofing)"
        # pump then dump
        mv15, swing, from_hi = self.run_and_drop(f)
        if side == "LONG":
            if mv15 is not None and mv15 >= 4:
                return f"guard: {sym} ran {mv15:+.1f}% in 15 min — not chasing a vertical move"
            if swing is not None and swing >= 4 and from_hi is not None and from_hi <= -2:
                return f"guard: {sym} pumped {swing:.1f}% then fell {from_hi:.1f}% from the top — dump under way"
        if side == "SHORT":
            if mv15 is not None and mv15 <= -4:
                return f"guard: {sym} fell {mv15:.1f}% in 15 min — not chasing a vertical drop"
            if swing is not None and swing <= -4 and f and f.px and min(p for _, p in f.px) > 0 \
                    and (f.px[-1][1] / min(p for _, p in f.px) - 1) * 100 >= 2:
                return f"guard: {sym} dumped then bounced 2%+ from the low — no short"
        sc = self.score(sym)
        lim = self.e.s.flow_block_score
        if side == "LONG" and sc <= -lim:
            return f"big players selling {sym} (flow {sc:+.2f})"
        if side == "SHORT" and sc >= lim:
            return f"big players buying {sym} (flow {sc:+.2f})"
        return None

    def summary(self, sym: str) -> dict:
        f = self.by.get(sym) or Flow()
        return {"flow_score": self.score(sym), "book_pressure": f.pressure, "big_buy_prints": f.big_buy, "big_sell_prints": f.big_sell,
                "near_circuit": f.near_circuit or None, "bulk_block_deals": self.deals.get(sym, [])[:3],
                "surveillance": sym in self.surveillance, "spoofing_10min": self._spoofed(self.by.get(sym)),
                "spoof_events": f.spoofs}

    # ── daily, before the open ──
    async def daily(self) -> None:
        notes = []
        async with httpx.AsyncClient(timeout=15, headers=UA, follow_redirects=True) as c:
            deals: dict[str, list[dict]] = {}
            for kind, url in DEALS.items():
                try:
                    r = await c.get(url)
                    if r.status_code == 200 and "Symbol" in r.text[:300]:
                        for k, v in parse_deals(r.text).items():
                            deals.setdefault(k, []).extend({**d, "kind": kind} for d in v)
                    else:
                        notes.append(f"{kind} deals unavailable ({r.status_code})")
                except httpx.HTTPError as ex:
                    notes.append(f"{kind} deals unavailable ({type(ex).__name__})")
            surv: set[str] = set()
            for url in ASM:
                try:
                    r = await c.get(url)
                    if r.status_code == 200:
                        surv |= parse_symbols(r.text)
                except httpx.HTTPError:
                    pass
        self.deals = deals
        if surv:
            self.surveillance = surv
        else:
            notes.append("surveillance list unavailable")
        for f in self.by.values():
            f.big_buy = f.big_sell = 0
        mine = [s for s in self.e.s.stocks if s in deals]
        self.daily_note = (f"big-player check: {len(mine)} of our stocks had bulk/block deals yesterday"
                           + (f" ({', '.join(mine[:8])})" if mine else "")
                           + f" · {len([s for s in self.e.s.stocks if s in self.surveillance])} on surveillance (skipped)"
                           + (f" · {'; '.join(notes)}" if notes else ""))
        self.e.event("flow", self.daily_note)

    def snapshot(self) -> dict:
        return {"note": self.daily_note,
                "stocks": {s: {"score": self.score(s), "pressure": f.pressure, "big_buy": f.big_buy, "big_sell": f.big_sell,
                               "circuit": f.near_circuit or None, "deals": len(self.deals.get(s, [])), "watch": s in self.surveillance}
                           for s, f in self.by.items() if time.time() - f.at < 900}}
