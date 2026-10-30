# 🎯 solana-launch-screen

A launch-screening engine for new **pump.fun** coins on Solana that runs **on your laptop**. It applies a **120-rule** screen to each new coin within **6 seconds**. It then emits your decision JSON, trades on **paper**, through your **linked wallet** (Phantom / Solflare), or through a **local bot wallet**, and exits on a **35 % trailing drawdown of net liquidation value**.

```
 Solana RPC logs (or PumpPortal) ─► ingest: reconnect · dedupe · (signature, instruction_index, slot)
        │
        ▼
 decoders: pump.fun CreateEvent / TradeEvent · bonding curve · PumpSwap pool
        │
        ▼  0–6 s, all in parallel                                                     ┌─► terminal (colour lines)
 data: mint & curve accounts · deployer history + funder · early-buyer funders        │
       · pump.fun history · SOL price · priority fees · RPC slot lag                  ├─► dashboard  http://localhost:8787
        │                                                                             │
        ▼                                                                             ├─► Telegram · webhook (e.g. n8n)
 graph: funding graph → linked wallets, shared-funder clusters, snipers, concentration│
        │                                                                             └─► Postgres: launches · rule_results
        ▼                                                                                  · wallet_edges · decision_history
 rules: R001–R120 + X001 (declarative) → TRIGGERED / PASS / MISSING / NOT_APPLICABLE        · provider_health · positions
        │
        ▼
 engine: hard gates → weighted score (30/25/15/10/10/10) → REJECT · WAIT · MONITOR · SELECT_FOR_REVIEW
        │                                   WAIT / MONITOR re-checked at 15 s and 30 s (stage 2)
        ▼
 trade:  paper │ browser wallet (you approve) │ bot keypair  ──►  signing guard  ──►  PENDING → OPEN → EXIT_PENDING → CLOSED
```

---

## 1 · Install on your laptop (about 10 minutes)

**You need:** Node.js 20 or newer, and a free Helius key.

| Step | Windows | macOS |
|---|---|---|
| Install Node.js | Download the **LTS** installer from **nodejs.org** and run it | Same, or `brew install node` |
| Open a terminal in the folder | Unzip, open the folder, type `cmd` in the address bar, press Enter | Unzip, right-click the folder, choose **New Terminal at Folder** |
| Install | `npm install` | `npm install` |
| Create your settings | `copy .env.example .env` | `cp .env.example .env` |

Then:

1. Get a **free Helius key** at **helius.dev**. Open `.env` in Notepad or TextEdit and paste your key into **both** `RPC_URL` and `RPC_WSS_URL`.
2. Run **`npm run doctor`**. It checks Node, the database, the RPC, the live stream and your wallet, and tells you how to fix anything that fails.
3. Run **`npm start`**. Decisions stream in the terminal. Open **http://localhost:8787** for the dashboard.
4. Press **Ctrl + C** to stop. Everything is saved in `./data`, and restarting continues where you left off.

The database is **embedded Postgres** with nothing to install. To use your own Postgres instead, set `DATABASE_URL=postgres://…` in `.env`. Your schema is applied automatically from `migrations/`.

---

## 1b · Or run it 24/7 on Railway

Your laptop can sleep; Railway keeps the bot running. Everything else (modes, dashboard, rules, exits) works the same.

1. **GitHub** → New **private** repository → upload all files from the zip (the `node_modules` folder is not included — Railway installs it).
2. **railway.com** → **New Project → Deploy from GitHub repo** → pick the repo. `railway.json` tells Railway how to build, start and health-check it.
3. In the same project: **+ New → Database → PostgreSQL**. Your schema is created automatically on first start.
4. Click your app service → **Variables → Raw Editor** → paste `railway.env.example`, fill in your Helius key and a **DASHBOARD_PASSWORD** → Update.
5. **Settings → Networking → Generate Domain** → open it, log in with any username + your password.
6. **Deployments → View Logs** shows the same colour decision stream as the laptop terminal.

Notes for Railway:
- The dashboard is public on the internet there, so it **always requires the password** (if you forget to set one, a temporary one is printed in the logs).
- **Browser-wallet mode works from the Railway URL** — open it in the browser where Phantom/Solflare is installed and click *Connect wallet*.
- **Keypair mode:** put the bot wallet's private key in the `BOT_PRIVATE_KEY` variable (never in GitHub). Use a separate wallet holding only what you can lose.
- Keep **1 replica** — two copies would both trade.
- A bot running 24/7 needs a paid Railway plan once the trial credit runs out.

