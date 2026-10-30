/**
 * Position lifecycle:  PENDING → OPEN → EXIT_PENDING → CLOSED
 *
 * Exit rule (as specified): track the position's NET LIQUIDATION VALUE — the SOL you would actually receive by
 * selling everything now, after price impact, fees and priority fee. The high-water mark starts at the value
 * when the position is confirmed and only rises. When the value falls TRAILING_DRAWDOWN (35%) below the
 * high-water mark, the position goes EXIT_PENDING and a full exit is requested.
 * Insider events (deployer sells, linked wallet sells, largest holder dumps) also request a full exit.
 */
import { config, isLiveKeypair, isPaper } from "../config";
import { feePct } from "../data/quotes";
import type { Rpc } from "../data/rpc";
import type { Store } from "../data/store";
import { buyOut, liquidationValue } from "../decoders/bonding-curve";
import { findPool, poolReserves, type PumpSwapPool } from "../decoders/pumpswap";
import type { DecisionResult } from "../engine/decision";
import type { LaunchEvent, TradeEvent, Venue } from "../types";
import type { Executor } from "./executor";

export type Status = "PENDING" | "OPEN" | "EXIT_PENDING" | "CLOSED";

export interface Position {
  mint: string; symbol: string; mode: string; wallet: string | null; status: Status; venue: Venue;
  tokens: number; costSol: number; netLiquidationValue: number; highWaterValue: number;
  vs: number; vt: number; openedAt: number; score: number;
  exitReason?: string; buySignature?: string; sellSignature?: string; proceedsSol?: number; pnlSol?: number; closedAt?: number;
  meta: { deployer: string; linked: string[]; whale: string | null; whaleBag: number; whaleSold: number; pool?: PumpSwapPool; decision?: unknown };
  exiting?: boolean;            // an exit transaction is in flight (not persisted)
  exitPromptedAt?: number;      // browser mode: when the wallet was last asked to approve the exit
}

export interface PendingApproval { mint: string; symbol: string; side: "buy" | "sell"; createdAt: number; reason: string; score?: number }

export class PositionManager {
  positions = new Map<string, Position>();
  approvals = new Map<string, PendingApproval>();     // browser mode: actions waiting for your wallet
  paperSol = config.paperStartSol;
  private buyTimes: number[] = [];
  private todayPnl = 0;
  browserWallet: string | null = null;
  browserSeenAt = 0;
  onEvent?: (msg: string) => void;
  private selections = new Map<string, { launch: LaunchEvent; result: DecisionResult; reserves: { vsol: number; vtok: number } | null }>();

  constructor(private store: Store, private rpc: Rpc, private exec: Executor | null, private wallet: string | null) {}

  async load() {
    this.paperSol = await this.store.get("paper_sol", config.paperStartSol);
    this.todayPnl = (await this.store.pnlSummary()).today;
    for (const r of await this.store.openPositions()) {
      const p: Position = { mint: r.mint, symbol: r.symbol, mode: r.mode, wallet: r.wallet, status: r.status, venue: r.venue,
        tokens: Number(r.tokens), costSol: Number(r.cost_sol), netLiquidationValue: Number(r.net_liquidation_value ?? 0),
        highWaterValue: Number(r.high_water_value ?? 0), vs: Number(r.meta?.vs ?? 0), vt: Number(r.meta?.vt ?? 0),
        openedAt: new Date(r.opened_at).getTime(), score: Number(r.score ?? 0), buySignature: r.buy_signature,
        exitReason: r.exit_reason ?? undefined, meta: r.meta ?? { deployer: "", linked: [], whale: null, whaleBag: 0, whaleSold: 0 } };
      this.positions.set(p.mint, p);
    }
    return [...this.positions.keys()];
  }

  private save(p: Position) {
    return this.store.savePosition({ ...p, meta: { ...p.meta, vs: p.vs, vt: p.vt } }).catch((e) => console.error("save_position", e.message));
  }

