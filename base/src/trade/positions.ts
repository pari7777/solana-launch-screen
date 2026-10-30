/**
 * Paper positions on Base:  OPEN → EXIT_PENDING → CLOSED
 * Exit rule (as specified): track NET LIQUIDATION VALUE — the ETH a full sell would return right now, quoted by
 * Uniswap's Quoter through the pool and its fee hook, minus gas. The high-water mark starts at the value on entry and
 * only rises; when value falls TRAILING_DRAWDOWN (35%) below it, the position is sold in full.
 * The creator selling, a linked wallet selling or the largest holder dumping also trigger a full exit.
 */
import { formatEther, parseEther } from "viem";
import type { PoolQuoter, Route } from "../chain/pool";
import { config, lc, PLATFORM_LABEL } from "../config";
import type { Store } from "../data/store";
import type { DecisionResult } from "../engine/decision";
import type { LaunchEvent, Quote, TokenTransfer } from "../types";

export type Status = "OPEN" | "EXIT_PENDING" | "CLOSED";
export interface Position {
  token: string; symbol: string; platform: string; mode: "paper"; wallet: null; status: Status; venue: string;
  tokens: number; costEth: number; netLiquidationValue: number; highWaterValue: number; openedAt: number; score: number;
  exitReason?: string; proceedsEth?: number; pnlEth?: number; closedAt?: number;
  meta: { route: Route; poolId: string; creator: string; linked: string[]; whale: string | null; whaleBag: number; whaleSold: number };
}

export class PositionManager {
  positions = new Map<string, Position>();
  paperEth = config.paperStartEth;
  private buyTimes: number[] = [];
  private todayPnl = 0;
  onEvent?: (msg: string) => void;
  onClosed?: (p: Position) => void;

  constructor(private store: Store, public quoter: PoolQuoter) {}

  async load() {
    const lastStart = await this.store.get<number | null>("paper_start_eth", null);
    if (lastStart !== config.paperStartEth) {
      this.paperEth = config.paperStartEth;
      await this.store.put("paper_eth", this.paperEth); await this.store.put("paper_start_eth", config.paperStartEth);
      if (lastStart !== null) console.log(`Paper balance reset: ${lastStart} → ${config.paperStartEth} ETH (PAPER_START_ETH changed)`);
    } else this.paperEth = await this.store.get("paper_eth", config.paperStartEth);
    this.todayPnl = (await this.store.pnlSummary()).today;
    for (const r of await this.store.openPositions()) {
      if (!r.meta?.route) continue;
      this.positions.set(r.mint, { token: r.mint, symbol: r.symbol, platform: r.meta.platform ?? "Clanker", mode: "paper", wallet: null, status: r.status, venue: r.venue,
        tokens: Number(r.tokens), costEth: Number(r.cost_sol), netLiquidationValue: Number(r.net_liquidation_value ?? 0),
        highWaterValue: Number(r.high_water_value ?? 0), openedAt: new Date(r.opened_at).getTime(), score: Number(r.score ?? 0),
        exitReason: r.exit_reason ?? undefined, meta: r.meta });
    }
    return [...this.positions.values()];
  }
  private save(p: Position) { return this.store.savePosition({ ...p, meta: { ...p.meta, platform: p.platform } }).catch((e) => console.error("save_position", e.message)); }

  canAutoBuy(): string | null {
    if (config.paused) return "bot paused";
    if (this.positions.size >= config.maxOpen) return "max open positions";
    this.buyTimes = this.buyTimes.filter((t) => t > Date.now() - 3600e3);
    if (this.buyTimes.length >= config.maxBuysPerHour) return "hourly buy limit";
    if (this.todayPnl <= -config.dailyLossEth) return "daily loss limit";
    if (this.paperEth < config.buyEth + config.gasEth) return "paper balance too low";
    return null;
  }

  async onSelected(s: { launch: LaunchEvent; route: Route; result: DecisionResult; quote: Quote | null }): Promise<string> {
    const { launch, route, result } = s;
    const platform = PLATFORM_LABEL[launch.platform];
    try {
      const out = await this.quoter.buy(route, parseEther(String(config.buyEth)));
      const tokens = Number(formatEther(out)) * (1 - config.paperSlippagePct / 100);
      const cost = config.buyEth + config.gasEth;
      this.paperEth -= cost; await this.store.put("paper_eth", this.paperEth);
      this.buyTimes.push(Date.now());
      const r = result.output;
      const p: Position = {
        token: lc(launch.token), symbol: launch.symbol, platform, mode: "paper", wallet: null, status: "OPEN", venue: "launch_v4",
        tokens, costEth: cost, netLiquidationValue: 0, highWaterValue: 0, openedAt: Date.now(), score: result.score,
        meta: { route, poolId: lc(launch.poolId), creator: lc(launch.creator), linked: r.launch_wallet.linked_wallet_clusters.flatMap((c) => c.wallets),
                whale: result.topHolder, whaleBag: result.topHolderTokens, whaleSold: 0 },
      };
      this.positions.set(p.token, p);
      await this.onPositionConfirmed(p);
      this.onEvent?.(`🟢 PAPER BUY $${p.symbol} ${cost.toFixed(5)} ETH → NLV ${p.netLiquidationValue.toFixed(5)} · exits ${Math.round(config.trailingDrawdown * 100)}% below its high`);
      return `paper-bought ${config.buyEth} ETH`;
    } catch (e) { return `buy failed: ${(e as Error).message.slice(0, 90)}`; }
  }