---

## 2 · Choose how it buys (`MODE` in `.env`)

| Mode | Who signs | When to use |
|---|---|---|
| `paper` *(default)* | Nobody. Fake SOL, real launches, real curve prices with a 5 % slippage penalty | First 2+ weeks |
| `browser` | **You, in Phantom or Solflare.** Open the dashboard, click **Connect wallet**, and every buy and sell pops up in your wallet for approval | You want to stay in control of each trade |
| `keypair` | A **separate bot wallet** stored only on this laptop signs automatically | Fully automatic trading |

**Browser-wallet linking:** keep the dashboard tab open. When a coin is selected, or a trailing-drawdown exit fires, your wallet opens automatically for approval. You can untick this and press **Approve in wallet** yourself. Your private key never leaves the wallet extension.

**Bot keypair:**
1. Run `npm run wallet:new`. This creates `bot-wallet.json` (a new wallet) and prints its address.
2. Send it a small amount of SOL.
3. Set `MODE=keypair` and `CONFIRM_LIVE=YES`. Without `CONFIRM_LIVE=YES`, keypair mode still trades on paper.

**Signing guard (R087–R092):** every swap transaction is decoded **before** it is signed, in both wallet modes. It is refused if any of these is true:
- it calls an unknown program
- it is not paid by your wallet
- it asks for extra signers
- it contains a token approval or authority change
- it sends more than a small fee in SOL directly

---

## 3 · The decision (exact output format)

Every decision is printed in the terminal, shown on the dashboard, stored in `decision_history`, and served at `GET /api/decision/<mint>`:

```json
{
  "chain": "SOLANA",
  "token_address": "<mint>",
  "launch_timestamp": "2026-10-29T18:21:44.536Z",
  "decision_deadline_seconds": 6,
  "decision": "WAIT",
  "risk_score": null,
  "confidence": "LOW",
  "data_completeness": 0.42,
  "top_selection_reasons": [],
  "top_rejection_reasons": [
    { "rule_id": "R011", "reason": "Token program identity unverified", "severity": "HIGH", "evidence": "token accounts not readable (pending)" }
  ],
  "launch_wallet": { "deployer": "…", "funding_source": "…", "initial_liquidity_provider": "<bonding curve>",
                     "creator_token_share_pct": 1.05, "linked_wallet_clusters": [], "previous_launches": [], "privileged_authorities": [] },
  "market": { "liquidity_usd": 412.5, "buy_price_impact_pct": 0.16, "sell_price_impact_pct": 0.16,
              "estimated_round_trip_cost_pct": 4.48, "sell_simulation": "NOT_VERIFIED" },
  "risk_rules_checked": 96,
  "risk_rules_triggered": [],
  "missing_data": ["Token and bonding-curve accounts", "Deployer wallet history"],
  "auto_buy_allowed": false
}
```

How some fields behave:
- **`risk_score`** is the weighted 0–100 score (higher means safer). It is `null` while the decision is WAIT.
- **`rule_id`** uses the registry IDs (`R001`–`R120`, `X001`), which match `rule_results.rule_id`.
- **`risk_rules_checked`** counts rules that reached a verdict: PASS, TRIGGERED or not applicable. Rules still missing evidence are not counted.
- **`sell_simulation`** is `MODELED_PASS` or `FAILED` from bonding-curve math combined with a token-permission check. You can't simulate selling a token you don't hold yet.
- **`initial_liquidity_provider`** is the bonding-curve account. On pump.fun the protocol provides the initial liquidity, not the creator.
- **Hard gates come first.** A single REJECT rule decides, whatever the score.
- **Stage 2:** WAIT and MONITOR coins are re-checked at 15 s and 30 s. If they are still unresolved at the last re-check, they become REJECT (`S000`).

---

## 4 · The 120 rules (`src/rules/rules-001-120.ts`)

Each rule uses your declarative format, for example:

