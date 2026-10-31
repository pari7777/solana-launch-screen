"""Central portfolio risk manager. Every plan from every strategy passes through check() before an order exists.
The risk manager can only say no; it never creates, enlarges or averages into a trade."""
from __future__ import annotations

import time
from dataclasses import dataclass, field
from datetime import date

from app.clock import now_ist
from app.config import Settings


@dataclass
class RiskState:
    capital_start_day: float
    capital_start_week: float
    peak_equity: float
    realized_today: float = 0.0
    realized_week: float = 0.0
    charges_today: float = 0.0
    consecutive_losses: int = 0
    trades_today: int = 0
    day: date | None = None
    week: int | None = None
    kill_switch: str = ""             # non-empty = no new entries, reason shown on dashboard
    paused: bool = False
    disabled_strategies: set[str] = field(default_factory=set)
    rejects: dict[str, int] = field(default_factory=dict)


class RiskManager:
    def __init__(self, s: Settings, capital: float):
        self.s = s
        self.st = RiskState(capital_start_day=capital, capital_start_week=capital, peak_equity=capital)
        self.health_reasons: list[str] = []   # stale data, broker not reconciled, disconnected …

    # ── day/week roll ──
    def roll(self, equity: float):
        n = now_ist()
        wk = n.isocalendar()[1]
        if self.st.day != n.date():
            self.st.day, self.st.realized_today, self.st.charges_today, self.st.trades_today = n.date(), 0.0, 0.0, 0
            self.st.capital_start_day = equity
            if self.st.kill_switch.startswith("daily"):
                self.st.kill_switch = ""
        if self.st.week != wk:
            self.st.week, self.st.realized_week, self.st.capital_start_week = wk, 0.0, equity
            if self.st.kill_switch.startswith("weekly"):
                self.st.kill_switch = ""

    def on_closed_trade(self, net_pnl: float, charges: float, equity: float):
        self.st.realized_today += net_pnl
        self.st.realized_week += net_pnl
        self.st.charges_today += charges
        self.st.trades_today += 1
        self.st.consecutive_losses = self.st.consecutive_losses + 1 if net_pnl < 0 else 0
        self.st.peak_equity = max(self.st.peak_equity, equity)
        self.update_limits(equity)

    def update_limits(self, equity: float, unrealized: float = 0.0):
        s = self.s
        day_loss = -(self.st.realized_today + min(0.0, unrealized))
        if day_loss >= self.st.capital_start_day * s.max_daily_loss_pct / 100:
            self.st.kill_switch = f"daily loss limit {s.max_daily_loss_pct}% hit (₹{day_loss:,.0f})"
        elif -self.st.realized_week >= self.st.capital_start_week * s.max_weekly_loss_pct / 100:
            self.st.kill_switch = f"weekly loss limit {s.max_weekly_loss_pct}% hit"
        elif self.st.peak_equity and (1 - equity / self.st.peak_equity) * 100 >= s.max_drawdown_pct:
            self.st.kill_switch = f"max drawdown {s.max_drawdown_pct}% hit — manual reset required"
        elif self.st.consecutive_losses >= s.max_consecutive_losses:
            self.st.kill_switch = f"daily: {self.st.consecutive_losses} consecutive losses"

    # ── pre-trade check ──
    def check(self, plan, positions: list, capital: float, data_age_s: float, margin_available: float | None) -> str | None:
        s = self.s
        n = now_ist()
        if self.st.paused:
            return "new entries paused"
        if self.st.kill_switch:
            return f"kill switch: {self.st.kill_switch}"
        if self.health_reasons:
            return "safe mode: " + "; ".join(self.health_reasons)
        if plan.strategy in self.st.disabled_strategies:
            return "strategy disabled"
        if data_age_s > s.stale_data_seconds:
            return f"market data stale ({data_age_s:.1f}s)"
        if n.time() >= s.no_new_entries_after and plan.product == "INTRADAY":
            return f"no new intraday entries after {s.no_new_entries_after:%H:%M}"
        if plan.rejected:
            return plan.rejected
        open_pos = [p for p in positions if p.is_open]
        if len(open_pos) >= s.max_open_positions:
            return f"max open positions ({s.max_open_positions})"
        if any(p.key == plan.ins.token and p.is_open for p in open_pos):
            return "duplicate: already holding this instrument"
        if any(p.underlying == plan.underlying and p.strategy == plan.strategy and p.is_open for p in open_pos):
            return "duplicate: same strategy already in this underlying"
        if plan.capital > capital * s.max_capital_per_trade_pct / 100 * 1.001:
            return f"capital ₹{plan.capital:,.0f} > {s.max_capital_per_trade_pct}% per trade"
        if -plan.net_stop > capital * s.max_risk_per_trade_pct / 100 * 1.25:
            return f"loss at stop ₹{-plan.net_stop:,.0f} > risk budget"
        und = sum(p.capital for p in open_pos if p.underlying == plan.underlying) + plan.capital
        if und > capital * s.max_per_underlying_pct / 100:
            return f"exposure to {plan.underlying} would exceed {s.max_per_underlying_pct}%"
        if plan.ins.is_option and plan.side == "BUY":
            prem = sum(p.capital for p in open_pos if p.is_option_buy) + plan.capital
            if prem > capital * s.max_option_premium_pct / 100:
                return f"option premium exposure would exceed {s.max_option_premium_pct}%"
        if plan.ins.is_option and plan.qty > s.max_order_qty_lots * plan.ins.lot:
            return f"order size above {s.max_order_qty_lots} lots"
        used = sum(p.capital for p in open_pos)
        if used + plan.capital > capital * 0.8:
            return "would use more than 80% of capital (cash reserve rule)"
        if margin_available is not None and plan.capital > margin_available:
            return f"insufficient margin (₹{margin_available:,.0f} available)"
        return None

    def reject(self, reason: str):
        k = reason.split(":")[0].split("(")[0].strip()[:40]
        self.st.rejects[k] = self.st.rejects.get(k, 0) + 1

    def snapshot(self, equity: float) -> dict:
        s = self.s
        day_limit = self.st.capital_start_day * s.max_daily_loss_pct / 100
        return {"kill_switch": self.st.kill_switch, "paused": self.st.paused, "health": self.health_reasons,
                "realized_today": round(self.st.realized_today, 2), "realized_week": round(self.st.realized_week, 2),
                "charges_today": round(self.st.charges_today, 2), "trades_today": self.st.trades_today,
                "consecutive_losses": self.st.consecutive_losses, "daily_limit": round(day_limit, 2),
                "daily_used_pct": round(max(0.0, -self.st.realized_today) / day_limit * 100, 1) if day_limit else 0,
                "drawdown_pct": round((1 - equity / self.st.peak_equity) * 100, 2) if self.st.peak_equity else 0,
                "disabled": sorted(self.st.disabled_strategies), "rejects": dict(sorted(self.st.rejects.items(), key=lambda x: -x[1])[:12]),
                "updated": time.time()}
