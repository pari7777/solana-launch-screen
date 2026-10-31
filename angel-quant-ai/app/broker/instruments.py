"""Instrument master: downloaded once per trading day (never during market hours if a fresh copy exists),
kept in memory with fast lookups. Lot sizes, tick sizes, expiries and strikes all come from this file,
so contract changes by NSE (lot-size revisions, weekly/monthly expiry changes) are picked up automatically.

Scrip-master fields: token, symbol, name, expiry (DDMONYYYY), strike (×100), lotsize, instrumenttype, exch_seg, tick_size (paise).
"""
from __future__ import annotations

import json
import logging
import time
from dataclasses import dataclass
from datetime import date, datetime
from pathlib import Path

import httpx

from app.clock import now_ist

log = logging.getLogger("instruments")

# Index tokens published by Angel One (used if the master lookup fails)
INDEX_TOKENS = {"NIFTY": "99926000", "BANKNIFTY": "99926009", "FINNIFTY": "99926037", "INDIAVIX": "99926017",
                "MIDCPNIFTY": "99926074", "SENSEX": "99919000"}
INDEX_NAMES = {"NIFTY": "Nifty 50", "BANKNIFTY": "Nifty Bank", "FINNIFTY": "Nifty Fin Service", "INDIAVIX": "India VIX",
               "MIDCPNIFTY": "NIFTY MID SELECT"}


@dataclass(slots=True, frozen=True)
class Instrument:
    token: str
    symbol: str
    name: str
    exchange: str
    itype: str
    expiry: date | None
    strike: float
    lot: int
    tick: float

    @property
    def is_option(self) -> bool:
        return self.itype in ("OPTIDX", "OPTSTK")

    @property
    def right(self) -> str | None:
        if not self.is_option:
            return None
        return "CE" if self.symbol.endswith("CE") else "PE" if self.symbol.endswith("PE") else None


def _expiry(s: str) -> date | None:
    s = (s or "").strip()
    if not s:
        return None
    for fmt in ("%d%b%Y", "%d%b%y", "%Y-%m-%d"):
        try:
            return datetime.strptime(s.title() if fmt != "%Y-%m-%d" else s, fmt).date()
        except ValueError:
            continue
    return None


def parse_row(r: dict) -> Instrument | None:
    try:
        tick = float(r.get("tick_size") or 5) / 100.0
        return Instrument(token=str(r["token"]), symbol=str(r.get("symbol", "")), name=str(r.get("name", "")).upper(),
                          exchange=str(r.get("exch_seg", "")), itype=str(r.get("instrumenttype", "") or ""),
                          expiry=_expiry(str(r.get("expiry", ""))), strike=float(r.get("strike") or 0) / 100.0,
                          lot=int(float(r.get("lotsize") or 1)), tick=tick if tick > 0 else 0.05)
    except (KeyError, ValueError, TypeError):
        return None


class InstrumentMaster:
    def __init__(self, url: str, data_dir: str):
        self.url = url
        self.path = Path(data_dir) / "scrip_master.json"
        self.by_token: dict[tuple[str, str], Instrument] = {}
        self.equity: dict[str, Instrument] = {}               # NSE cash: name → instrument
        self.options: dict[str, list[Instrument]] = {}        # underlying → options (NFO)
        self.futures: dict[str, list[Instrument]] = {}
        self.indices: dict[str, Instrument] = {}
        self.loaded_at: float = 0.0
        self.source = "none"

    def _fresh_on_disk(self) -> bool:
        if not self.path.exists():
            return False
        mtime = datetime.fromtimestamp(self.path.stat().st_mtime, tz=now_ist().tzinfo)
        return mtime.date() == now_ist().date()          # one download per IST day

    async def load(self, force: bool = False) -> int:
        rows = None
        if not force and self._fresh_on_disk():
            rows = json.loads(self.path.read_text())
            self.source = "cache"
        else:
            try:
                async with httpx.AsyncClient(timeout=60) as c:
                    r = await c.get(self.url)
                    r.raise_for_status()
                    rows = r.json()
                self.path.parent.mkdir(parents=True, exist_ok=True)
                self.path.write_text(json.dumps(rows))
                self.source = "download"
            except Exception as e:
                if self.path.exists():
                    log.warning("scrip master download failed (%s); using cached copy", e)
                    rows = json.loads(self.path.read_text())
                    self.source = "stale-cache"
                else:
                    raise
        self.index(rows)
        return len(self.by_token)

    def index(self, rows: list[dict]):
        by_token, equity, options, futures, indices = {}, {}, {}, {}, {}
        today = now_ist().date()
        for r in rows:
            ins = parse_row(r)
            if not ins:
                continue
            by_token[(ins.exchange, ins.token)] = ins
            if ins.exchange == "NSE" and ins.symbol.endswith("-EQ"):
                equity[ins.name] = ins
            elif ins.exchange == "NFO" and ins.is_option and ins.expiry and ins.expiry >= today:
                options.setdefault(ins.name, []).append(ins)
            elif ins.exchange == "NFO" and ins.itype in ("FUTIDX", "FUTSTK") and ins.expiry and ins.expiry >= today:
                futures.setdefault(ins.name, []).append(ins)
            elif ins.itype == "AMXIDX" and ins.exchange in ("NSE", "BSE"):
                indices[ins.name] = ins
        self.by_token, self.equity, self.options, self.futures = by_token, equity, options, futures
        self.indices = indices
        self.loaded_at = time.time()

    def index_token(self, name: str) -> str:
        n = INDEX_NAMES.get(name, name).upper()
        ins = self.indices.get(n)
        return ins.token if ins else INDEX_TOKENS.get(name, "")

    def expiries(self, underlying: str) -> list[date]:
        return sorted({i.expiry for i in self.options.get(underlying, []) if i.expiry})

    def chain(self, underlying: str, expiry: date) -> list[Instrument]:
        return sorted((i for i in self.options.get(underlying, []) if i.expiry == expiry), key=lambda i: (i.strike, i.symbol))

    def nearest_strikes(self, underlying: str, expiry: date, spot: float, n: int = 3) -> list[Instrument]:
        """ATM and the n strikes on each side, both CE and PE."""
        ch = self.chain(underlying, expiry)
        strikes = sorted({i.strike for i in ch})
        if not strikes:
            return []
        atm = min(strikes, key=lambda k: abs(k - spot))
        idx = strikes.index(atm)
        keep = set(strikes[max(0, idx - n): idx + n + 1])
        return [i for i in ch if i.strike in keep]

    def get(self, exchange: str, token: str) -> Instrument | None:
        return self.by_token.get((exchange, token))