```json
{ "rule_id": "R015", "version": 1, "category": "liquidity_exit", "severity": "CRITICAL",
  "applies_to": ["pump_bonding_curve", "pumpswap"], "condition": "sell_simulation_failed_due_to_restriction",
  "evidence_required": ["simulation_result", "transaction_context", "curve_or_pool_state"],
  "on_trigger": "REJECT", "on_missing_evidence": "WAIT", "enabled": true }
```

How the 120 rules divide up:

| Group | How it's handled |
|---|---|
| **Enforced on pump.fun** | Contract permissions (mint/freeze authority, Token-2022 hooks, fees, delegates, pausable). Program identity. Reserves cross-check. Price impact, round trip and dump-stress. Deployer history and funder. Linked, clustered and sniper wallets. Concentration. Wash trading. Volatility. RPC lag. Congestion. Impersonation. |
| **`applies_to: generic_amm`** | LP locks, vesting, unlocks and audits. These can't exist on a pump.fun bonding curve, so they report `NOT_APPLICABLE` there. |
| **`applies_to: signing`** | R087–R092, enforced by the signing guard when a transaction is built. |
| **Needs data beyond 6 s** | Failed-sell history, volume reconciliation, phishing links and audits. These report `MISSING`, with `on_missing_evidence: IGNORE`, so they never block a decision. |

**Tune without code:** copy `config/rules-overrides.example.json` into `config/rules-overrides.json`. You can change any rule's `params`, `enabled`, `severity`, `on_trigger` or `on_missing_evidence`. Restart, and run `npm run doctor` to validate.

The bot also **learns**:
- A deployer that sells 70 % or more of its own bag is flagged `RUGGER`.
- The wallet that funded it is flagged `RUG_FUNDER`, which catches the operator's next wallet (R028, R031, R097).

---

## 5 · Exits: trailing drawdown on net liquidation value

```
on_position_confirmed:  high_water_value = net_liquidation_value;  status = OPEN
on_market_update:       raise high_water_value if NLV is higher;  save
                        if NLV ≤ high_water_value × (1 − 0.35):  status = EXIT_PENDING → request_full_exit
```

**Net liquidation value** is the SOL you would actually receive by selling everything now, after curve price impact, fees and the priority fee. It is updated on every trade of the coin. After migration it uses the PumpSwap pool reserves.

Insider events also request a full exit:
- the deployer sells
- a linked wallet sells
- the largest holder dumps 50 % or more of its bag

There is also a 10-minute maximum hold. A failed exit stays `EXIT_PENDING` and is retried every 3 s. Fixed take-profit and stop-loss exist but are off by default (`TAKE_PROFIT_PCT`, `STOP_LOSS_PCT`).

---

## 6 · Commands

| Command | What it does |
|---|---|
| `npm start` | Run the engine, terminal output and dashboard |
| `npm run doctor` | Check setup and connections |
| `npm run wallet:new` | Create a separate bot wallet file |
| `npm test` | 30 tests: decoders, rules, decisions and trailing exit, a full replay through Postgres, and latency |
| `npm run typecheck` | TypeScript check |

**API** (localhost only):
- `/api/status`
- `/api/decisions?limit=50&decision=SELECT_FOR_REVIEW`
- `/api/decision/<mint>`
- `/api/rule-results/<mint>`
- `/api/rules`

**Webhook:** set `OUTPUT_WEBHOOK_URL` (for example your n8n workflow) to receive the decision JSON for `WEBHOOK_DECISIONS`.

---

## 7 · Honest limits
- **Six seconds is a deadline, not proof.** A first-time scammer on an aged, exchange-funded wallet passes the wallet checks. A SELECT is a screening result, not a safety guarantee.
- **Professional snipers buy in the launch block.** You enter 3–6 s later, at a higher price. Paper mode adds 5 % slippage for this.
- **Funder clustering is a heuristic.** Wallets with 1,000+ transactions inside an hour are treated as exchanges and ignored.
- **The pump.fun history check uses an unofficial endpoint.** If it fails, that check is skipped.
- **Trades go through PumpPortal's transaction API**, which charges a small fee. The signing guard checks everything it returns.
- **Keep the laptop awake** while trading: plugged in, with sleep disabled. A closed lid means missed exits.
- In India, crypto gains are taxed at 30 % plus 1 % TDS. This is software, not financial advice.
