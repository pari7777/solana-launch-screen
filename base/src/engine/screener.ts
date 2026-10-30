/**
 * One Clanker launch from birth to final decision.
 *   0 s           TokenCreated seen → read the token, recover the pool key, trace the creator (in parallel)
 *   0–3 s         Transfer + Swap logs give holders, buys and sells; up to TRACE_BUYERS early buyers are traced
 *   ≤ 6 s         stage 1: all rules → decision (anything unfinished counts as missing evidence)
 *   20…150 s      WAIT / MONITOR re-checked (Clanker's sniper fee decays over the first minutes); last re-check resolves to REJECT
 * Learns ruggers: a creator that sells ≥ DEV_DUMP_PCT % of what it held is flagged, and so is its funder.
 */
import { formatUnits, type PublicClient } from "viem";
import { ERC20_ABI } from "../chain/abi";
import { timed } from "../chain/client";
import { PoolQuoter, recoverPoolKey } from "../chain/pool";
import type { WalletTracer } from "../chain/wallets";
import { ADDR, config, lc } from "../config";
import type { Store } from "../data/store";
import { TokenState } from "../graph/token-state";
import { buildFundingGraph, computeRisk, TOTAL_SUPPLY } from "../graph/risk";
import { evaluateAll, loadRules, type Evidence } from "../rules/registry";
import type { Decision, Hex, LaunchEvent, PoolKey, PoolSwap, Quote, TokenTransfer, WalletTrace } from "../types";
import { decide, type DecisionResult } from "./decision";

const param = (id: string, k: string, d: number) => loadRules().find((r) => r.rule_id === id)?.params?.[k] ?? d;
type Settled<T> = { done: boolean; value?: T; error?: string };
const track = <T>(p: Promise<T>) => {
  const s: Settled<T> = { done: false };
  p.then((v) => { s.done = true; s.value = v; }, (e) => { s.done = true; s.error = String(e?.shortMessage ?? e?.message ?? e).slice(0, 120); });
  return { p, s };
};
type Tracked<T> = ReturnType<typeof track<T>>;
const withTimeout = <T>(p: Promise<T>, ms: number) => Promise.race([p, new Promise<never>((_, r) => setTimeout(() => r(new Error("timeout")), ms))]);

interface Watch {
  launch: LaunchEvent; state: TokenState; key: PoolKey | null;
  onchain: Tracked<{ totalSupply: number | null; decimals: number | null; isContract: boolean }>;
  creator: Tracked<WalletTrace>;
  buyers: Map<string, Tracked<WalletTrace>>;
  prior: { mint: string; decision: string }[]; copycat: boolean;
  creatorPeak: number;
}

export interface Record_ {
  output: DecisionResult["output"];
  meta: { symbol: string; name: string; platform: string; stage: number; elapsed_ms: number; factors: Record<string, number>; score: number;
          gated: boolean; action: string; time: string; deployer: string };
}

export interface ScreenerHooks {
  canAutoBuy: () => string | null;
  onSelected: (s: { launch: LaunchEvent; key: PoolKey; result: DecisionResult; quote: Quote | null }) => Promise<string>;
  onRecord: (r: Record_) => void;
  watch: (token: string, poolId: string) => void;
  unwatch: (token: string, poolId: string) => void;
  streamOk: () => boolean;
  headLag: () => number | null;
  ethUsd: () => number | null;
}

export class Screener {
  watch = new Map<string, Watch>();                 // by token (lowercase)
  private byPool = new Map<string, string>();       // poolId → token
  private creators = new Map<string, { token: string; until: number }>();
  stats = { scanned: 0, stage1: {} as Record<string, number>, final: {} as Record<string, number>, ruleHits: {} as Record<string, number> };
  decisionMs: number[] = [];
  records: Record_[] = [];
  finalStage = config.recheckAt.length + 1;
  quoter: PoolQuoter;

  constructor(private client: PublicClient, private store: Store, private tracer: WalletTracer, private hooks: ScreenerHooks) {
    this.quoter = new PoolQuoter(client);
  }

  async loadStats() { this.stats = await this.store.get("screener_stats", this.stats); }
  saveStats() { return this.store.put("screener_stats", this.stats); }

  /** Launches from the backfill only feed creator history; they are not screened. */
  async onBackfill(l: LaunchEvent) { await this.store.insertLaunch(l).catch(() => {}); }

