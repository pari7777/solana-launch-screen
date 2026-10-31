"""FastAPI backend: dashboard, live state over WebSocket, control buttons, reports. Protected by HTTP basic auth
(any username + DASHBOARD_PASSWORD; a temporary password is printed in the logs if none is set)."""
from __future__ import annotations

import asyncio
import io
import secrets
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path

from fastapi import Depends, FastAPI, HTTPException, Request, WebSocket, WebSocketDisconnect, status
from fastapi.responses import HTMLResponse, JSONResponse, StreamingResponse
from fastapi.security import HTTPBasic, HTTPBasicCredentials

from app.clock import market_open, now_ist
from app.engine import Engine

STATIC = Path(__file__).resolve().parents[1] / "static"
security = HTTPBasic(auto_error=False)


def build_app(engine: Engine, password: str) -> FastAPI:
    app = FastAPI(title="Angel Quant AI", docs_url=None, redoc_url=None)

    def auth(creds: HTTPBasicCredentials | None = Depends(security)):
        if not creds or not secrets.compare_digest(creds.password.encode(), password.encode()):
            raise HTTPException(status.HTTP_401_UNAUTHORIZED, headers={"WWW-Authenticate": 'Basic realm="angel-quant-ai"'})
        return True

    def same_origin(req: Request):
        o = req.headers.get("origin")
        if o and req.headers.get("host") and not o.endswith(req.headers["host"]):
            raise HTTPException(403, "cross-origin request blocked")

    @app.get("/health")
    async def health():
        return {"ok": True, "status": engine.status, "mode": engine.mode}

    @app.get("/", response_class=HTMLResponse, dependencies=[Depends(auth)])
    async def index():
        return (STATIC / "dashboard.html").read_text()

    @app.get("/api/state", dependencies=[Depends(auth)])
    async def state():
        return JSONResponse(snapshot(engine))

    @app.websocket("/ws")
    async def ws(sock: WebSocket):
        # browsers send the basic-auth credentials of the page with the upgrade request
        import base64
        h = sock.headers.get("authorization", "")
        ok = False
        if h.lower().startswith("basic "):
            try:
                ok = secrets.compare_digest(base64.b64decode(h[6:]).decode().split(":", 1)[1].encode(), password.encode())
            except Exception:
                ok = False
        if not ok and sock.query_params.get("k") and secrets.compare_digest(sock.query_params["k"].encode(), password.encode()):
            ok = True
        if not ok:
            await sock.close(code=4401)
            return
        await sock.accept()
        try:
            while True:
                await sock.send_json(snapshot(engine))
                await asyncio.sleep(1)
        except (WebSocketDisconnect, RuntimeError):
            return

    @app.post("/api/control/{action}", dependencies=[Depends(auth), Depends(same_origin)])
    async def control(action: str):
        if action == "emergency":
            return {"msg": await engine.emergency()}
        return {"msg": engine.control(action)}

    @app.post("/api/exit/{pid}", dependencies=[Depends(auth), Depends(same_origin)])
    async def exit_pos(pid: int):
        return {"msg": await engine.exit_position(pid)}

    @app.get("/api/report/{kind}", dependencies=[Depends(auth)])
    async def report(kind: str, fmt: str = "csv", days: int = 1):
        from app.reports.export import build_report
        since = datetime.now(timezone.utc) - timedelta(days=max(1, min(days, 400)))
        rows = await engine.store.closed(since=since, limit=5000, mode=engine.mode)
        data, mime, name = build_report(kind, rows, fmt)
        return StreamingResponse(io.BytesIO(data), media_type=mime, headers={"Content-Disposition": f'attachment; filename="{name}"'})

    return app


def snapshot(e: Engine) -> dict:
    eq = e.equity()
    pos = []
    for p in e.oms.positions.values():
        if p.is_open or (p.closed_at and time.time() - p.closed_at < 60):
            pos.append({"id": p.id, "strategy": p.strategy, "symbol": " / ".join(l.ins.symbol for l in p.legs), "side": p.side,
                        "qty": p.qty or p.target_qty, "entry": round(p.entry_price, 2), "mark": round(p.mark, 2), "stop": round(p.stop, 2),
                        "target": round(p.target, 2), "status": p.status, "trailing": p.trailing, "partial": p.partial_done,
                        "unrealized": round(p.unrealized(), 2), "reason": p.reason, "exit_reason": p.exit_reason,
                        "claude": e.claude_by_pos.get(p.id)})
    closed_today = [r for r in e.store.mem_closed if r.get("closed_at") and datetime.fromtimestamp(r["closed_at"], tz=timezone.utc).astimezone(now_ist().tzinfo).date() == now_ist().date()]
    gross_today = sum(r["gross"] or 0 for r in closed_today)
    charges_today = sum(r["charges"] or 0 for r in closed_today)
    lat = e.rest.latency.summary()
    sig_lat = sorted(e.signal_latency_ms)
    return {
        "mode": e.mode, "status": e.status, "running": e.running, "market_open": market_open(), "time": now_ist().strftime("%H:%M:%S"),
        "live_blockers": e.s.live_blockers() + ([f"acceptance: {e.acceptance_failed}"] if e.acceptance_failed else []),
        "capital": round(e.capital, 2), "equity": round(eq, 2), "margin_available": e.margin_available,
        "used_capital": round(sum(p.capital for p in e.oms.positions.values() if p.is_open), 2),
        "today": {"gross": round(gross_today, 2), "charges": round(charges_today, 2), "net": round(gross_today - charges_today, 2),
                  "unrealized": round(sum(p.unrealized() for p in e.oms.positions.values()), 2), "trades": len(closed_today)},
        "realized_total": round(e.realized_total, 2),
        "positions": pos, "closed": e.store.mem_closed[:30],
        "signals": e.store.mem_signals[:40],
        "regime": e.regime.as_dict(), "claude": {"enabled": e.claude.enabled, "stats": e.claude.stats, "note": e.claude.last_note,
                                                  "recent": e.claude.recent[:10], "model": e.s.claude_model},
        "risk": e.risk.snapshot(eq), "strategies": [{"name": s.name, "enabled": s.name not in e.risk.st.disabled_strategies} for s in e.strategies],
        "stats": e.stats.table(),
        "feed": {"state": e.stream.state, "ticks": e.md.tick_count, "subscribed": len(e.subscribed), "reconnects": e.stream.reconnects,
                 "last_tick_age": round(time.time() - e.md.last_tick_at, 1) if e.md.last_tick_at else None},
        "latency": {"rest": lat, "rest_calls": e.rest.latency.calls, "rest_errors": e.rest.latency.errors,
                    "signal_to_order_ms_p50": round(sig_lat[len(sig_lat) // 2], 1) if sig_lat else None,
                    "order_ack_ms": [round(o.ack_ms, 0) for o in list(e.oms.orders.values())[-10:] if o.ack_ms]},
        "instruments": {"source": e.im.source, "count": len(e.im.by_token)},
        "db": e.store.kind, "events": e.events[:60],
    }
