/**
 * Orchestrates one launch from birth to final decision.
 *   0 s       launch seen → read token/curve accounts, trace deployer, query pump.fun history (in parallel)
 *   0–3 s     watch first trades; trace up to TRACE_BUYERS early buyers as they arrive
 *   ≤ 6 s     stage 1: evaluate all rules → decision (anything unfinished counts as missing evidence)
 *   15, 30 s  stage 2: WAIT / MONITOR re-evaluated with fresh accounts and trades; final stage resolves to REJECT
 * Also learns ruggers: a deployer that sells ≥ DEV_DUMP_PCT % of its own bag is flagged, and so is its funder.
 */
import { config } from "../config";
import { activeExtensions, fetchContract } from "../data/accounts";
import { feePct, type MarketData } from "../data/quotes";
import type { Rpc } from "../data/rpc";
import type { Store } from "../data/store";
import type { WalletTracer } from "../data/wallet-history";
import { quote } from "../decoders/bonding-curve";
import { clusterRisk } from "../graph/cluster-risk";
import { buildFundingGraph } from "../graph/funding-graph";
import { evaluateAll, loadRules, type Evidence } from "../rules/registry";
import type { ContractInfo, Decision, LaunchEvent, TradeEvent, WalletTrace } from "../types";
import { decide, type DecisionResult } from "./decision";

const param = (id: string, k: string, d: number) => loadRules().find((r) => r.rule_id === id)?.params?.[k] ?? d;

type Settled<T> = { done: boolean; value?: T; error?: string };
const track = <T>(p: Promise<T>): { p: Promise<T>; s: Settled<T> } => {
  const s: Settled<T> = { done: false };
  p.then((v) => { s.done = true; s.value = v; }, (e) => { s.done = true; s.error = String(e?.message ?? e); });
  return { p, s };
};

interface Watch {
  launch: LaunchEvent;
  trades: TradeEvent[];
  reserves: { vsol: number; vtok: number; at: number } | null;
  price0: number | null;
  contract: { p: Promise<ContractInfo>; s: Settled<ContractInfo> };
  deployer: { p: Promise<WalletTrace>; s: Settled<WalletTrace> };
  pumpfun?: { p: Promise<{ count: number; graduated: number } | null>; s: Settled<{ count: number; graduated: number } | null> };
  metadata?: { p: Promise<boolean | null>; s: Settled<boolean | null> };
  buyers: Map<string, { p: Promise<WalletTrace>; s: Settled<WalletTrace> }>;
  prior: { mint: string; decision: string }[];
  copycat: boolean;
}

export interface Record_ {
  output: DecisionResult["output"];
  meta: { symbol: string; name: string; stage: number; elapsed_ms: number; factors: Record<string, number>; score: number;
          gated: boolean; action: string; time: string; deployer: string };
}

export interface ScreenerHooks {
  canAutoBuy: () => string | null;                           // null = allowed, otherwise the reason it is blocked
  onSelected: (w: { launch: LaunchEvent; reserves: Watch["reserves"]; result: DecisionResult }) => Promise<string>;
  onRecord: (r: Record_) => void;
  watchMint: (mint: string) => void;
  unwatchMint: (mint: string) => void;
  watchWallet: (w: string) => void;
  streamOk: () => boolean;
}

export class Screener {
  watch = new Map<string, Watch>();
  private deployers = new Map<string, { mint: string; bag: number; sold: number; until: number }>();
  stats = { scanned: 0, stage1: {} as Record<string, number>, final: {} as Record<string, number>, ruleHits: {} as Record<string, number> };
  decisionMs: number[] = [];
  records: Record_[] = [];
  finalStage = config.recheckAt.length + 1;

  constructor(private rpc: Rpc, private store: Store, private tracer: WalletTracer, private market: MarketData, private hooks: ScreenerHooks) {}

  async loadStats() { this.stats = await this.store.get("screener_stats", this.stats); }
  saveStats() { return this.store.put("screener_stats", this.stats); }