  onLaunch(l: LaunchEvent) {
    const token = lc(l.token);
    if (this.watch.has(token)) return;
    this.stats.scanned++;
    const key = recoverPoolKey(l.token, l.pairedToken, l.hook, l.poolId);
    const tokenIs0 = key ? lc(key.currency0) === token : BigInt(l.token) < BigInt(l.pairedToken);
    const w: Watch = {
      launch: l, key, state: new TokenState(token, tokenIs0, new Set()),
      onchain: track(this.readToken(l.token)), creator: track(this.tracer.trace(l.creator)),
      buyers: new Map(), prior: [], copycat: false, creatorPeak: 0,
    };
    this.watch.set(token, w);
    this.byPool.set(lc(l.poolId), token);
    this.hooks.watch(token, l.poolId);                      // synchronous: the same scan pulls its first trades
    this.creators.set(lc(l.creator), { token, until: Date.now() + config.trackCreatorsMinutes * 60e3 });
    const start = Math.max(l.receivedAt, Date.now());
    setTimeout(() => this.evaluate(token, 1).catch((e) => console.error("evaluate", e)), Math.max(0, start + config.observeSeconds * 1000 - Date.now()));
    void (async () => {
      const [prior, copycat] = await Promise.all([
        this.store.priorLaunches(lc(l.creator), token, param("R025", "lookback_hours", 72)).catch(() => []),
        this.store.copycat(token, l.name, l.symbol, param("X001", "hours", 72)).catch(() => false),
      ]);
      w.prior = prior; w.copycat = copycat;
      await this.store.insertLaunch(l).catch((e) => console.error("insertLaunch", e.message));
    })();
  }

  private async readToken(token: Hex) {
    const [supply, decimals] = await timed(() => this.client.multicall({ allowFailure: false, contracts: [
      { address: token, abi: ERC20_ABI, functionName: "totalSupply" }, { address: token, abi: ERC20_ABI, functionName: "decimals" }] }));
    const d = Number(decimals);
    return { totalSupply: Math.round(Number(formatUnits(supply as bigint, d))), decimals: d, isContract: true };
  }

  onTransfers(token: string, ts: TokenTransfer[]) {
    const w = this.watch.get(token);
    if (w) {
      w.state.addTransfers(ts);
      this.traceBuyers(w);
      const c = lc(w.launch.creator), bal = w.state.balanceOf(c);
      w.creatorPeak = Math.max(w.creatorPeak, bal);
    }
    // learn ruggers (keeps working after the decision for TRACK_CREATORS_MINUTES)
    for (const t of ts) {
      const c = this.creators.get(t.from);
      if (!c || c.token !== token) continue;
      const st = this.watch.get(token)?.state;
      const peak = this.watch.get(token)?.creatorPeak ?? 0;
      const left = st ? st.balanceOf(t.from) : 0;
      if (peak > 0 && (1 - left / peak) * 100 >= config.devDumpPct && !this.store.flagsOf(t.from)?.has("RUGGER"))
        this.flagRugger(t.from, token, (1 - left / peak) * 100).catch(() => {});
    }
  }

  onSwaps(poolId: string, s: PoolSwap[]) {
    const token = this.byPool.get(poolId); const w = token ? this.watch.get(token) : undefined;
    if (w) { w.state.addSwaps(s); this.traceBuyers(w); }
  }

  private traceBuyers(w: Watch) {
    for (const t of w.state.trades) {
      if (w.buyers.size >= config.traceBuyers) return;
      if (t.side === "buy" && t.wallet !== lc(w.launch.creator) && t.eth >= config.minTraceEth && !w.buyers.has(t.wallet))
        w.buyers.set(t.wallet, track(this.tracer.trace(t.wallet)));
    }
  }

  private async flagRugger(creator: string, token: string, pct: number) {
    await this.store.flagWallet(creator, "RUGGER", { mint: token, reason: `dumped ${pct.toFixed(0)}% of own coin` });
    const f = await this.store.funderOf(creator);
    if (f && !f.service) await this.store.flagWallet(f.funder, "RUG_FUNDER", { rugger: creator, mint: token });
    console.log(`🚩 rugger learned ${creator.slice(0, 8)}… dumped ${pct.toFixed(0)}%${f && !f.service ? ` · funder ${f.funder.slice(0, 8)}… flagged` : ""}`);
  }

  async evaluate(token: string, stage: number) {
    const w = this.watch.get(token); if (!w) return;
    const l = w.launch;
    const deadline = stage === 1 ? Math.max(l.receivedAt, Date.now() - config.observeSeconds * 1000) + config.decisionSeconds * 1000 - 1500 : Date.now() + 4000;
    const pending = [w.onchain, w.creator, ...w.buyers.values()].filter((x) => !x.s.done).map((x) => x.p.catch(() => {}));
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
    if (res.decision === "SELECT_FOR_REVIEW" && w.key) {
      action = !config.autoBuy ? "selected — AUTO_BUY off" : block ? `not bought: ${block}` : "buying";
      this.finish(token, res.decision, action === "buying");
      if (action === "buying") action = await this.hooks.onSelected({ launch: l, key: w.key, result: res, quote: ev.quote });
    } else if ((res.decision === "WAIT" || res.decision === "MONITOR") && stage < this.finalStage) {
      const at = config.recheckAt[stage - 1];
      action = `re-check at ${at}s`;
      setTimeout(() => this.evaluate(token, stage + 1).catch((e) => console.error("evaluate", e)), Math.max(1000, l.receivedAt + at * 1000 - Date.now()));
    } else { action = "skipped"; this.finish(token, res.decision, false); }

    await this.store.recordDecision(l, res.output, res.results).catch((e) => console.error("recordDecision", e.message));
    const rec: Record_ = { output: res.output, meta: { symbol: l.symbol, name: l.name, platform: "Clanker", stage, elapsed_ms: elapsed, factors: res.factors,
      score: res.score, gated: res.gated, action, time: new Date().toISOString().slice(11, 19), deployer: l.creator } };
    this.records.unshift(rec); if (this.records.length > 80) this.records.pop();
    this.hooks.onRecord(rec);
    if (this.stats.scanned % 20 === 0) this.saveStats().catch(() => {});
  }

