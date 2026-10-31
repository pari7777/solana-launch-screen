"""Indian market clock (IST). NSE cash and F&O normal session: 09:15–15:30 IST, Monday–Friday.
Exchange holidays are detected from the live feed (no ticks) and an optional HOLIDAYS list in config/holidays.txt."""
from __future__ import annotations

from datetime import date, datetime, time, timedelta, timezone
from pathlib import Path

IST = timezone(timedelta(hours=5, minutes=30))
OPEN, CLOSE = time(9, 15), time(15, 30)


def now_ist() -> datetime:
    return datetime.now(IST)


def _holidays() -> set[date]:
    p = Path(__file__).resolve().parent.parent / "config" / "holidays.txt"
    out: set[date] = set()
    if p.exists():
        for line in p.read_text().splitlines():
            line = line.split("#")[0].strip()
            if line:
                try:
                    out.add(date.fromisoformat(line))
                except ValueError:
                    pass
    return out


HOLIDAYS = _holidays()


def is_trading_day(d: date) -> bool:
    return d.weekday() < 5 and d not in HOLIDAYS


def market_open(t: datetime | None = None) -> bool:
    t = t or now_ist()
    return is_trading_day(t.date()) and OPEN <= t.time() < CLOSE


def minutes_since_open(t: datetime | None = None) -> float:
    t = t or now_ist()
    o = datetime.combine(t.date(), OPEN, tzinfo=IST)
    return (t - o).total_seconds() / 60