  // ─────────── 0 s ───────────
  async onLaunch(l: LaunchEvent) {
    if (this.watch.has(l.mint)) return;
    this.stats.scanned++;
    // register synchronously: the creator's first buy usually arrives in the same message as the launch
    const w: Watch = {
      launch: l, trades: [], copycat: false, prior: [],
      reserves: l.vsol && l.vtok ? { vsol: l.vsol, vtok: l.vtok, at: l.receivedAt } : null,
      price0: l.vsol && l.vtok ? l.vsol / l.vtok : null,
      contract: track(fetchContract(this.rpc, l.mint, l.bondingCurve || undefined)),
      deployer: track(this.tracer.trace(l.deployer)),
      buyers: new Map(),
    };
    if (config.checkPumpfunApi) w.pumpfun = track(this.pumpfunHistory(l));
    if (config.checkMetadata) w.metadata = track(this.metadata(l));
    this.watch.set(l.mint, w);
    this.deployers.set(l.deployer, { mint: l.mint, bag: 0, sold: 0, until: Date.now() + config.trackCreatorsMinutes * 60e3 });
    this.hooks.watchMint(l.mint);
    this.hooks.watchWallet(l.deployer);
    const wait = Math.max(0, l.receivedAt + config.observeSeconds * 1000 - Date.now());
    setTimeout(() => this.evaluate(l.mint, 1).catch((e) => console.error("evaluate", e)), wait);
    // history lookups must see the database BEFORE this launch is inserted
    const [prior, copycat] = await Promise.all([
      this.store.priorLaunches(l.deployer, l.mint, param("R025", "lookback_hours", 72)).catch(() => []),
      this.store.copycat(l.mint, l.name, l.symbol, param("X001", "hours", 72)).catch(() => false),
    ]);
    w.prior = prior; w.copycat = copycat;
    await this.store.insertLaunch(l).catch((e) => console.error("insertLaunch", e.message));
    if (!l.slot) this.fillSlot(l);
  }

  private async fillSlot(l: LaunchEvent) {
    try {
      const r = await this.rpc.call<any>("getSignatureStatuses", [[l.signature], { searchTransactionHistory: false }]);
      const slot = r?.value?.[0]?.slot; if (slot) { l.slot = slot; await this.store.setLaunchSlot(l); }
    } catch { /* keep slot 0 */ }
  }

  // ─────────── every trade ───────────
  onTrade(t: TradeEvent) {
    const w = this.watch.get(t.mint);
    if (w) {
      if (!w.price0 && t.vsol && t.vtok && t.wallet === w.launch.deployer) w.price0 = t.vsol / t.vtok;
      w.trades.push(t);
      if (t.vsol > 0 && t.vtok > 0) w.reserves = { vsol: t.vsol, vtok: t.vtok, at: t.receivedAt };
      if (t.side === "buy" && t.wallet !== w.launch.deployer && !w.buyers.has(t.wallet)
          && w.buyers.size < config.traceBuyers && t.sol >= config.minTraceSol)
        w.buyers.set(t.wallet, track(this.tracer.trace(t.wallet)));
    }
    const d = this.deployers.get(t.wallet);
    if (d && d.mint === t.mint) {
      if (t.side === "buy") d.bag += t.tokens;
      else {
        d.sold += t.tokens;
        if (d.bag > 0 && d.sold / d.bag * 100 >= config.devDumpPct && !this.store.flagsOf(t.wallet)?.has("RUGGER"))
          this.flagRugger(t.wallet, t.mint, d.sold / d.bag * 100).catch(() => {});
      }
    }
  }