  // ─────────── risk limits ───────────
  canAutoBuy(): string | null {
    if (config.paused) return "bot paused";
    if (this.positions.size >= config.maxOpen) return "max open positions";
    this.buyTimes = this.buyTimes.filter((t) => t > Date.now() - 3600e3);
    if (this.buyTimes.length >= config.maxBuysPerHour) return "hourly buy limit";
    if (this.todayPnl <= -config.dailyLossSol) return "daily loss limit";
    if (isPaper() && this.paperSol < config.buySol) return "paper balance too low";
    if (config.mode === "browser" && (!this.browserWallet || Date.now() - this.browserSeenAt > 15_000))
      return "no browser wallet connected (open the dashboard and connect)";
    return null;
  }

  // ─────────── entry ───────────
  async onSelected(s: { launch: LaunchEvent; reserves: { vsol: number; vtok: number } | null; result: DecisionResult }): Promise<string> {
    const { launch, reserves, result } = s;
    if (!reserves) return "not bought: no reserves";
    this.selections.set(launch.mint, s);
    if (config.mode === "browser") {
      this.approvals.set(launch.mint, { mint: launch.mint, symbol: launch.symbol, side: "buy", createdAt: Date.now(),
        reason: `selected, score ${result.score}`, score: result.score });
      this.buyTimes.push(Date.now());
      return "awaiting wallet approval";
    }
    try {
      let tokens: number, cost: number, sig: string | undefined;
      if (isLiveKeypair()) {
        const f = await this.exec!.swap("buy", launch.mint, config.buySol, config.buySol);
        tokens = f.tokenDelta; cost = -f.solDelta; sig = f.signature;
      } else {
        cost = config.buySol;
        tokens = buyOut(reserves.vsol, reserves.vtok, cost, feePct("pump_bonding_curve")).tokens * (1 - config.paperSlippagePct / 100);
        this.paperSol -= cost; await this.store.put("paper_sol", this.paperSol);
      }
      this.buyTimes.push(Date.now());
      await this.open(launch, result, reserves, tokens, cost, sig);
      return `bought ${cost.toFixed(4)} SOL`;
    } catch (e) {
      return `buy failed: ${(e as Error).message.slice(0, 90)}`;
    }
  }

  private async open(launch: LaunchEvent, result: DecisionResult, reserves: { vsol: number; vtok: number }, tokens: number, cost: number, sig?: string) {
    const r = result.output;
    const p: Position = {
      mint: launch.mint, symbol: launch.symbol, mode: config.mode === "browser" ? "browser" : isLiveKeypair() ? "keypair" : "paper",
      wallet: config.mode === "browser" ? this.browserWallet : this.wallet, status: "PENDING", venue: "pump_bonding_curve",
      tokens, costSol: cost, netLiquidationValue: 0, highWaterValue: 0, vs: reserves.vsol, vt: reserves.vtok,
      openedAt: Date.now(), score: result.score, buySignature: sig,
      meta: { deployer: launch.deployer, linked: r.launch_wallet.linked_wallet_clusters.flatMap((c) => c.wallets),
              whale: result.topHolder, whaleBag: result.topHolderTokens, whaleSold: 0 },
    };
    this.positions.set(p.mint, p);
    this.onPositionConfirmed(p);
    this.onEvent?.(`🟢 BUY $${p.symbol} ${cost.toFixed(4)} SOL → NLV ${p.netLiquidationValue.toFixed(4)} · exit if it falls ${Math.round(config.trailingDrawdown * 100)}% below its high`);
  }

  // ─────────── the trailing-drawdown exit (as specified) ───────────
  onPositionConfirmed(position: Position) {
    position.netLiquidationValue = this.nlv(position);
    position.highWaterValue = position.netLiquidationValue;
    position.status = "OPEN";
    this.save(position);
  }

