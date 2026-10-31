"""Strategy statistics and capital allocation.

Win probabilities are CALIBRATED from closed trades (paper or live, out of sample — the trades happened after the
strategy rules were fixed), shrunk toward a conservative prior until there are enough trades.
Capital per strategy family starts from fixed weights and is cut for families with negative net expectancy.
A fractional-Kelly figure is reported for research only and never used above KELLY_CAP."""
from __future__ import annotations

from dataclasses import dataclass

PRIOR_P, PRIOR_N = 0.40, 20
FAMILY = {"stock_orb": "stock_intraday", "stock_vwap_trend": "stock_intraday", "stock_vwap_reversion": "stock_intraday",
          "opt_momentum": "options_scalp", "opt_debit_spread": "options_directional", "opt_iron_condor": "options_directional",
          "swing": "swing"}
BASE_WEIGHTS = {"stock_intraday": 0.35, "options_scalp": 0.15, "options_directional": 0.20, "swing": 0.10, "cash_reserve": 0.20}
KELLY_FRACTION, KELLY_CAP = 0.25, 0.05


@dataclass
class StratStats:
    n: int = 0
    wins: int = 0
    gross_win: float = 0.0
    gross_loss: float = 0.0
    net: float = 0.0

    def add(self, pnl: float):
        self.n += 1
        self.net += pnl
        if pnl > 0:
            self.wins += 1; self.gross_win += pnl
        else:
            self.gross_loss += -pnl

    @property
    def win_rate(self) -> float:
        return (self.wins + PRIOR_P * PRIOR_N) / (self.n + PRIOR_N)

    @property
    def profit_factor(self) -> float | None:
        return self.gross_win / self.gross_loss if self.gross_loss > 0 else None

    @property
    def expectancy(self) -> float:
        return self.net / self.n if self.n else 0.0

    def kelly(self) -> float | None:
        if self.n < 30 or not self.wins or self.wins == self.n:
            return None
        avg_w, avg_l = self.gross_win / self.wins, self.gross_loss / (self.n - self.wins)
        if avg_l <= 0:
            return None
        b, p = avg_w / avg_l, self.wins / self.n
        f = p - (1 - p) / b
        return max(0.0, min(KELLY_CAP, f * KELLY_FRACTION))


class Stats:
    def __init__(self):
        self.by: dict[str, StratStats] = {}

    def load(self, outcomes: dict[str, list[float]]):
        self.by = {}
        for k, xs in outcomes.items():
            st = StratStats()
            for x in xs:
                st.add(x)
            self.by[k] = st

    def add(self, strategy: str, pnl: float):
        self.by.setdefault(strategy, StratStats()).add(pnl)

    def win_rate(self, strategy: str) -> tuple[float, str]:
        st = self.by.get(strategy)
        if not st or st.n == 0:
            return PRIOR_P, "prior (no trades yet)"
        return st.win_rate, f"{st.n} closed trades (shrunk to prior)" if st.n < 50 else f"{st.n} closed trades"

    def table(self) -> list[dict]:
        return [{"strategy": k, "trades": v.n, "win_rate": round(v.wins / v.n * 100, 1) if v.n else None,
                 "calibrated_p": round(v.win_rate, 3), "net": round(v.net, 2), "expectancy": round(v.expectancy, 2),
                 "profit_factor": round(v.profit_factor, 2) if v.profit_factor else None, "kelly_research": v.kelly()}
                for k, v in sorted(self.by.items())]


def budgets(stats: Stats, capital: float) -> dict[str, float]:
    """Rupee budget per strategy family. Families with ≥20 trades and negative expectancy get half weight."""
    fam_stats: dict[str, StratStats] = {}
    for strat, st in stats.by.items():
        f = FAMILY.get(strat, strat)
        agg = fam_stats.setdefault(f, StratStats())
        agg.n += st.n; agg.net += st.net
    out = {}
    for fam, w in BASE_WEIGHTS.items():
        if fam == "cash_reserve":
            continue
        fs = fam_stats.get(fam)
        if fs and fs.n >= 20 and fs.net < 0:
            w *= 0.5
        out[fam] = round(capital * w, 2)
    out["cash_reserve"] = round(capital * BASE_WEIGHTS["cash_reserve"], 2)
    return out
