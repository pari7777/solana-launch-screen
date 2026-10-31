# Angel Quant AI — NSE multi-strategy engine on Angel One SmartAPI

Paper trading by default. Real market data from Angel One. Every trade must cover **all** costs before it is placed,
one central risk manager can veto anything, and Claude reviews trades as an advisor that can only say *no*.

> No strategy here is guaranteed to make money. SEBI's FY25 study found ~91% of individual F&O traders lost money.
> Treat the paper record as the only evidence, and require it before going live (this is enforced in code).

## What runs

| Layer | What it does | File |
|---|---|---|
| Login | MPIN + TOTP login, token refresh, re-login every day at 08:30 IST (tokens expire 00:00 IST) | `app/broker/rest.py` |
| Rate limiter | One token bucket per endpoint group; orders ≤ 8/s (SmartAPI limit 10/s) | `app/broker/ratelimit.py` |
| Market data | SmartAPI WebSocket V2, SnapQuote mode (5-level depth), heartbeat, auto-reconnect + resubscribe | `app/broker/ws.py` |
| Instruments | Scrip master downloaded once per day; lot sizes, ticks, expiries, strikes from the file | `app/broker/instruments.py` |
| Candles | 1-minute bars built from ticks in memory; seeded from historical API at start | `app/market/feed.py` |
| Regime | Bull / bear / sideways / vol-expansion / reversal from NIFTY, India VIX, breadth, gaps, opening range | `app/market/regime.py` |
| Strategies | Stock ORB, VWAP trend pullback, VWAP reversion; NIFTY/BANKNIFTY/FINNIFTY option momentum; bull-call / bear-put debit spreads; iron condor | `app/strategies/` |
| Cost check | Brokerage, STT, exchange, SEBI, stamp, IPFT, GST, slippage on entry **and** exit; net reward, R:R, expected value | `app/strategies/base.py`, `app/costs/charges.py` |
| Risk | Per-trade risk, open positions, daily/weekly loss, drawdown, consecutive losses, per-underlying and premium exposure, duplicates, stale data, margin, safe mode | `app/risk/manager.py` |
| Allocation | Family budgets (stock intraday / option scalps / option directional / swing / 20% cash), cut on negative expectancy; calibrated win rates | `app/risk/allocation.py` |
| Claude | Approve/veto with a reason; market note every 15 min; hourly call budget; never sizes or places orders | `app/ai/claude.py` |
| Orders | LIMIT only (SEBI: no market/IOC for algos), ORDER_TAG on every order, passive-aggressive entry repricing, never above max price, partial fills, combos long-legs-first | `app/execution/oms.py` |
| Paper broker | Latency, simulated rejections, fills only against displayed depth, partial fills, circuit limits, full charges | `app/execution/paper.py` |
| Live broker | Order-book polling, position reconciliation every 30 s (mismatch → no new entries) | `app/execution/live.py` |
| Profit booking | Trailing from 1R, partial at 1.5R, stop only tightens, intraday square-off 15:12 | `app/execution/oms.py` |
| Backtest | Same strategy code on 1-min history, next-bar fills, costs, walk-forward | `app/backtest/engine.py`, `scripts/backtest.py` |
| Dashboard | Equity, gross → charges → net, positions, signals, regime, risk use, latency, Claude, buttons, CSV/Excel reports | `app/static/dashboard.html` |

## Going live — every gate must pass

1. `TRADING_MODE=live`
2. `LIVE_TRADING_CONFIRM=YES` (owner approval)
3. `STATIC_IP_REGISTERED=true` — since 1 April 2026 Angel One accepts API orders only from your **registered static IP**
   (primary + one backup, changeable once a week). Railway's static outbound IPs (Pro plan) are shared with other
   customers and spread over three addresses, so they may not be accepted. A small VPS with its own dedicated IP is the
   reliable route; run `docker compose up -d` there.
4. Paper track record: ≥ 100 paper trades in 90 days, positive net P&L, profit factor ≥ 1.2 (`ACCEPTANCE_*` settings).

Stay under 10 orders/second per segment (enforced) so no exchange algo registration is needed; above that SEBI requires
the algo to be registered through the broker.

## Live server with a static IP (AWS Lightsail Mumbai or similar)

1. Create an Ubuntu 24.04 server in Mumbai, attach a static IP, open ports 22, 80 and 443.
2. In the server's browser SSH window run:
   `curl -fsSL https://raw.githubusercontent.com/pari7777/solana-launch-screen/main/angel-quant-ai/scripts/vps-setup.sh | sudo bash`
   It asks for your Angel One details (stored only in `/opt/angel-quant/angel-quant-ai/.env`, mode 600), starts the
   bot, Postgres, Redis and an HTTPS proxy, and prints the dashboard link, password and IP to register.
3. Register that IP as the primary static IP of your SmartAPI app.
4. Code updates: push to GitHub → the server pulls them within 5 minutes, but only outside 09:00–15:40 IST on weekdays
   (`sudo FORCE=1 aq-update` deploys immediately).

## Settings

All settings are environment variables — see `.env.example`. Secrets go only into Railway → Variables (or `.env` on a
VPS), never into code or chat.

## Known limits

- Option strategies cannot be backtested on expired contracts (SmartAPI history covers listed contracts only); they are
  validated by live paper trading.
- Swing/delivery engine, ML regime classifier and bear-market short-selling scanner are not built yet (switch exists,
  off by default).
- Exchange holidays: add them to `config/holidays.txt` each year.
- Charge rates are in `config/charges.json` and are cross-checked against Angel One's `estimateCharges` API after every
  trade; a >10% gap is flagged on the dashboard.

## Run

```bash
pip install -r requirements-dev.txt && pytest          # tests
python -m app.main                                     # dashboard on :8000
python -m scripts.backtest --days 60 --strategy stock_orb
```