  onMarketUpdate(position: Position, netLiquidationValue: number) {
    if (position.status !== "OPEN") return;
    position.netLiquidationValue = netLiquidationValue;
    if (netLiquidationValue > position.highWaterValue) position.highWaterValue = netLiquidationValue;
    const exitThreshold = position.highWaterValue * (1 - config.trailingDrawdown);
    this.save(position);
    if (netLiquidationValue <= exitThreshold) {
      this.requestExit(position, `trailing drawdown ${Math.round(config.trailingDrawdown * 100)}%: NLV ${netLiquidationValue.toFixed(4)} ≤ ${exitThreshold.toFixed(4)} (high ${position.highWaterValue.toFixed(4)})`);
    } else if (config.takeProfitPct && netLiquidationValue >= position.costSol * (1 + config.takeProfitPct / 100)) {
      this.requestExit(position, `take-profit +${config.takeProfitPct}%`);
    } else if (config.stopLossPct && netLiquidationValue <= position.costSol * (1 - config.stopLossPct / 100)) {
      this.requestExit(position, `stop-loss -${config.stopLossPct}%`);
    }
  }

  requestExit(position: Position, reason: string) {
    if (position.status !== "OPEN") return;
    position.status = "EXIT_PENDING";
    position.exitReason = reason;
    this.save(position);
    this.requestFullExit(position).catch((e) => console.error("exit", e));
  }

  async requestFullExit(position: Position) {
    if (position.status !== "EXIT_PENDING" || position.exiting) return;
    if (position.mode === "browser") {
      this.approvals.set(position.mint, { mint: position.mint, symbol: position.symbol, side: "sell", createdAt: Date.now(), reason: position.exitReason ?? "exit" });
      this.onEvent?.(`⚠️ EXIT $${position.symbol} — approve the sell in your wallet: ${position.exitReason}`);
      return;
    }
    position.exiting = true;
    try {
      let proceeds: number, sig: string | undefined;
      if (position.mode === "keypair") {
        const f = await this.exec!.swap("sell", position.mint, "100%", position.costSol * 3);
        proceeds = f.solDelta; sig = f.signature;
      } else {
        proceeds = this.nlv(position);
        this.paperSol += proceeds; await this.store.put("paper_sol", this.paperSol);
      }
      await this.close(position, proceeds, sig);
    } catch (e) {
      position.exiting = false;                     // stays EXIT_PENDING; retried by the monitor loop
      this.onEvent?.(`⚠️ exit failed $${position.symbol}: ${(e as Error).message.slice(0, 100)} — retrying`);
    }
  }

  private async close(p: Position, proceeds: number, sig?: string) {
    p.status = "CLOSED"; p.proceedsSol = proceeds; p.pnlSol = proceeds - p.costSol; p.sellSignature = sig; p.closedAt = Date.now();
    await this.save(p);
    this.positions.delete(p.mint);
    this.approvals.delete(p.mint);
    this.todayPnl += p.pnlSol;
    this.onEvent?.(`${p.pnlSol >= 0 ? "✅" : "🔴"} EXIT $${p.symbol} ${p.pnlSol >= 0 ? "+" : ""}${p.pnlSol.toFixed(4)} SOL (${((p.pnlSol / p.costSol) * 100).toFixed(0)}%) — ${p.exitReason}`);
  }

  nlv(p: Position) {
    return liquidationValue(p.vs, p.vt, p.tokens, feePct(p.venue), config.priorityFeeSol, p.mode === "paper" ? config.paperSlippagePct : 0);
  }

  // ─────────── market data ───────────
  onTrade(t: TradeEvent) {
    const p = this.positions.get(t.mint);
    if (!p || p.venue !== "pump_bonding_curve" || !(t.vsol > 0)) return;
    p.vs = t.vsol; p.vt = t.vtok;
    if (t.side === "sell" && p.status === "OPEN") {
      if (t.wallet === p.meta.deployer) this.requestExit(p, "deployer sold");
      else if (p.meta.linked.includes(t.wallet)) this.requestExit(p, "linked wallet selling");
      else if (p.meta.whale && t.wallet === p.meta.whale) {
        p.meta.whaleSold += t.tokens;
        if (p.meta.whaleBag && p.meta.whaleSold >= p.meta.whaleBag * config.whaleExitPct / 100) this.requestExit(p, "largest holder dumping");
      }
    }
    this.onMarketUpdate(p, this.nlv(p));
  }

