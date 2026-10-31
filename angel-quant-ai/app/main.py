"""Entry point:  python -m app.main"""
from __future__ import annotations

import asyncio
import logging
import secrets
import sys

import uvicorn

from app.api.server import build_app
from app.config import get_settings
from app.engine import Engine


def main():
    s = get_settings()
    logging.basicConfig(level=getattr(logging, s.log_level.upper(), logging.INFO), stream=sys.stdout,
                        format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    # httpx logs full request URLs at INFO, which can include session tokens — keep it quiet
    for noisy in ("httpx", "httpcore"):
        logging.getLogger(noisy).setLevel(logging.WARNING)
    pw = s.dashboard_password.get_secret_value()
    if not pw:
        pw = secrets.token_urlsafe(9)
        print(f"\n  ⚠️  DASHBOARD_PASSWORD is not set — temporary password for this run: {pw}\n", flush=True)
    engine = Engine(s)
    app = build_app(engine, pw)
    app.router.on_startup.append(lambda: asyncio.get_running_loop().create_task(engine.start()) and None)

    banner = [
        "  ███ angel-quant-ai ███",
        f"  Mode        {engine.mode.upper()}" + ("" if engine.mode == "live" else "  (live blocked: " + "; ".join(s.live_blockers()) + ")"),
        f"  Strategies  {', '.join(x.name for x in engine.strategies)}",
        f"  Claude      {'on · ' + s.claude_model if engine.claude.enabled else 'off (set ANTHROPIC_API_KEY)'}",
        f"  Risk        {s.max_risk_per_trade_pct}% risk/trade · daily stop {s.max_daily_loss_pct}% · max {s.max_open_positions} positions",
    ]
    print("\n".join(banner), flush=True)
    uvicorn.run(app, host="0.0.0.0", port=s.port, log_level="warning")


if __name__ == "__main__":
    main()
