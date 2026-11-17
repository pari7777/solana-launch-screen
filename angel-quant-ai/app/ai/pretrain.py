"""Pre-training: give the trade brain years of memory on day one.

Replays past 1-minute prices for every universe stock through the bot's OWN three strategies, exactly as live:
  * each trade idea is sized with the live rules (2 % stop, target ≥ 1.6 × stop, ₹ risk per trade) and full charges;
  * its outcome is what really happened next — target first = win, stop first = loss (same minute = loss), still open
    at 15:12 = closed at that price after charges;
  * the facts known at that moment (time, regime of the NIFTY, VIX, momentum rank, move, volume …) are stored with it.
News and big-player flow did not exist in this history, so those facts are left blank; the model handles blanks.

All lessons go to the ml_samples table and the trade brain trains once on them. The usual rule stays: the model is
adopted only if it beats chance on the most recent days it never saw. Runs once, outside market hours, in a worker thread.

Data: Angel One historical candles when ANGEL_HISTORICAL_API_KEY is set (up to BRAIN_PRETRAIN_DAYS, e.g. 365),
otherwise Yahoo Finance (1-minute bars exist only for the last ~29 days there).
"""
from __future__ import annotations

import asyncio
import logging
import time as _time
from datetime import datetime, time, timedelta

import numpy as np

from app.backtest.engine import SimCtx
from app.clock import IST, now_ist
from app.costs.charges import ChargeModel
from app.market import yahoo
from app.market.feed import Candle, Series
from app.market.momentum import ranks
from app.market.regime import Regime, detect
from app.strategies.base import evaluate
from app.strategies.stock_intraday import OpeningRangeBreakout, VwapReversion, VwapTrendPullback

log = logging.getLogger("aq.pretrain")
STRATS = (OpeningRangeBreakout, VwapTrendPullback, VwapReversion)


def _rows_to_candles(rows: list[list]) -> list[Candle]:
    out = {}
    for r in rows:
        try:
            ts = int(datetime.fromisoformat(str(r[0])).timestamp()) // 60 * 60
            out[ts] = Candle(ts, float(r[1]), float(r[2]), float(r[3]), float(r[4]), float(r[5] or 0))
        except (ValueError, TypeError, IndexError):
            continue
    return [out[k] for k in sorted(out)]


async def _fetch_angel(e, items: list[tuple[str, str]], days: int) -> dict[str, list[Candle]]:
    rest = e.hist_rest
    if not rest.logged_in:
        await rest.login()
    end = now_ist().replace(hour=15, minute=30, second=0, microsecond=0)
    out = {}
    for name, token in items:
        rows, t = [], end - timedelta(days=days)
        while t < end:                                    # ≤ 30 days of 1-minute data per call
            t2 = min(end, t + timedelta(days=25))
            try:
                rows += await rest.candles("NSE", token, "ONE_MINUTE", t.strftime("%Y-%m-%d 09:15"), t2.strftime("%Y-%m-%d 15:30"))
            except Exception as ex:  # noqa: BLE001
                log.info("history %s %s: %s", name, t.date(), ex)
            t = t2
        cs = _rows_to_candles(rows)
        if cs:
            out[name] = cs
    return out


async def _fetch_yahoo(items: list[tuple[str, str]], days: int) -> dict[str, list[Candle]]:
    end = int(_time.time())
    start = end - min(days, 29) * 86400
    acc: dict[str, list] = {}
    t = start
    while t < end:                                        # Yahoo: ≤ 8 days of 1-minute bars per request
        t2 = min(end, t + 7 * 86400)
        got = await yahoo.chart_many(items, {"interval": "1m", "period1": t, "period2": t2})
        for k, rows in got.items():
            acc.setdefault(k, []).extend(rows)
        t = t2
    return {k: _rows_to_candles(v) for k, v in acc.items() if v}