  /** Every 3 s: max hold, migration to PumpSwap (poll pool reserves), retry failed exits, re-prompt browser exits. */
  async monitor() {
    for (const p of this.positions.values()) {
      try {
        if (p.status === "OPEN" && Date.now() - p.openedAt > config.maxHoldMinutes * 60e3) this.requestExit(p, `max hold ${config.maxHoldMinutes} min`);
        if (p.status === "EXIT_PENDING" && !p.exiting && p.mode !== "browser") await this.requestFullExit(p);
        await this.checkMigration(p);
      } catch (e) { /* keep going */ }
    }
  }

  private async checkMigration(p: Position) {
    if (p.venue === "pump_bonding_curve") {
      const { bondingCurvePda, decodeCurve } = await import("../decoders/bonding-curve");
      const a = await this.rpc.call<any>("getAccountInfo", [bondingCurvePda(p.mint), { encoding: "base64", commitment: "confirmed" }]);
      if (!a?.value) return;
      const curve = decodeCurve(Buffer.from(a.value.data[0], "base64"), a.value.owner);
      if (!curve.complete) return;
      const pool = await findPool(this.rpc, p.mint);
      if (!pool) return;
      p.venue = "pumpswap"; p.meta.pool = pool;
      this.onEvent?.(`🔁 $${p.symbol} migrated to PumpSwap — valuing on the pool from now on`);
    }
    if (p.venue === "pumpswap" && p.meta.pool) {
      const r = await poolReserves(this.rpc, p.meta.pool);
      p.vs = r.vsol; p.vt = r.vtok;
      this.onMarketUpdate(p, this.nlv(p));
    }
  }

  // ─────────── browser wallet flow ───────────
  async prepareBrowserTx(mint: string, owner: string) {
    const a = this.approvals.get(mint);
    if (!a) throw new Error("nothing waiting for approval on this coin");
    if (a.side === "buy") return this.exec!.prepare(owner, "buy", mint, config.buySol, config.buySol);
    const p = this.positions.get(mint);
    if (!p) throw new Error("no open position");
    return this.exec!.prepare(owner, "sell", mint, "100%", p.costSol * 3);
  }

  async browserSubmitted(mint: string, owner: string, signature: string) {
    const a = this.approvals.get(mint);
    if (!a) throw new Error("nothing waiting for approval on this coin");
    await this.exec!.confirm(signature);
    const f = await this.exec!.measure(signature, owner, mint);
    if (a.side === "buy") {
      const s = this.selections.get(mint);
      this.approvals.delete(mint);
      if (!s || !s.reserves) throw new Error("selection expired");
      await this.open(s.launch, s.result, s.reserves, f.tokenDelta, -f.solDelta, signature);
    } else {
      const p = this.positions.get(mint); if (!p) return;
      await this.close(p, f.solDelta, signature);
    }
  }

  rejectApproval(mint: string) {
    const a = this.approvals.get(mint); if (!a) return;
    this.approvals.delete(mint);
    if (a.side === "sell") this.onEvent?.(`⚠️ exit for $${a.symbol} was declined in the wallet — it stays EXIT_PENDING`);
  }

  expireApprovals() {
    for (const [m, a] of this.approvals) if (a.side === "buy" && Date.now() - a.createdAt > 45_000) { this.approvals.delete(m); this.selections.delete(m); }
    for (const p of this.positions.values())               // re-offer browser exits that are still pending
      if (p.mode === "browser" && p.status === "EXIT_PENDING" && !this.approvals.has(p.mint))
        this.approvals.set(p.mint, { mint: p.mint, symbol: p.symbol, side: "sell", createdAt: Date.now(), reason: p.exitReason ?? "exit" });
  }
}