  private async flagRugger(deployer: string, mint: string, pct: number) {
    await this.store.flagWallet(deployer, "RUGGER", { mint, reason: `dumped ${pct.toFixed(0)}% of own coin` });
    const f = await this.store.funderOf(deployer);
    if (f && !f.service) await this.store.flagWallet(f.funder, "RUG_FUNDER", { rugger: deployer, mint });
    console.log(`🚩 rugger learned ${deployer.slice(0, 6)}… dumped ${pct.toFixed(0)}%${f && !f.service ? ` · funder ${f.funder.slice(0, 6)}… flagged` : ""}`);
  }

  // ─────────── stage 1 / stage 2 ───────────
  async evaluate(mint: string, stage: number) {
    const w = this.watch.get(mint); if (!w) return;
    const l = w.launch;
    let deadline: number;
    if (stage === 1) deadline = l.receivedAt + config.decisionSeconds * 1000 - 150;
    else { w.contract = track(fetchContract(this.rpc, mint, l.bondingCurve || undefined)); deadline = Date.now() + config.stage2BudgetSeconds * 1000; }
    const pending = [w.contract, w.deployer, w.pumpfun, w.metadata, ...w.buyers.values()].filter((x) => x && !x.s.done).map((x) => x!.p.catch(() => {}));
    const left = deadline - Date.now();
    if (pending.length && left > 0) await Promise.race([Promise.all(pending), new Promise((r) => setTimeout(r, left))]);

    const ev = await this.buildEvidence(w, stage);
    const results = evaluateAll(ev);
    const block = this.hooks.canAutoBuy();
    const res = decide(ev, results, (d: Decision) => d === "SELECT_FOR_REVIEW" && config.autoBuy && !block);
    const elapsed = Date.now() - l.receivedAt;
    if (stage === 1) { this.decisionMs.push(elapsed); if (this.decisionMs.length > 500) this.decisionMs.shift(); this.bump(this.stats.stage1, res.decision); }
    for (const r of [...res.gates.rejects, ...res.gates.waits]) this.bump(this.stats.ruleHits, r.rule.rule_id);

    let action: string;
    if (res.decision === "SELECT_FOR_REVIEW") {
      action = !config.autoBuy ? "selected — AUTO_BUY off" : block ? `not bought: ${block}` : "buying";
      this.finish(mint, res.decision, action === "buying");
      if (action === "buying") action = await this.hooks.onSelected({ launch: l, reserves: w.reserves, result: res });
    } else if ((res.decision === "WAIT" || res.decision === "MONITOR") && stage < this.finalStage) {
      const at = config.recheckAt[stage - 1];
      action = `re-check at ${at}s`;
      setTimeout(() => this.evaluate(mint, stage + 1).catch((e) => console.error("evaluate", e)), Math.max(0, l.receivedAt + at * 1000 - Date.now()));
    } else {
      action = "skipped"; this.finish(mint, res.decision, false);
    }
    await this.store.recordDecision(l, res.output, res.results).catch((e) => console.error("recordDecision", e.message));
    const rec: Record_ = { output: res.output, meta: { symbol: l.symbol, name: l.name, stage, elapsed_ms: elapsed, factors: res.factors,
      score: res.score, gated: res.gated, action, time: new Date().toISOString().slice(11, 19), deployer: l.deployer } };
    this.records.unshift(rec); if (this.records.length > 80) this.records.pop();
    this.hooks.onRecord(rec);
    if (this.stats.scanned % 20 === 0) this.saveStats().catch(() => {});
  }

  private finish(mint: string, d: Decision, keepWatching: boolean) {
    this.bump(this.stats.final, d);
    this.watch.delete(mint);
    if (!keepWatching) this.hooks.unwatchMint(mint);
  }

  private bump(m: Record<string, number>, k: string) { m[k] = (m[k] ?? 0) + 1; }

