/**
 * base-launch-screen — entry point.  npm start
 * Base RPC polling (Clanker TokenCreated + Transfer + Uniswap v4 Swap logs) → screener (120 rules, staged re-checks)
 * → paper positions (Quoter-valued, 35% trailing drawdown) → terminal, dashboard, Telegram, webhook.
 */
import { banner, printDecision, printEvent, printStatus } from "./alerts/terminal";
import { startDashboard } from "./alerts/dashboard";
import { telegram, webhook } from "./alerts/telegram";
import { makeClient, rpcStats } from "./chain/client";
import { WalletTracer } from "./chain/wallets";
import { ChainWatcher } from "./chain/watcher";
import { ADDR, config, lc } from "./config";
import { openDb } from "./data/db";
import { Store } from "./data/store";
import { Screener } from "./engine/screener";
import { loadRules } from "./rules/registry";
import { PositionManager } from "./trade/positions";

const SELL_SINKS = new Set([ADDR.poolManager, ADDR.universalRouter].map(lc));

async function main() {
  const rules = loadRules();
  const sql = await openDb();
  const store = new Store(sql); await store.init();
  const client = makeClient();
  const tracer = new WalletTracer(client);

  let ethUsd: number | null = null;
  const refreshPrice = async () => {
    try { const r: any = await (await fetch("https://api.coinbase.com/v2/prices/ETH-USD/spot", { signal: AbortSignal.timeout(5000) })).json(); ethUsd = Number(r?.data?.amount) || ethUsd; }
    catch { /* keep last */ }
  };
  await refreshPrice(); setInterval(refreshPrice, 60_000);

  let watcher: ChainWatcher;
  const screenerRef: { s?: Screener } = {};
  const positions = new PositionManager(store, null as any);
  positions.onEvent = (m) => { printEvent(m); telegram(m); };
  positions.onClosed = (p) => { if (!screenerRef.s?.watch.has(p.token)) watcher.unwatchToken(p.token, p.meta.poolId); };

  const screener = new Screener(client, store, tracer, {
    canAutoBuy: () => positions.canAutoBuy(),
    onSelected: (s) => positions.onSelected(s),
    onRecord: (r) => {
      printDecision(r);
      const o = r.output;
      if (o.decision === "SELECT_FOR_REVIEW")
        telegram(`🎯 BASE SELECT $${r.meta.symbol} · score ${o.risk_score} (${o.confidence}) · ${r.meta.action}\nhttps://www.clanker.world/clanker/${o.token_address}`);
      if (config.webhookUrl && (config.webhookDecisions.includes("ALL") || config.webhookDecisions.includes(o.decision))) webhook(o);
    },
    watch: (t, id) => watcher.watchToken(t, id),
    unwatch: (t, id) => { if (!positions.positions.has(t)) watcher.unwatchToken(t, id); },
    streamOk: () => watcher.state === "connected",
    headLag: () => (watcher.head ? Number(watcher.head - watcher.cursor) : null),
    ethUsd: () => ethUsd,
  });
  screenerRef.s = screener;
  positions.quoter = screener.quoter;
  await screener.loadStats();
  const held = await positions.load();

  let lastHealth = 0;
  watcher = new ChainWatcher(client, {
    onLaunch: (l) => screener.onLaunch(l),
    onBackfill: (l) => screener.onBackfill(l),
    onTransfers: (token, ts) => {
      screener.onTransfers(token, ts);
      positions.onTransfers(token, ts, (t) => SELL_SINKS.has(t.to));
    },
    onSwaps: (id, s) => screener.onSwaps(id, s),
    onState: (state, ok, block) => {
      if (!ok || Date.now() - lastHealth > 10_000) { lastHealth = Date.now(); store.health("base_rpc", ok, block ?? null, ok ? "OK" : state.slice(0, 60)).catch(() => {}); }
      if (!ok || state === "connected") printEvent(`base rpc: ${state}`);
    },
  });
  for (const p of held) watcher.watchToken(p.token, p.meta.poolId);
  await watcher.start();
  setInterval(() => store.health("base_rpc", watcher.state === "connected", Number(watcher.head), watcher.state === "connected" ? "OK" : watcher.state.slice(0, 60)).catch(() => {}), 15_000);
  void watcher.backfill().then((n) => printEvent(`creator history: loaded ${n} Clanker launches from the last ${config.backfillHours}h`)).catch(() => {});

  const url = `http://${config.host === "0.0.0.0" ? "localhost" : config.host}:${config.port}`;
  startDashboard({
    status: async () => {
      const pnl = await store.pnlSummary();
      const ms = [...screener.decisionMs].sort((a, b) => a - b);
      const hits = Object.entries(screener.stats.ruleHits).sort((a, b) => b[1] - a[1]).slice(0, 14)
        .map(([id, n]) => ({ id, n, title: rules.find((r) => r.rule_id === id)?.title ?? id }));
      return {
        chain: "BASE", mode: "paper", live: false, paper: true, autoBuy: config.autoBuy, paused: config.paused, wallet: null,
        stream: { provider: "base rpc", state: watcher.state }, rpc: rpcStats(),
        market: { ethUsd, rpcLagSlots: watcher.head ? Number(watcher.head - watcher.cursor) : null },
        scanned: screener.stats.scanned, stage1: screener.stats.stage1, final: screener.stats.final, inReview: screener.watch.size,
        decisionMs: { p50: ms[Math.floor(ms.length / 2)] ?? null, p90: ms[Math.floor(ms.length * 0.9)] ?? null },
        ruleHits: hits, records: screener.records,
        positions: [...positions.positions.values()].map((p) => ({ mint: p.token, symbol: p.symbol, platform: p.platform, mode: p.mode, status: p.status, venue: p.venue,
          cost: p.costEth, nlv: p.netLiquidationValue, hwm: p.highWaterValue, exitAt: p.highWaterValue * (1 - config.trailingDrawdown),
          ddPct: p.highWaterValue ? (1 - p.netLiquidationValue / p.highWaterValue) * 100 : 0,
          pnlPct: (p.netLiquidationValue / p.costEth - 1) * 100, openedAt: p.openedAt, score: p.score, exitReason: p.exitReason ?? null })),
        closed: (await store.closedPositions(40)).map((r: any) => ({ mint: r.mint, symbol: r.symbol, mode: r.mode, cost: Number(r.cost_sol),
          proceeds: Number(r.proceeds_sol), pnl: Number(r.pnl_sol), hwm: Number(r.high_water_value), reason: r.exit_reason, closedAt: r.closed_at })),
        pnl, paperSol: positions.paperEth, approvals: [],
        flags: { ruggers: store.flagCount("RUGGER"), rugFunders: store.flagCount("RUG_FUNDER"), recent: store.recentFlags() },
        health: (await store.healthAll()).filter((h: any) => String(h.provider).startsWith("base")), db: sql.kind, trailing: config.trailingDrawdown,
        settings: { "Buy size": `${config.buyEth} ETH`, "Trailing drawdown": `${Math.round(config.trailingDrawdown * 100)}% of NLV high`,
          "Deadline": `${config.decisionSeconds}s`, "Re-checks": config.recheckAt.map((x) => `${x}s`).join(", "),
          "Select score": `≥${config.selectScore}`, "Max hold": `${config.maxHoldMinutes} min`, "Max open": config.maxOpen,
          "Daily loss stop": `${config.dailyLossEth} ETH`, "ETH": ethUsd ? `$${ethUsd.toFixed(0)}` : "—", "Database": sql.kind === "embedded" ? "embedded Postgres" : "Postgres" },
      };
    },
    rules: () => ({ rules: rules.map(({ rule_id, title, category, severity, condition, on_trigger, on_missing_evidence, applies_to, factor, params, enabled, evidence_required }) =>
      ({ rule_id, title, category, severity, condition, on_trigger, on_missing_evidence, applies_to, factor, params, enabled, evidence_required })) }),
    decision: (m) => store.latestOutput(m),
    decisions: (n, d) => store.latestOutputs(n, d),
    ruleResults: (m) => store.ruleResults(m),
  });

  banner([
    `Mode        PAPER on Base (fake ETH, real launches) · balance ${positions.paperEth.toFixed(4)} ETH`,
    `Source      Clanker v4 factory ${ADDR.clankerFactory} via ${config.rpcUrls.length} free Base RPC endpoint(s)`,
    `Rules       ${rules.length} loaded (${rules.filter((r) => r.enabled).length} enabled) · database: ${sql.kind === "embedded" ? "embedded Postgres" : "Postgres"}`,
    `Exit        trailing drawdown ${Math.round(config.trailingDrawdown * 100)}% on net liquidation value · max hold ${config.maxHoldMinutes} min`,
    `Dashboard   ${url}`,
  ]);
  telegram("🔵 base-launch-screen started · paper");

  setInterval(() => positions.monitor().catch(() => {}), 5000);
  setInterval(() => screener.housekeeping(), 60_000);
  setInterval(async () => printStatus({ scanned: screener.stats.scanned, final: screener.stats.final, stream: watcher.state, rpc: rpcStats(),
    open: positions.positions.size, pnl: (await store.pnlSummary()).pnl, mode: "paper", url }), 30_000);
  setInterval(() => store.prune(config.retentionDays).catch(() => {}), 6 * 3600e3);

  const shutdown = async () => {
    console.log("\nSaving and shutting down…");
    watcher.stop();
    await screener.saveStats().catch(() => {});
    await sql.close().catch(() => {});
    process.exit(0);
  };
  process.on("SIGINT", shutdown); process.on("SIGTERM", shutdown);
}

main().catch((e) => { console.error("\nStartup failed:", e.message ?? e); process.exit(1); });
