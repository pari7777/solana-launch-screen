/**
 * Polls Base for new blocks and pulls, per block range:
 *   1. Clanker TokenCreated events (new launches)
 *   2. ERC-20 Transfer events of every watched token (holders, buys, sells, creator dumps)
 *   3. Uniswap v4 Swap events of every watched pool (price and ETH amounts)
 * Launches found in a range are watched within the same pass, so their first trades are never missed.
 */
import type { PublicClient } from "viem";
import { ADDR, config } from "../config";
import type { Hex, LaunchEvent, PoolSwap, TokenTransfer } from "../types";
import { SWAP, TOKEN_CREATED, TRANSFER } from "./abi";
import { timed } from "./client";

export interface WatcherHandlers {
  onLaunch: (l: LaunchEvent) => void;
  onBackfill?: (l: LaunchEvent) => Promise<void>;
  onTransfers: (token: string, t: TokenTransfer[]) => void;
  onSwaps: (poolId: string, s: PoolSwap[]) => void;
  onState?: (state: string, ok: boolean, block?: number) => void;
}

const chunk = <T>(a: T[], n: number) => Array.from({ length: Math.ceil(a.length / n) }, (_, i) => a.slice(i * n, i * n + n));

export class ChainWatcher {
  cursor = 0n;
  head = 0n;
  state = "starting";
  tokens = new Set<string>();
  pools = new Set<string>();
  private blockTimes = new Map<bigint, number>();
  private stopped = false;
  constructor(private client: PublicClient, private h: WatcherHandlers) {}

  watchToken(token: string, poolId: string) { this.tokens.add(token.toLowerCase()); this.pools.add(poolId.toLowerCase()); }
  unwatchToken(token: string, poolId: string) { this.tokens.delete(token.toLowerCase()); this.pools.delete(poolId.toLowerCase()); }

  async start() {
    this.head = await timed(() => this.client.getBlockNumber());
    this.cursor = this.head - 1n;
    void this.loop();
  }
  stop() { this.stopped = true; }

  /** Load the last N hours of Clanker launches so creator history works from the first minute. */
  async backfill(hours = config.backfillHours) {
    if (!this.h.onBackfill || hours <= 0) return 0;
    const head = this.head || (await this.client.getBlockNumber());
    const from = head - BigInt(Math.round(hours * 1800));               // Base: ~2 s blocks
    let n = 0;
    for (let a = from; a < head; a += BigInt(config.maxBlockRange)) {
      const b = a + BigInt(config.maxBlockRange) - 1n < head ? a + BigInt(config.maxBlockRange) - 1n : head;
      try {
        const logs = await timed(() => this.client.getLogs({ address: ADDR.clankerFactory as Hex, event: TOKEN_CREATED, fromBlock: a, toBlock: b }));
        for (const log of logs) { const l = this.toLaunch(log, Date.now() - Number(head - log.blockNumber) * 2000); if (l) { await this.h.onBackfill(l); n++; } }
      } catch { /* skip a failed chunk */ }
    }
    return n;
  }

  private async loop() {
    while (!this.stopped) {
      const t0 = Date.now();
      try {
        this.head = await timed(() => this.client.getBlockNumber());
        if (this.head > this.cursor) {
          const from = this.cursor + 1n;
          const to = this.head - from > BigInt(config.maxBlockRange) ? from + BigInt(config.maxBlockRange) - 1n : this.head;
          await this.scan(from, to);
          this.cursor = to;
        }
        if (this.state !== "connected") { this.state = "connected"; this.h.onState?.("connected", true, Number(this.head)); }
      } catch (e) {
        this.state = `retrying (${String((e as Error).message).slice(0, 50)})`;
        this.h.onState?.(this.state, false);
      }
      await new Promise((r) => setTimeout(r, Math.max(200, config.pollMs - (Date.now() - t0))));
    }
  }

  private async blockTime(n: bigint) {
    const hit = this.blockTimes.get(n); if (hit) return hit;
    const b = await timed(() => this.client.getBlock({ blockNumber: n }));
    const ms = Number(b.timestamp) * 1000;
    this.blockTimes.set(n, ms); if (this.blockTimes.size > 500) this.blockTimes.delete(this.blockTimes.keys().next().value!);
    return ms;
  }

  private toLaunch(log: any, at: number): LaunchEvent | null {
    const a = log.args; if (!a?.tokenAddress) return null;
    return {
      signature: log.transactionHash, instructionIndex: Number(log.logIndex), slot: Number(log.blockNumber),
      token: a.tokenAddress, creator: a.tokenAdmin, sender: a.msgSender, name: a.tokenName ?? "", symbol: a.tokenSymbol ?? "",
      image: a.tokenImage ?? "", metadata: a.tokenMetadata ?? "", context: a.tokenContext ?? "", startingTick: Number(a.startingTick),
      hook: a.poolHook, poolId: a.poolId, pairedToken: a.pairedToken, locker: a.locker, mevModule: a.mevModule,
      extensionsSupply: a.extensionsSupply ?? 0n, extensions: a.extensions ?? [], receivedAt: Date.now(), blockTime: Math.floor(at / 1000),
    };
  }

  private async scan(from: bigint, to: bigint) {
    const launches = await timed(() => this.client.getLogs({ address: ADDR.clankerFactory as Hex, event: TOKEN_CREATED, fromBlock: from, toBlock: to }));
    for (const log of launches) {
      const l = this.toLaunch(log, await this.blockTime(log.blockNumber).catch(() => Date.now()));
      if (l) this.h.onLaunch(l);                             // onLaunch calls watchToken synchronously
    }
    const tokens = [...this.tokens], pools = [...this.pools];
    const [transferLogs, swapLogs] = await Promise.all([
      Promise.all(chunk(tokens, 40).map((ts) => timed(() => this.client.getLogs({ address: ts as Hex[], event: TRANSFER, fromBlock: from, toBlock: to })))),
      Promise.all(chunk(pools, 40).map((ps) => timed(() => this.client.getLogs({ address: ADDR.poolManager as Hex, event: SWAP, args: { id: ps as Hex[] }, fromBlock: from, toBlock: to })))),
    ]);
    const now = Date.now();
    const byToken = new Map<string, TokenTransfer[]>();
    for (const log of transferLogs.flat() as any[]) {
      const k = String(log.address).toLowerCase();
      (byToken.get(k) ?? byToken.set(k, []).get(k)!).push({ tx: log.transactionHash, logIndex: Number(log.logIndex), block: Number(log.blockNumber),
        from: String(log.args.from).toLowerCase(), to: String(log.args.to).toLowerCase(), amount: log.args.value, at: now });
    }
    for (const [k, v] of byToken) this.h.onTransfers(k, v);
    const byPool = new Map<string, PoolSwap[]>();
    for (const log of swapLogs.flat() as any[]) {
      const k = String(log.args.id).toLowerCase();
      (byPool.get(k) ?? byPool.set(k, []).get(k)!).push({ tx: log.transactionHash, logIndex: Number(log.logIndex), block: Number(log.blockNumber),
        sqrtPriceX96: log.args.sqrtPriceX96, amount0: log.args.amount0, amount1: log.args.amount1, at: now });
    }
    for (const [k, v] of byPool) this.h.onSwaps(k, v);
  }
}