def _regime_timeline(nifty: list[Candle], vix_by_day: dict[str, float]) -> dict[int, Regime]:
    """Regime every 5 minutes from NIFTY 1-minute bars (only bars up to that moment); carried forward in between."""
    out: dict[int, Regime] = {}
    if not nifty:
        return out
    ts = np.array([c.ts for c in nifty]); o = np.array([c.o for c in nifty]); h = np.array([c.h for c in nifty])
    lo = np.array([c.l for c in nifty]); cl = np.array([c.c for c in nifty]); v = np.array([c.v for c in nifty])
    day = (ts + 19800) // 86400
    prev_close, prev_day, day_open, dstart = None, None, None, 0
    days_sorted = sorted(vix_by_day)
    for i in range(len(ts)):
        if day[i] != prev_day:
            if prev_day is not None:
                prev_close = float(cl[i - 1])
            prev_day, day_open, dstart = day[i], float(o[i]), i
        if (i - dstart) % 5:
            continue
        a = max(0, i - 600)
        d = datetime.fromtimestamp(int(ts[i]), IST).date().isoformat()
        prior = [x for x in days_sorted if x < d]
        vix = vix_by_day.get(prior[-1]) if prior else None
        vprev = vix_by_day.get(prior[-2]) if len(prior) > 1 else None
        seg = (ts[a:i + 1], o[a:i + 1], h[a:i + 1], lo[a:i + 1], cl[a:i + 1], v[a:i + 1])
        orng = (float(h[dstart:dstart + 15].max()), float(lo[dstart:dstart + 15].min())) if i - dstart >= 15 else None
        try:
            out[int(ts[i])] = detect(seg, prev_close, day_open, vix, vprev, 0, 0, orng)
        except Exception:  # noqa: BLE001
            out[int(ts[i])] = Regime()
    return out


