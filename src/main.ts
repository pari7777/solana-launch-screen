/**
 * solana-launch-screen — entry point.  npm start
 * Wires the stream → screener (120 rules, two stages) → positions (paper / browser wallet / bot keypair),
 * with the terminal, the local dashboard, Telegram and an optional webhook as outputs.
 */
import { config, isLiveKeypair, isPaper } from "./config";
import { openDb } from "./data/db";
import { MarketData } from "./data/quotes";
import { Rpc } from "./data/rpc";
import { Store } from "./data/store";
import { WalletTracer } from "./data/wallet-history";
import { startDashboard } from "./alerts/dashboard";
import { telegram, webhook } from "./alerts/telegram";
import { banner, printDecision, printEvent, printStatus } from "./alerts/terminal";
import { Screener } from "./engine/screener";
import { LaunchStream } from "./ingest/stream";
import { loadRules } from "./rules/registry";
import { Executor } from "./trade/executor";
import { PositionManager } from "./trade/positions";
import { loadKeypair } from "./trade/wallet";

async function main() {
  const rules = loadRules();
  const sql = await openDb();
  const store = new Store(sql); await store.init();
  const rpc = new Rpc();
  let lastHealth = 0;
  rpc.onHealth = (ok) => { if (!ok || Date.now() - lastHealth > 10_000) { lastHealth = Date.now(); store.health("rpc", ok).catch(() => {}); } };
  const tracer = new WalletTracer(rpc);
  tracer.onTrace = (t) => { store.addFundingEdge(t).catch(() => {}); };
  const market = new MarketData(rpc);
  market.onSlot = (slot) => store.health("rpc_slot", true, slot).catch(() => {});
  market.start();

  let keypair = null, wallet: string | null = null;
  if (config.mode === "keypair") { keypair = loadKeypair(); wallet = keypair.publicKey.toBase58(); }
  const exec = config.mode === "paper" ? null : new Executor(rpc, keypair);
  const positions = new PositionManager(store, rpc, exec, wallet);
  positions.onEvent = (m) => { printEvent(m); telegram(m); };
  const held = await positions.load();

  let stream: LaunchStream;
  const screener = new Screener(rpc, store, tracer, market, {
    canAutoBuy: () => positions.canAutoBuy(),
    onSelected: (s) => positions.onSelected(s),
    onRecord: (r) => {
      printDecision(r);
      const o = r.output;
      if (o.decision === "SELECT_FOR_REVIEW")
        telegram(`🎯 SELECT $${r.meta.symbol} · score ${o.risk_score} (${o.confidence}) · ${r.meta.action}\nhttps://pump.fun/coin/${o.token_address}`);
      if (config.webhookUrl && (config.webhookDecisions.includes("ALL") || config.webhookDecisions.includes(o.decision))) webhook(o);
    },
    watchMint: (m) => stream.watchMint(m),
    unwatchMint: (m) => { if (!positions.positions.has(m)) stream.unwatchMint(m); },
    watchWallet: (w) => stream.watchWallet(w),
    streamOk: () => stream.state === "connected",
  });
  await screener.loadStats();

  stream = new LaunchStream({
    onLaunch: (l) => { market.streamSlot = l.slot || market.streamSlot; screener.onLaunch(l).catch((e) => console.error("launch", e)); },
    onTrade: (t) => { if (t.slot) market.streamSlot = Math.max(market.streamSlot ?? 0, t.slot); screener.onTrade(t); positions.onTrade(t); },
    onState: (provider, state, ok, slot) => {
      printEvent(`${provider}: ${state}`);
      store.health(provider, ok, slot ?? null, ok ? "OK" : state.slice(0, 60)).catch(() => {});
    },
  });
  stream.start();
  for (const m of held) stream.watchMint(m);

  const url = `http://${config.host === "0.0.0.0" ? "localhost" : config.host}:${config.port}`;
  startDashboard({
    status: async () => {
      const pnl = await store.pnlSummary();
      const ms = [...screener.decisionMs].sort((a, b) => a - b);
      const hits = Object.entries(screener.stats.ruleHits).sort((a, b) => b[1] - a[1]).slice(0, 14)
        .map(([id, n]) => ({ id, n, title: rules.find((r) => r.rule_id === id)?.title ?? id }));
      return {
        mode: config.mode, live: isLiveKeypair(), paper: isPaper(), autoBuy: config.autoBuy, paused: config.paused, wallet,
        browserWallet: positions.browserWallet, stream: { provider: stream.provider, state: stream.state },
        rpc: rpc.stats(), market: { solUsd: market.solUsd, priorityFee: market.priorityFeeMicroLamports, rpcLagSlots: market.rpcLagSlots },
        scanned: screener.stats.scanned, stage1: screener.stats.stage1, final: screener.stats.final, inReview: screener.watch.size,
        decisionMs: { p50: ms[Math.floor(ms.length / 2)] ?? null, p90: ms[Math.floor(ms.length * 0.9)] ?? null },
        ruleHits: hits, records: screener.records,
        positions: [...positions.positions.values()].map((p) => ({ mint: p.mint, symbol: p.symbol, mode: p.mode, status: p.status, venue: p.venue,
          cost: p.costSol, nlv: p.netLiquidationValue, hwm: p.highWaterValue, exitAt: p.highWaterValue * (1 - config.trailingDrawdown),
          ddPct: p.highWaterValue ? (1 - p.netLiquidationValue / p.highWaterValue) * 100 : 0,
          pnlPct: (p.netLiquidationValue / p.costSol - 1) * 100, openedAt: p.openedAt, score: p.score, exitReason: p.exitReason ?? null })),
        closed: (await store.closedPositions(40)).map((r: any) => ({ mint: r.mint, symbol: r.symbol, mode: r.mode, cost: Number(r.cost_sol),
          proceeds: Number(r.proceeds_sol), pnl: Number(r.pnl_sol), hwm: Number(r.high_water_value), reason: r.exit_reason, closedAt: r.closed_at })),
        pnl, paperSol: positions.paperSol, approvals: [...positions.approvals.values()],
        flags: { ruggers: store.flagCount("RUGGER"), rugFunders: store.flagCount("RUG_FUNDER"), recent: store.recentFlags() },
        health: await store.healthAll(), db: sql.kind, trailing: config.trailingDrawdown,
        settings: { "Buy size": `${config.buySol} SOL`, "Trailing drawdown": `${Math.round(config.trailingDrawdown * 100)}% of NLV high`,
          "Deadline": `${config.decisionSeconds}s`, "Re-checks": config.recheckAt.map((x) => `${x}s`).join(", "),
          "Select score": `≥${config.selectScore}`, "Max hold": `${config.maxHoldMinutes} min`, "Max open": config.maxOpen,
          "Daily loss stop": `${config.dailyLossSol} SOL`, "Database": sql.kind === "embedded" ? "embedded Postgres" : "Postgres" },
      };
    },
    rules: () => ({ rules: rules.map(({ rule_id, title, category, severity, condition, on_trigger, on_missing_evidence, applies_to, factor, params, enabled, evidence_required }) =>
      ({ rule_id, title, category, severity, condition, on_trigger, on_missing_evidence, applies_to, factor, params, enabled, evidence_required })) }),
    decision: (m) => store.latestOutput(m),
    decisions: (n, d) => store.latestOutputs(n, d),
    ruleResults: (m) => store.ruleResults(m),
    walletHello: (pk) => { if (positions.browserWallet !== pk) printEvent(`🔗 browser wallet connected: ${pk}`); positions.browserWallet = pk; positions.browserSeenAt = Date.now(); },
    prepare: (m, pk) => positions.prepareBrowserTx(m, pk),
    submitted: (m, pk, sig) => positions.browserSubmitted(m, pk, sig),
    reject: (m) => positions.rejectApproval(m),
  });

  banner([
    `Mode        ${config.mode === "paper" ? "PAPER (fake money, real launches)" : config.mode === "browser" ? "BROWSER WALLET — you approve every buy and sell in Phantom/Solflare" : isLiveKeypair() ? `LIVE BOT WALLET ${wallet}` : `KEYPAIR in paper mode (set CONFIRM_LIVE=YES to trade) ${wallet}`}`,
    `Stream      ${stream.provider === "rpc" ? "Solana RPC logs (exact slot + instruction index)" : "PumpPortal (set RPC_WSS_URL for the RPC stream)"}`,
    `Rules       ${rules.length} loaded (${rules.filter((r) => r.enabled).length} enabled) · database: ${sql.kind === "embedded" ? "embedded Postgres in " + config.dataDir : "Postgres"}`,
    `Exit        trailing drawdown ${Math.round(config.trailingDrawdown * 100)}% on net liquidation value · max hold ${config.maxHoldMinutes} min`,
    `Dashboard   ${url}`,
  ]);
  telegram(`🎯 solana-launch-screen started · ${config.mode}${isLiveKeypair() ? " LIVE" : ""}`);

  setInterval(() => positions.monitor().catch(() => {}), 3000);
  setInterval(() => positions.expireApprovals(), 2000);
  setInterval(() => screener.housekeeping(), 60_000);
  setInterval(async () => printStatus({ scanned: screener.stats.scanned, final: screener.stats.final, stream: stream.state, rpc: rpc.stats(),
    open: positions.positions.size, pnl: (await store.pnlSummary()).pnl, mode: config.mode, url }), 30_000);
  setInterval(() => store.prune(config.retentionDays).catch(() => {}), 6 * 3600e3);

  const shutdown = async () => {
    console.log("\nSaving and shutting down…");
    stream.stop(); market.stop();
    await screener.saveStats().catch(() => {});
    await sql.close().catch(() => {});
    process.exit(0);
  };
  process.on("SIGINT", shutdown); process.on("SIGTERM", shutdown);
}

main().catch((e) => { console.error("\nStartup failed:", e.message ?? e); process.exit(1); });