  // ── the trailing-drawdown exit, as specified ──
  async onPositionConfirmed(position: Position) {
    position.netLiquidationValue = await this.nlv(position).catch(() => position.costEth * 0.9);
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
    if (netLiquidationValue <= exitThreshold)
      this.requestExit(position, `trailing drawdown ${Math.round(config.trailingDrawdown * 100)}%: NLV ${netLiquidationValue.toFixed(5)} ≤ ${exitThreshold.toFixed(5)} (high ${position.highWaterValue.toFixed(5)})`);
    else if (config.takeProfitPct && netLiquidationValue >= position.costEth * (1 + config.takeProfitPct / 100)) this.requestExit(position, `take-profit +${config.takeProfitPct}%`);
    else if (config.stopLossPct && netLiquidationValue <= position.costEth * (1 - config.stopLossPct / 100)) this.requestExit(position, `stop-loss -${config.stopLossPct}%`);
  }

  requestExit(position: Position, reason: string) {
    if (position.status !== "OPEN") return;
    position.status = "EXIT_PENDING"; position.exitReason = reason; this.save(position);
    this.requestFullExit(position).catch(() => {});
  }

  async requestFullExit(p: Position) {
    if (p.status !== "EXIT_PENDING") return;
    try {
      const proceeds = await this.nlv(p);
      this.paperEth += proceeds; await this.store.put("paper_eth", this.paperEth);
      p.status = "CLOSED"; p.proceedsEth = proceeds; p.pnlEth = proceeds - p.costEth; p.closedAt = Date.now();
      await this.save(p);
      this.positions.delete(p.token); this.todayPnl += p.pnlEth;
      this.onClosed?.(p);
      this.onEvent?.(`${p.pnlEth >= 0 ? "✅" : "🔴"} PAPER EXIT $${p.symbol} ${p.pnlEth >= 0 ? "+" : ""}${p.pnlEth.toFixed(5)} ETH (${((p.pnlEth / p.costEth) * 100).toFixed(0)}%) — ${p.exitReason}`);
    } catch (e) { this.onEvent?.(`⚠️ exit quote failed $${p.symbol}: ${(e as Error).message.slice(0, 80)} — retrying`); }
  }

  async nlv(p: Position) {
    const v = await this.quoter.liquidationValue(p.meta.route, p.tokens);
    return Math.max(0, v * (1 - config.paperSlippagePct / 100) - config.gasEth);
  }

  /** Insider exits from the token's Transfer logs (sells go to the PoolManager / router / platform hook). */
  onTransfers(token: string, ts: TokenTransfer[], isSell: (t: TokenTransfer) => boolean) {
    const p = this.positions.get(token); if (!p || p.status !== "OPEN") return;
    for (const t of ts) {
      if (!isSell(t)) continue;
      const amt = Number(formatEther(t.amount));
      if (t.from === p.meta.creator) return this.requestExit(p, "creator sold");
      if (p.meta.linked.includes(t.from)) return this.requestExit(p, "linked wallet selling");
      if (p.meta.whale && t.from === p.meta.whale) {
        p.meta.whaleSold += amt;
        if (p.meta.whaleBag && p.meta.whaleSold >= p.meta.whaleBag * config.whaleExitPct / 100) return this.requestExit(p, "largest holder dumping");
      }
    }
  }

  /** Every few seconds: re-value each position, max hold, retry failed exits. */
  async monitor() {
    for (const p of [...this.positions.values()]) {
      try {
        if (p.status === "OPEN" && Date.now() - p.openedAt > config.maxHoldMinutes * 60e3) this.requestExit(p, `max hold ${config.maxHoldMinutes} min`);
        if (p.status === "EXIT_PENDING") { await this.requestFullExit(p); continue; }
        this.onMarketUpdate(p, await this.nlv(p));
      } catch { /* next tick */ }
    }
  }
}