def _replay_stock(s, im, name: str, candles: list[Candle], regimes: dict[int, Regime], mom: dict[str, dict[str, float]],
                  charges: ChargeModel) -> list[dict]:
    """Pure computation (runs in a worker thread). Returns lessons for one stock."""
    from app.ai.scorer import REGIMES, STRATS as SNAMES
    ins = im.equity.get(name)
    if not ins or not candles:
        return []
    s1 = s.model_copy(update={"stock_universe": name})
    ctx = SimCtx(s1, im, s.paper_capital)
    strats = [cls(ctx) for cls in STRATS]
    ser = ctx.md.series.setdefault(ctx.key_for(ins), Series(live=False))
    reg_keys = sorted(regimes)
    ri, reg = 0, Regime()
    shadows: list[dict] = []
    out: list[dict] = []
    recent: dict[tuple, int] = {}
    sq = s.square_off_intraday_at
    last_day, last_close = None, None

    def resolve(sh, label, net, how):
        out.append({"t": sh["t0"], "strategy": sh["strategy"], "symbol": name, "side": sh["side"], "label": label,
                    "net": float(net), "outcome": how, "feats": sh["feats"]})

    for c in candles:
        now = datetime.fromtimestamp(c.ts, IST)
        d = now.date()
        if last_day is not None and d != last_day:        # missing bars at the end of a day → close at last price
            for sh in shadows:
                g = (last_close - sh["entry"]) * (1 if sh["side"] == "BUY" else -1) * sh["qty"] - sh["chg"]
                resolve(sh, 1 if g > 0 else 0, g, "square-off")
            shadows = []
        last_day, last_close = d, c.c
        # 1) outcomes of earlier ideas on this (later) bar
        keep = []
        for sh in shadows:
            buy = sh["side"] == "BUY"
            hit_s = c.l <= sh["stop"] if buy else c.h >= sh["stop"]
            hit_t = c.h >= sh["target"] if buy else c.l <= sh["target"]
            if hit_s:
                resolve(sh, 0, sh["net_stop"], "stop")
            elif hit_t:
                resolve(sh, 1, sh["net_target"], "target")
            elif now.time() >= sq:
                g = (c.c - sh["entry"]) * (1 if buy else -1) * sh["qty"] - sh["chg"]
                resolve(sh, 1 if g > 0 else 0, g, "square-off")
            else:
                keep.append(sh)
        shadows = keep
        # 2) feed the closed bar, then ask the strategies
        ser.candles.append(Candle(c.ts, c.o, c.h, c.l, c.c, c.v))
        ctx._now = now + timedelta(minutes=1)
        while ri < len(reg_keys) and reg_keys[ri] <= c.ts:
            reg = regimes[reg_keys[ri]]; ri += 1
        ctx.regime = reg
        if not (time(9, 15) <= now.time() < s.no_new_entries_after):
            continue
        for st in strats:
            try:
                plans = st.on_bar()
            except Exception:  # noqa: BLE001
                continue
            for plan in plans:
                evaluate(plan, charges, None, s.min_net_reward_rupees, s.min_reward_risk, check_ev=False)
                if plan.rejected.startswith(("quantity", "stop/target")) or not plan.qty:
                    continue
                k = (plan.strategy, plan.side)
                if c.ts - recent.get(k, -10**9) < 15 * 60:
                    continue
                recent[k] = c.ts
                ts_, o_, h_, l_, c_, v_ = ser.session()
                mv = (c_[-1] / o_[0] - 1) * 100 if len(c_) >= 5 and o_[0] > 0 else None
                vr = float(v_[-5:].mean() / v_[:-5].mean()) if len(v_) > 10 and v_[:-5].mean() > 0 else None
                e_ = plan.entry
                f = {"side": 1 if plan.side == "BUY" else -1, "minutes": ctx.minutes_since_open(),
                     "stop_pct": abs(e_ - plan.stop) / e_ * 100, "target_pct": abs(plan.target - e_) / e_ * 100,
                     "rr": plan.rr, "win_prob": plan.win_prob, "news": None, "has_news": 0.0, "news_event": 0.0,
                     "market_news": None, "flow": None, "book": None, "spread_pct": None, "move_pct": mv, "vol_ratio": vr,
                     "trend": reg.trend, "adx": reg.adx, "atr_pct": reg.atr_pct, "vix": reg.vix, "vix_chg": reg.vix_change_pct,
                     "gap_pct": reg.gap_pct, "breadth": reg.breadth, "momentum": mom.get(d.isoformat(), {}).get(name)}
                for x in SNAMES:
                    f[f"s_{x}"] = 1.0 if plan.strategy == x else 0.0
                for x in REGIMES:
                    f[f"r_{x}"] = 1.0 if reg.label == x else 0.0
                shadows.append({"t0": c.ts + 60, "strategy": plan.strategy, "side": plan.side, "entry": plan.entry,
                                "stop": plan.stop, "target": plan.target, "qty": plan.qty, "net_target": plan.net_target,
                                "net_stop": plan.net_stop, "chg": plan.charges_target, "feats": f})
    return out


async def _daily_closes(e, stocks: list[str]) -> dict[str, list[tuple[str, float]]]:
    """2 years of daily closes for the momentum rank (Yahoo daily; Angel One ONE_DAY as fallback)."""
    out: dict[str, list[tuple[str, float]]] = {}
    try:
        got = await yahoo.chart_many([(x, yahoo.ticker(x)) for x in stocks], {"interval": "1d", "range": "2y"})
        for k, rows in got.items():
            out[k] = sorted({datetime.fromisoformat(r[0]).astimezone(IST).date().isoformat(): float(r[4]) for r in rows}.items())
    except Exception as ex:  # noqa: BLE001
        log.info("daily closes from Yahoo: %s", ex)
    if len(out) < len(stocks) // 2 and getattr(e, "hist_rest", None):
        end = now_ist()
        for x in stocks:
            try:
                rows = await e.hist_rest.candles("NSE", e.im.equity[x].token, "ONE_DAY", (end - timedelta(days=730)).strftime("%Y-%m-%d 09:15"),
                                                 end.strftime("%Y-%m-%d 15:30"))
                out[x] = sorted({datetime.fromisoformat(str(r[0])).astimezone(IST).date().isoformat(): float(r[4]) for r in rows}.items())
            except Exception:  # noqa: BLE001
                continue
    return out