  private finish(token: string, d: Decision, keepWatching: boolean) {
    this.bump(this.stats.final, d);
    const w = this.watch.get(token);
    this.watch.delete(token);
    if (w) { this.byPool.delete(lc(w.launch.poolId)); if (!keepWatching) this.hooks.unwatch(token, w.launch.poolId); }
  }
  private bump(m: Record<string, number>, k: string) { m[k] = (m[k] ?? 0) + 1; }

  async buildEvidence(w: Watch, stage: number): Promise<Evidence> {
    const l = w.launch, creator = lc(l.creator);
    const creatorTrace = w.creator.s.value ?? null;
    if (creatorTrace) this.store.addFundingEdge(creatorTrace).catch(() => {});
    const traces = new Map<string, WalletTrace>();
    for (const [k, v] of w.buyers) if (v.s.value) traces.set(k, v.s.value);
    const isFlagged = (x?: string | null) => {
      const f = this.store.flagsOf(x ? lc(x) : x); if (!f) return null;
      return f.has("RUGGER") ? "is a known rugger" : f.has("RUG_FUNDER") ? "funded a known rugger" : null;
    };
    const graph = buildFundingGraph(creator, creatorTrace, traces, isFlagged);
    const extTokens = Number(formatUnits(l.extensionsSupply ?? 0n, 18));
    const risk = computeRisk(creator, l.slot, w.state, graph, traces, extTokens, { dustEth: 0.002 });
    let quote: Quote | null = null, quoteError: string | null = null, sellReverted = false;
    if (!w.key) quoteError = "pool key not recovered";
    else if (lc(l.pairedToken) !== lc(ADDR.weth)) quoteError = "pair is not WETH";
    else {
      try { quote = await withTimeout(this.quoter.analyse(w.key, config.buyEth, risk.topHolderTokens, risk.clusterTokens), 3500); }
      catch (e: any) {
        quoteError = String(e?.shortMessage ?? e?.message ?? e).slice(0, 120);
        if (/revert/i.test(quoteError)) {
          try { await withTimeout(this.quoter.buy(w.key, 10n ** 14n), 2000); sellReverted = true; } catch { /* buys fail too: trading not open */ }
        }
      }
    }
    const funderLaunches = graph.creatorFunder ? await this.store.funderLaunchCount(graph.creatorFunder, creator, param("R025", "lookback_hours", 72)).catch(() => 0) : 0;
    const rug = this.store.flagsOf(creator)?.get("RUGGER");
    const eligible = new Set(w.state.trades.filter((t) => t.side === "buy" && t.wallet !== creator && t.eth >= config.minTraceEth).map((t) => t.wallet));
    const poolEth = Math.max(0, w.state.trades.reduce((a, t) => a + (t.side === "buy" ? t.eth : -t.eth), 0));
    const onchain = w.onchain.s.value ?? null;
    return {
      venue: "clanker_v4", stage, final: stage >= this.finalStage, now: Date.now(), ageSec: Math.round((Date.now() - (l.blockTime ? l.blockTime * 1000 : l.receivedAt)) / 1000),
      launch: l, poolKey: w.key, onchain, onchainError: w.onchain.s.error ?? (w.onchain.s.done ? null : "pending"),
      quote, quoteError, sellReverted, risk, graph,
      creatorTrace, creatorTraceError: w.creator.s.error ?? (w.creator.s.done ? null : "pending"),
      senderIsPlatform: lc(l.sender) !== creator,
      buyerTracesNeeded: Math.min(config.traceBuyers, eligible.size), buyerTracesDone: [...traces.keys()].filter((k) => eligible.has(k)).length,
      history: { rugger: rug ? String(rug.reason ?? "dumped an earlier coin") : null, prior: w.prior, copycat: w.copycat,
                 funderFlag: isFlagged(graph.creatorFunder), funderLaunches },
      poolEth,
      market: { ethUsd: this.hooks.ethUsd(), streamOk: this.hooks.streamOk(), headLagBlocks: this.hooks.headLag() },
    };
  }

  housekeeping() { const now = Date.now(); for (const [c, v] of this.creators) if (v.until < now) this.creators.delete(c); }
}

export { TOTAL_SUPPLY };
