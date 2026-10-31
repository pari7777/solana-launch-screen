"""Market regime detection from NIFTY candles, India VIX and the breadth of the stock universe.
Rule-based and causal; Claude may add commentary, but the label used for strategy selection comes from here."""
from __future__ import annotations

from dataclasses import dataclass, field

import numpy as np

from app.market import indicators as ind


@dataclass
class Regime:
    label: str = "UNKNOWN"          # BULL_TREND | BEAR_TREND | SIDEWAYS | VOL_EXPANSION | REVERSAL_UP | REVERSAL_DOWN | UNKNOWN
    trend: float = 0.0              # -1 … +1
    adx: float | None = None
    atr_pct: float | None = None
    vix: float | None = None
    vix_change_pct: float | None = None
    gap_pct: float | None = None
    breadth: float | None = None    # advancers / (advancers + decliners)
    tags: list[str] = field(default_factory=list)   # GAP_UP, GAP_DOWN, BREAKOUT, BREAKDOWN, VOL_CONTRACTION …

    def as_dict(self):
        return {k: (round(v, 3) if isinstance(v, float) else v) for k, v in self.__dict__.items()}


def resample(ts, o, h, l, c, minutes: int):
    if not len(ts):
        return [np.array([])] * 5
    b = ts // (minutes * 60)
    idx = np.flatnonzero(np.diff(b, prepend=b[0] - 1))
    ends = np.append(idx[1:], len(ts)) - 1
    return (ts[idx], o[idx], np.maximum.reduceat(h, idx), np.minimum.reduceat(l, idx), c[ends])


def detect(nifty_1m: tuple, prev_close: float | None, day_open: float | None, vix: float | None, vix_prev: float | None,
           advancers: int, decliners: int, opening_range: tuple[float, float] | None) -> Regime:
    ts, o, h, l, c, _v = nifty_1m
    r = Regime(vix=vix)
    if vix and vix_prev:
        r.vix_change_pct = (vix / vix_prev - 1) * 100
    if advancers + decliners:
        r.breadth = advancers / (advancers + decliners)
    if prev_close and day_open:
        r.gap_pct = (day_open / prev_close - 1) * 100
        if r.gap_pct >= 0.5:
            r.tags.append("GAP_UP")
        elif r.gap_pct <= -0.5:
            r.tags.append("GAP_DOWN")
    if len(c) < 60:
        r.tags.append("WARMING_UP")
        return r
    t5, o5, h5, l5, c5 = resample(ts, o, h, l, c, 5)
    if len(c5) < 30:
        r.tags.append("WARMING_UP")
        return r
    e20, e50 = ind.ema(c5, 20), ind.ema(c5, min(50, len(c5) - 1))
    a = ind.adx(h5, l5, c5, 14)
    at = ind.atr(h5, l5, c5, 14)
    _, st_dir = ind.supertrend(h5, l5, c5, 10, 3)
    lo, mid, up = ind.bollinger(c5, 20, 2)
    last = c5[-1]
    r.adx = float(a[-1]) if not np.isnan(a[-1]) else None
    r.atr_pct = float(at[-1] / last * 100) if not np.isnan(at[-1]) else None
    bbw = (up - lo) / mid
    bbw_now = float(bbw[-1]) if not np.isnan(bbw[-1]) else None
    bbw_med = float(np.nanmedian(bbw[-60:])) if np.isfinite(bbw[-60:]).any() else None
    slope = (e20[-1] - e20[-6]) / last * 100 if not np.isnan(e20[-6]) else 0.0
    score = 0.0
    score += 0.35 if last > e20[-1] else -0.35
    score += 0.25 if e20[-1] > e50[-1] else -0.25
    score += 0.2 * float(np.clip(slope / 0.15, -1, 1))
    score += 0.2 * float(st_dir[-1])
    if r.breadth is not None:
        score = 0.85 * score + 0.15 * (r.breadth - 0.5) * 2
    r.trend = float(np.clip(score, -1, 1))
    if opening_range:
        hi, lo_ = opening_range
        if last > hi:
            r.tags.append("BREAKOUT")
        elif last < lo_:
            r.tags.append("BREAKDOWN")
    if bbw_now is not None and bbw_med:
        if bbw_now > 1.6 * bbw_med:
            r.tags.append("VOL_EXPANSION")
        elif bbw_now < 0.7 * bbw_med:
            r.tags.append("VOL_CONTRACTION")
    if r.vix_change_pct is not None and r.vix_change_pct > 8:
        r.tags.append("VIX_SPIKE")
    # reversal: supertrend flipped within the last 3 bars against the prior trend
    flips = np.flatnonzero(np.diff(st_dir[-4:]) != 0)
    adx_v = r.adx or 0
    if len(flips) and st_dir[-1] != 0:
        r.label = "REVERSAL_UP" if st_dir[-1] > 0 else "REVERSAL_DOWN"
    elif "VOL_EXPANSION" in r.tags or "VIX_SPIKE" in r.tags:
        r.label = "VOL_EXPANSION"
    elif adx_v >= 22 and r.trend >= 0.4:
        r.label = "BULL_TREND"
    elif adx_v >= 22 and r.trend <= -0.4:
        r.label = "BEAR_TREND"
    elif adx_v < 18 and abs(r.trend) < 0.5:
        r.label = "SIDEWAYS"
    else:
        r.label = "BULL_TREND" if r.trend > 0.5 else "BEAR_TREND" if r.trend < -0.5 else "SIDEWAYS"
    return r


# Which strategy families may trade in which regime (central selection; strategies never self-authorise)
ALLOWED = {
    "BULL_TREND": {"stock_orb", "stock_vwap_trend", "opt_momentum", "opt_debit_spread", "swing"},
    "BEAR_TREND": {"stock_orb", "stock_vwap_trend", "opt_momentum", "opt_debit_spread"},
    "SIDEWAYS": {"stock_vwap_reversion", "opt_iron_condor"},
    "VOL_EXPANSION": {"opt_momentum", "stock_orb"},
    "REVERSAL_UP": {"stock_vwap_trend", "opt_debit_spread"},
    "REVERSAL_DOWN": {"stock_vwap_trend", "opt_debit_spread"},
    "UNKNOWN": set(),
}


def allowed(regime: Regime, strategy: str, side: str) -> bool:
    if strategy not in ALLOWED.get(regime.label, set()):
        return False
    # direction must agree with the regime for trend strategies
    bullish = regime.label in ("BULL_TREND", "REVERSAL_UP") or (regime.label == "VOL_EXPANSION" and regime.trend > 0.3)
    bearish = regime.label in ("BEAR_TREND", "REVERSAL_DOWN") or (regime.label == "VOL_EXPANSION" and regime.trend < -0.3)
    if strategy in ("stock_vwap_reversion", "opt_iron_condor"):
        return True
    if side == "LONG":
        return bullish
    if side == "SHORT":
        return bearish
    return False