async def pretrain(e, days: int) -> list[str]:
    """Stock by stock (download → replay → write → forget), so a full year fits in a small server's memory."""
    from app.ai.scorer import vector
    s, im = e.s, e.im
    stocks = [x for x in s.stocks if x in im.equity]
    if not stocks:
        return ["pre-training skipped: stock list not loaded yet"]
    t0 = _time.time()
    use_angel = bool(getattr(e, "hist_rest", None))
    if use_angel:
        try:
            if not e.hist_rest.logged_in:
                await e.hist_rest.login()
            probe = await _fetch_angel(e, [(stocks[0], im.equity[stocks[0]].token)], 5)
            use_angel = bool(probe)
        except Exception as ex:  # noqa: BLE001
            log.warning("Angel One history unavailable: %s", ex)
            use_angel = False
    src = "Angel One" if use_angel else "Yahoo Finance (last ~29 days only — add ANGEL_HISTORICAL_API_KEY for a full year)"
    span = days if use_angel else min(days, 29)
    e.event("pretrain", f"pre-training started: {len(stocks)} stocks, {span} days of 1-minute history from {src}")

    async def get(items):
        return await (_fetch_angel(e, items, span) if use_angel else _fetch_yahoo(items, span))

    nifty_tok = im.index_token("NIFTY")
    nifty = (await get([("NIFTY", nifty_tok if use_angel else "^NSEI")])).get("NIFTY", [])
    vix_by_day: dict[str, float] = {}
    try:
        vg = await yahoo.chart_many([("VIX", "^INDIAVIX")], {"interval": "1d", "range": "2y"})
        for r in vg.get("VIX", []):
            vix_by_day[datetime.fromisoformat(r[0]).astimezone(IST).date().isoformat()] = float(r[4])
    except Exception:  # noqa: BLE001
        pass
    regimes = await asyncio.to_thread(_regime_timeline, nifty, vix_by_day)
    del nifty
    closes = await _daily_closes(e, stocks)
    all_days = sorted({d for v in closes.values() for d, _ in v})[-(span + 40):]
    mom = {d: ranks(closes, asof=d) for d in all_days}
    charges = ChargeModel()
    T, X, Y = [], [], []
    by: dict[str, list[float]] = {}
    done, days_seen = 0, set()
    for name in stocks:
        tk = im.equity[name].token if use_angel else yahoo.ticker(name)
        cs = (await get([(name, tk)])).get(name, [])
        if not cs:
            continue
        lessons = await asyncio.to_thread(_replay_stock, s, im, name, cs, regimes, mom, charges)
        days_seen |= {datetime.fromtimestamp(c.ts, IST).date() for c in cs[:: 375]}
        del cs
        if lessons:
            await e.store.ml_bulk(lessons)
            for r in lessons:
                T.append(r["t"]); Y.append(r["label"]); X.append(vector(r["feats"]))
                by.setdefault(r["strategy"], []).append(r["net"])
        done += 1
        if done % 10 == 0:
            e.event("pretrain", f"replayed {done}/{len(stocks)} stocks · {len(Y):,} lessons so far")
    if not Y:
        return [f"pre-training: no usable history from {src} — will retry after the next restart"]
    wins = int(sum(Y))
    per = " · ".join(f"{k}: {len(v):,} ideas, {sum(1 for x in v if x > 0) / len(v):.0%} win, avg ₹{np.mean(v):,.0f}"
                     for k, v in sorted(by.items()))
    msgs = [f"pre-training: {len(Y):,} lessons from {done} stocks × ~{len(days_seen)} days ({src}), "
            f"{wins / len(Y):.0%} would-win · {per}"]
    msgs += await e.brain.train(arrays=(np.array(T), np.array(X, dtype=np.float32), np.array(Y)))
    e.brain.last_log = msgs[-1:]
    e.store.kv_put("brain_pretrained", {"day": now_ist().date().isoformat(), "lessons": len(Y), "stocks": done,
                                        "source": src, "minutes": round((_time.time() - t0) / 60, 1)})
    msgs.append(f"pre-training finished in {(_time.time() - t0) / 60:.0f} min")
    return msgs
