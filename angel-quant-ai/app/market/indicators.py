"""Technical indicators on NumPy arrays (TA-Lib-equivalent definitions, no C dependency).
All functions are causal: value i uses only data up to and including i (no look-ahead)."""
from __future__ import annotations

import numpy as np


def ema(x: np.ndarray, n: int) -> np.ndarray:
    x = np.asarray(x, dtype=float)
    out = np.full_like(x, np.nan)
    if len(x) < n:
        return out
    a = 2.0 / (n + 1)
    out[n - 1] = x[:n].mean()
    for i in range(n, len(x)):
        out[i] = a * x[i] + (1 - a) * out[i - 1]
    return out


def sma(x: np.ndarray, n: int) -> np.ndarray:
    x = np.asarray(x, dtype=float)
    out = np.full_like(x, np.nan)
    if len(x) >= n:
        c = np.cumsum(np.insert(x, 0, 0.0))
        out[n - 1:] = (c[n:] - c[:-n]) / n
    return out


def _wilder(x: np.ndarray, n: int) -> np.ndarray:
    out = np.full_like(x, np.nan, dtype=float)
    if len(x) < n:
        return out
    out[n - 1] = np.nanmean(x[:n])
    for i in range(n, len(x)):
        out[i] = (out[i - 1] * (n - 1) + x[i]) / n
    return out


def rsi(close: np.ndarray, n: int = 14) -> np.ndarray:
    c = np.asarray(close, dtype=float)
    out = np.full_like(c, np.nan)
    if len(c) <= n:
        return out
    d = np.diff(c)
    up, dn = np.where(d > 0, d, 0.0), np.where(d < 0, -d, 0.0)
    au, ad = _wilder(up, n), _wilder(dn, n)
    with np.errstate(divide="ignore", invalid="ignore"):
        rs = au / ad
        r = 100 - 100 / (1 + rs)
    r = np.where(ad == 0, 100.0, r)
    out[1:] = r
    return out


def true_range(h, l, c) -> np.ndarray:
    h, l, c = (np.asarray(a, dtype=float) for a in (h, l, c))
    pc = np.roll(c, 1)
    pc[0] = c[0]
    return np.maximum(h - l, np.maximum(abs(h - pc), abs(l - pc)))


def atr(h, l, c, n: int = 14) -> np.ndarray:
    return _wilder(true_range(h, l, c), n)


def adx(h, l, c, n: int = 14) -> np.ndarray:
    h, l, c = (np.asarray(a, dtype=float) for a in (h, l, c))
    if len(c) < 2 * n + 1:
        return np.full_like(c, np.nan)
    upm, dnm = np.diff(h, prepend=h[0]), -np.diff(l, prepend=l[0])
    pdm = np.where((upm > dnm) & (upm > 0), upm, 0.0)
    ndm = np.where((dnm > upm) & (dnm > 0), dnm, 0.0)
    tr = _wilder(true_range(h, l, c), n)
    with np.errstate(divide="ignore", invalid="ignore"):
        pdi, ndi = 100 * _wilder(pdm, n) / tr, 100 * _wilder(ndm, n) / tr
        dx = 100 * abs(pdi - ndi) / (pdi + ndi)
    dx = np.nan_to_num(dx, nan=0.0)
    out = np.full_like(c, np.nan)
    start = n
    out[start + n - 1] = dx[start:start + n].mean()
    for i in range(start + n, len(c)):
        out[i] = (out[i - 1] * (n - 1) + dx[i]) / n
    return out


def vwap(h, l, c, v) -> np.ndarray:
    """Session VWAP (caller passes one session of candles)."""
    tp = (np.asarray(h, float) + np.asarray(l, float) + np.asarray(c, float)) / 3
    v = np.asarray(v, float)
    cv = np.cumsum(v)
    with np.errstate(divide="ignore", invalid="ignore"):
        return np.where(cv > 0, np.cumsum(tp * v) / cv, tp)


def bollinger(c, n: int = 20, k: float = 2.0):
    c = np.asarray(c, float)
    m = sma(c, n)
    sd = np.full_like(c, np.nan)
    for i in range(n - 1, len(c)):
        sd[i] = c[i - n + 1:i + 1].std()
    return m - k * sd, m, m + k * sd


def supertrend(h, l, c, n: int = 10, mult: float = 3.0):
    """Returns (line, direction) with direction +1 up-trend / -1 down-trend."""
    h, l, c = (np.asarray(a, float) for a in (h, l, c))
    a = atr(h, l, c, n)
    mid = (h + l) / 2
    ub, lb = mid + mult * a, mid - mult * a
    line = np.full_like(c, np.nan)
    d = np.zeros(len(c))
    fub, flb = ub.copy(), lb.copy()
    for i in range(1, len(c)):
        if np.isnan(a[i]):
            continue
        fub[i] = ub[i] if (np.isnan(fub[i - 1]) or ub[i] < fub[i - 1] or c[i - 1] > fub[i - 1]) else fub[i - 1]
        flb[i] = lb[i] if (np.isnan(flb[i - 1]) or lb[i] > flb[i - 1] or c[i - 1] < flb[i - 1]) else flb[i - 1]
        prev = d[i - 1] if d[i - 1] != 0 else 1
        if prev == 1 and c[i] < flb[i]:
            d[i] = -1
        elif prev == -1 and c[i] > fub[i]:
            d[i] = 1
        else:
            d[i] = prev
        line[i] = flb[i] if d[i] == 1 else fub[i]
    return line, d
