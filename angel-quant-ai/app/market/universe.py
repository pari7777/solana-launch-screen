"""Stock universe from official NSE index lists (niftyindices.com), refreshed once a day.

STOCK_UNIVERSE_INDEXES="NIFTY MIDCAP SELECT,NIFTY SMALLCAP 50" (default) trades the 25 most liquid mid caps and 50 small
caps. If the lists cannot be downloaded, the static STOCK_UNIVERSE list is used. Only symbols present in Angel One's
instrument master as NSE equities are kept, and illiquid quotes are still filtered by the engine (spread / depth).
"""
from __future__ import annotations

import csv
import io
import logging

import httpx

log = logging.getLogger("aq.universe")

FILES = {
    "NIFTY 50": "ind_nifty50list.csv",
    "NIFTY NEXT 50": "ind_niftynext50list.csv",
    "NIFTY MIDCAP SELECT": "ind_niftymidcapselect_list.csv",
    "NIFTY MIDCAP 50": "ind_niftymidcap50list.csv",
    "NIFTY MIDCAP 100": "ind_niftymidcap100list.csv",
    "NIFTY MIDCAP 150": "ind_niftymidcap150list.csv",
    "NIFTY SMALLCAP 50": "ind_niftysmallcap50list.csv",
    "NIFTY SMALLCAP 100": "ind_niftysmallcap100list.csv",
    "NIFTY SMALLCAP 250": "ind_niftysmallcap250list.csv",
}
HOSTS = ("https://www.niftyindices.com/IndexConstituent/", "https://nsearchives.nseindia.com/content/indices/")
UA = {"User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/124 Safari/537.36", "Accept": "text/csv,*/*"}


def parse(text: str) -> list[str]:
    out = []
    for row in csv.DictReader(io.StringIO(text)):
        sym = (row.get("Symbol") or row.get("SYMBOL") or "").strip().upper()
        series = (row.get("Series") or "EQ").strip().upper()
        if sym and series == "EQ":
            out.append(sym)
    return out


async def fetch(indexes: list[str], timeout: float = 15.0) -> tuple[list[str], list[str]]:
    """Symbols of the given indexes (deduplicated, in order) and notes about anything that failed."""
    syms: list[str] = []
    notes: list[str] = []
    async with httpx.AsyncClient(timeout=timeout, headers=UA, follow_redirects=True) as c:
        for name in indexes:
            f = FILES.get(name.strip().upper())
            if not f:
                notes.append(f"unknown index {name!r}")
                continue
            got = []
            for host in HOSTS:
                try:
                    r = await c.get(host + f)
                    if r.status_code == 200 and "Symbol" in r.text[:500]:
                        got = parse(r.text)
                        if got:
                            break
                except httpx.HTTPError as e:
                    log.warning("universe %s from %s: %s", name, host, e)
            if got:
                syms += [s for s in got if s not in syms]
            else:
                notes.append(f"could not download {name}")
    return syms, notes