  async buildEvidence(w: Watch, stage: number): Promise<Evidence> {
    const l = w.launch;
    const contract = w.contract.s.value ?? null;
    const deployerTrace = w.deployer.s.value ?? null;
    const buyerTraces = new Map<string, WalletTrace>();
    for (const [k, v] of w.buyers) if (v.s.value) buyerTraces.set(k, v.s.value);
    const isFlagged = (x?: string | null) => {
      const f = this.store.flagsOf(x); if (!f) return null;
      return f.has("RUGGER") ? "is a known rugger" : f.has("RUG_FUNDER") ? "funded a known rugger" : null;
    };
    const graph = buildFundingGraph(l.deployer, deployerTrace, buyerTraces, isFlagged);
    const risk = clusterRisk(l.deployer, l.receivedAt, w.price0, w.trades, graph, buyerTraces, { bundleMs: param("R043", "bundle_ms", 600), dustSol: 0.01 });
    const venue = contract?.curve.complete ? "pumpswap" : "pump_bonding_curve";
    const fee = feePct(venue);
    const q = w.reserves ? quote(w.reserves.vsol, w.reserves.vtok, config.buySol, fee, config.priorityFeeSol, risk.topHolderTokens, risk.clusterTokens) : null;
    const funderLaunches = graph.deployerFunder ? await this.store.funderLaunchCount(graph.deployerFunder, l.deployer, param("R025", "lookback_hours", 72)).catch(() => 0) : 0;
    const rug = this.store.flagsOf(l.deployer)?.get("RUGGER");
    const eligible = new Set(w.trades.filter((t) => t.side === "buy" && t.wallet !== l.deployer && t.sol >= config.minTraceSol).map((t) => t.wallet));
    return {
      venue, stage, final: stage >= this.finalStage, now: Date.now(), launch: l,
      contract, contractError: w.contract.s.error ?? (w.contract.s.done ? null : "pending"),
      activeExtensions: contract ? activeExtensions(contract.mint) : null,
      reserves: w.reserves, quote: q, feePct: fee, risk, graph,
      deployerTrace, deployerTraceError: w.deployer.s.error ?? (w.deployer.s.done ? null : "pending"),
      buyerTracesNeeded: Math.min(config.traceBuyers, eligible.size), buyerTracesDone: buyerTraces.size,
      history: {
        rugger: rug ? String(rug.reason ?? "dumped an earlier coin") : null, prior: w.prior,
        pumpfunChecked: config.checkPumpfunApi, pumpfunPast: w.pumpfun?.s.value ?? null, copycat: w.copycat,
        funderFlag: isFlagged(graph.deployerFunder), funderLaunches,
      },
      metadata: { checked: config.checkMetadata, ok: w.metadata?.s.value ?? null },
      market: { rpcLagSlots: this.market.rpcLagSlots, priorityFeeMicroLamports: this.market.priorityFeeMicroLamports,
                solUsd: this.market.solUsd, streamOk: this.hooks.streamOk() },
    };
  }

  housekeeping() {
    const now = Date.now();
    for (const [d, v] of this.deployers) if (v.until < now) this.deployers.delete(d);
  }

  // ─────────── optional off-chain lookups ───────────
  private async pumpfunHistory(l: LaunchEvent) {
    try {
      const r = await fetch(`${config.pumpfunApi}/coins/user-created-coins/${l.deployer}?offset=0&limit=50&includeNsfw=true`,
                            { signal: AbortSignal.timeout(3000) });
      if (!r.ok) return null;
      const data: any = await r.json();
      const coins = Array.isArray(data) ? data : data?.coins;
      if (!Array.isArray(coins)) return null;
      const others = coins.filter((c: any) => c?.mint !== l.mint);
      return { count: others.length, graduated: others.filter((c: any) => c?.complete).length };
    } catch { return null; }
  }

  private async metadata(l: LaunchEvent) {
    if (!l.uri) return false;
    try {
      const r = await fetch(l.uri.replace("ipfs://", "https://ipfs.io/ipfs/"), { signal: AbortSignal.timeout(3000) });
      const m: any = await r.json();
      return Boolean(m?.twitter || m?.telegram || m?.website);
    } catch { return null; }
  }
}
