"""Postgres persistence (asyncpg). Writes are queued and flushed by a background task, so the trading path never waits
on the database. Without DATABASE_URL everything stays in memory (fine for a local test run)."""
from __future__ import annotations

import asyncio
import json
import logging
from datetime import datetime, timezone
from pathlib import Path

log = logging.getLogger("db")
MIGRATIONS = Path(__file__).resolve().parents[2] / "migrations"


def _ts(t: float | None):
    return datetime.fromtimestamp(t, tz=timezone.utc) if t else None


class Store:
    def __init__(self, url: str):
        self.url = url
        self.pool = None
        self.q: asyncio.Queue = asyncio.Queue(maxsize=20000)
        self.mem_closed: list[dict] = []
        self.mem_signals: list[dict] = []
        self.mem_kv: dict[str, object] = {}
        self.errors = 0

    @property
    def kind(self) -> str:
        return "postgres" if self.pool else "memory"

    async def open(self):
        if not self.url:
            log.warning("DATABASE_URL not set — trades are kept in memory only")
            return
        import asyncpg
        self.pool = await asyncpg.create_pool(self.url, min_size=1, max_size=4, command_timeout=10)
        async with self.pool.acquire() as c:
            for f in sorted(MIGRATIONS.glob("*.sql")):
                await c.execute(f.read_text())

    async def writer(self):
        while True:
            sql, args = await self.q.get()
            if not self.pool:
                continue
            try:
                async with self.pool.acquire() as c:
                    await c.execute(sql, *args)
            except Exception as e:
                self.errors += 1
                log.warning("db write failed: %s", e)

    def _put(self, sql: str, *args):
        try:
            self.q.put_nowait((sql, args))
        except asyncio.QueueFull:
            self.errors += 1

    # ── writes ──
    def save_position(self, p, mode: str, claude: dict | None = None, broker_charges: float | None = None):
        legs = [{"symbol": l.ins.symbol, "side": l.side, "qty": l.qty, "entry": l.entry_price, "exit_qty": l.exit_qty,
                 "exit": l.exit_price} for l in p.legs]
        row = {"id": p.id, "mode": mode, "strategy": p.strategy, "underlying": p.underlying,
               "symbol": " / ".join(l.ins.symbol for l in p.legs), "side": p.side, "product": p.product,
               "qty": max((l.qty for l in p.legs), default=0), "entry": p.entry_price,
               "exit": (sum(l.exit_price for l in p.legs) if not p.is_combo else None) if p.legs[0].exit_qty else None,
               "status": p.status, "gross": p.gross, "charges": p.charges_actual, "net": p.net, "reason": p.reason,
               "exit_reason": p.exit_reason, "opened_at": p.opened_at, "closed_at": p.closed_at, "charges_est": p.charges_est,
               "capital": p.capital, "plan": p.plan_summary}
        if p.status == "CLOSED":
            self.mem_closed.insert(0, row)
            del self.mem_closed[500:]
        self._put("""INSERT INTO positions (id, mode, strategy, underlying, symbol, side, product, qty, entry_price, exit_price,
                       initial_stop, target, status, reason, exit_reason, gross, charges_est, charges_actual, charges_broker,
                       slippage_est, net, capital, plan, claude, legs, opened_at, closed_at)
                     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27)
                     ON CONFLICT (id) DO UPDATE SET status=EXCLUDED.status, qty=EXCLUDED.qty, entry_price=EXCLUDED.entry_price,
                       exit_price=EXCLUDED.exit_price, exit_reason=EXCLUDED.exit_reason, gross=EXCLUDED.gross,
                       charges_actual=EXCLUDED.charges_actual, charges_broker=COALESCE(EXCLUDED.charges_broker, positions.charges_broker),
                       net=EXCLUDED.net, legs=EXCLUDED.legs, closed_at=EXCLUDED.closed_at,
                       claude=COALESCE(EXCLUDED.claude, positions.claude)""",
                  p.id, mode, p.strategy, p.underlying, row["symbol"], p.side, p.product, row["qty"], p.entry_price, row["exit"],
                  p.initial_stop, p.target, p.status, p.reason, p.exit_reason, p.gross, p.charges_est, p.charges_actual,
                  broker_charges, p.slippage, p.net, p.capital, json.dumps(p.plan_summary, default=str),
                  json.dumps(claude) if claude else None, json.dumps(legs), _ts(p.opened_at), _ts(p.closed_at) if p.closed_at else None)

    def save_order(self, o, mode: str):
        self._put("""INSERT INTO orders (client_ref, broker_id, position_id, mode, symbol, side, qty, price, purpose, status, filled,
                       avg_price, charges, ack_ms, first_fill_ms, reprices, reject_reason)
                     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
                     ON CONFLICT (client_ref) DO UPDATE SET broker_id=EXCLUDED.broker_id, price=EXCLUDED.price, status=EXCLUDED.status,
                       filled=EXCLUDED.filled, avg_price=EXCLUDED.avg_price, charges=EXCLUDED.charges, ack_ms=EXCLUDED.ack_ms,
                       first_fill_ms=EXCLUDED.first_fill_ms, reprices=EXCLUDED.reprices, reject_reason=EXCLUDED.reject_reason,
                       updated_at=now()""",
                  o.client_ref, o.broker_id, o.position_id, mode, o.ins.symbol, o.side, o.qty, o.price, o.purpose, o.status,
                  o.filled, o.avg_price, o.charges, o.ack_ms, o.first_fill_ms, o.reprices, o.reject_reason)

    def signal(self, strategy: str, symbol: str, decision: str, reason: str, plan: dict):
        self.mem_signals.insert(0, {"strategy": strategy, "symbol": symbol, "decision": decision, "reason": reason, "plan": plan,
                                    "at": datetime.now(timezone.utc).isoformat()})
        del self.mem_signals[200:]
        self._put("INSERT INTO signals (strategy, symbol, decision, reason, plan) VALUES ($1,$2,$3,$4,$5)",
                  strategy, symbol, decision, reason, json.dumps(plan, default=str))

    def audit(self, kind: str, message: str, data: dict | None = None):
        log.info("[%s] %s", kind, message)
        self._put("INSERT INTO audit_log (kind, message, data) VALUES ($1,$2,$3)", kind, message,
                  json.dumps(data or {}, default=str))

    async def kv_get(self, k: str, default=None):
        if not self.pool:
            return self.mem_kv.get(k, default)
        async with self.pool.acquire() as c:
            v = await c.fetchval("SELECT v FROM kv WHERE k=$1", k)
        return json.loads(v) if v is not None else default

    def kv_put(self, k: str, v):
        self.mem_kv[k] = v
        self._put("INSERT INTO kv (k, v) VALUES ($1,$2) ON CONFLICT (k) DO UPDATE SET v=EXCLUDED.v, updated_at=now()", k, json.dumps(v, default=str))

    # ── reads (dashboard / reports / calibration) ──
    async def closed(self, since: datetime | None = None, limit: int = 500, mode: str | None = None) -> list[dict]:
        if not self.pool:
            return self.mem_closed[:limit]
        q = "SELECT * FROM positions WHERE status='CLOSED'"
        args: list = []
        if since:
            args.append(since); q += f" AND closed_at >= ${len(args)}"
        if mode:
            args.append(mode); q += f" AND mode = ${len(args)}"
        q += f" ORDER BY closed_at DESC LIMIT {int(limit)}"
        async with self.pool.acquire() as c:
            rows = await c.fetch(q, *args)
        return [dict(r) for r in rows]

    async def strategy_outcomes(self, mode: str, days: int = 90) -> dict[str, list[float]]:
        """Net P&L per closed trade per strategy — used to calibrate win probabilities out of sample."""
        if not self.pool:
            out: dict[str, list[float]] = {}
            for r in self.mem_closed:
                out.setdefault(r["strategy"], []).append(r["net"])
            return out
        async with self.pool.acquire() as c:
            rows = await c.fetch("SELECT strategy, net FROM positions WHERE status='CLOSED' AND mode=$1 AND closed_at > now() - make_interval(days => $2)",
                                 mode, days)
        out = {}
        for r in rows:
            out.setdefault(r["strategy"], []).append(float(r["net"] or 0))
        return out
