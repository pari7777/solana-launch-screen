/**
 * Launch pools on Uniswap v4: rebuild pool keys, read prices, and get executable quotes from Uniswap's own Quoter.
 * Quotes run the pool's hook, so they include each platform's dynamic fees (e.g. Clanker's falling "sniper fee").
 *
 * A coin is not always paired with ETH (Zora content coins are backed by a creator coin or ZORA), so every quote
 * runs along a ROUTE: launch pool → backing coin's own pool(s) → ETH. Backing Zora coins are followed through their
 * getPoolKey(); any other backing token is priced against WETH on Uniswap v3.
 */
import { encodeAbiParameters, keccak256, parseEther, formatEther, type PublicClient } from "viem";
import { ADDR, ETH_LIKE, lc, PLATFORM_ADDR } from "../config";
import type { Hex, PoolKey, Quote } from "../types";
import { QUOTER_ABI, V3_QUOTER_ABI, ZORA_COIN_ABI } from "./abi";
import { timed } from "./client";

export const DYNAMIC_FEE_FLAG = 0x800000;
const TICK_SPACINGS = [200, 60, 10, 100, 1, 50, 20, 120, 500, 2000];
const FEES = [DYNAMIC_FEE_FLAG, 10000, 3000, 500, 100];

export function poolId(k: PoolKey): Hex {
  return keccak256(encodeAbiParameters(
    [{ type: "address" }, { type: "address" }, { type: "uint24" }, { type: "int24" }, { type: "address" }],
    [k.currency0, k.currency1, k.fee, k.tickSpacing, k.hooks]));
}

/** The launch event carries the pool id but not the full key; try the few possible fee/spacing values until the id matches. */
export function recoverPoolKey(token: Hex, paired: Hex, hook: Hex, id: Hex): PoolKey | null {
  const [c0, c1] = lc(token) < lc(paired) ? [token, paired] : [paired, token];
  for (const fee of FEES) for (const tickSpacing of TICK_SPACINGS) {
    const k = { currency0: c0, currency1: c1, fee, tickSpacing, hooks: hook };
    if (lc(poolId(k)) === lc(id)) return k;
  }
  return null;
}

/** Paired-token units per token from a v4 sqrtPriceX96 (raw units; multiply by the route's ETH rate for ETH). */
export function ethPerToken(sqrtPriceX96: bigint, tokenIsCurrency0: boolean) {
  const r = Number(sqrtPriceX96) / 2 ** 96;
  const p = r * r;                                   // currency1 per currency0
  return tokenIsCurrency0 ? p : 1 / p;
}
export const ethPerTokenFromTick = (tick: number, tokenIsCurrency0: boolean) => {
  const p = Math.pow(1.0001, tick);
  return tokenIsCurrency0 ? p : 1 / p;
};

export type Hop = { kind: "v4"; key: PoolKey } | { kind: "v3"; fee: number };
/** path[0] = launched token … path[n] = an ETH-like currency; hops[i] swaps path[i] ⇄ path[i+1]. */
export interface Route { path: Hex[]; hops: Hop[] }
const other = (k: PoolKey, c: string) => (lc(k.currency0) === lc(c) ? k.currency1 : k.currency0);

export class PoolQuoter {
  private backing = new Map<string, Promise<{ path: Hex[]; hops: Hop[] }>>();
  constructor(private client: PublicClient) {}

  private async hop(h: Hop, tokenIn: Hex, tokenOut: Hex, amount: bigint): Promise<bigint> {
    if (amount === 0n) return 0n;
    if (h.kind === "v4") {
      const r = await timed(() => this.client.simulateContract({
        address: ADDR.quoter as Hex, abi: QUOTER_ABI, functionName: "quoteExactInputSingle",
        args: [{ poolKey: h.key, zeroForOne: lc(tokenIn) === lc(h.key.currency0), exactAmount: amount, hookData: "0x" }],
      }));
      return (r.result as readonly [bigint, bigint])[0];
    }
    const w = (x: Hex) => (ETH_LIKE.has(lc(x)) ? ADDR.weth as Hex : x);
    const r = await timed(() => this.client.simulateContract({
      address: PLATFORM_ADDR.v3Quoter as Hex, abi: V3_QUOTER_ABI, functionName: "quoteExactInputSingle",
      args: [{ tokenIn: w(tokenIn), tokenOut: w(tokenOut), amountIn: amount, fee: h.fee, sqrtPriceLimitX96: 0n }],
    }));
    return (r.result as readonly bigint[])[0];
  }

  /** How a backing currency reaches ETH (cached). */
  private backingRoute(c: Hex, depth = 0): Promise<{ path: Hex[]; hops: Hop[] }> {
    if (ETH_LIKE.has(lc(c))) return Promise.resolve({ path: [c], hops: [] });
    const hit = this.backing.get(lc(c)); if (hit) return hit;
    const p = (async () => {
      if (depth < 3) {
        const key = await timed(() => this.client.readContract({ address: c, abi: ZORA_COIN_ABI, functionName: "getPoolKey" })).catch(() => null) as any;
        if (key?.currency0) {
          const k: PoolKey = { currency0: key.currency0, currency1: key.currency1, fee: Number(key.fee), tickSpacing: Number(key.tickSpacing), hooks: key.hooks };
          const rest = await this.backingRoute(other(k, c) as Hex, depth + 1);
          return { path: [c, ...rest.path], hops: [{ kind: "v4", key: k } as Hop, ...rest.hops] };
        }
      }
      let best: { fee: number; out: bigint } | null = null;
      for (const fee of [10000, 3000, 500]) {
        const out = await this.hop({ kind: "v3", fee }, c, ADDR.weth as Hex, 10n ** 18n).catch(() => 0n);
        if (out > (best?.out ?? 0n)) best = { fee, out };
      }
      if (!best) throw new Error(`no ETH route for backing token ${c.slice(0, 10)}…`);
      return { path: [c, ADDR.weth as Hex], hops: [{ kind: "v3", fee: best.fee } as Hop] };
    })();
    this.backing.set(lc(c), p);
    p.catch(() => setTimeout(() => this.backing.delete(lc(c)), 10 * 60e3));   // retry a failed lookup later
    return p;
  }

  async route(token: Hex, key: PoolKey): Promise<Route> {
    const rest = await this.backingRoute(other(key, token) as Hex);
    return { path: [token, ...rest.path], hops: [{ kind: "v4", key }, ...rest.hops] };
  }

  /** ETH-wei per raw unit of the paired currency (1 when paired with ETH) — converts pool swap amounts to ETH. */
  async pairedEthRate(r: Route): Promise<number> {
    if (r.hops.length === 1) return 1;
    const unit = 10n ** 15n;
    let amt = unit;
    for (let i = 1; i < r.hops.length; i++) amt = await this.hop(r.hops[i], r.path[i], r.path[i + 1], amt);
    return Number(amt) / Number(unit);
  }

  async buy(r: Route, ethWei: bigint): Promise<bigint> {
    let amt = ethWei;
    for (let i = r.hops.length - 1; i >= 0; i--) amt = await this.hop(r.hops[i], r.path[i + 1], r.path[i], amt);
    return amt;
  }
  async sell(r: Route, tokenWei: bigint): Promise<bigint> {
    let amt = tokenWei;
    for (let i = 0; i < r.hops.length; i++) amt = await this.hop(r.hops[i], r.path[i], r.path[i + 1], amt);
    return amt;
  }

  /** Full executable picture for a buy of `buyEth`, plus "sell after the whale / after the insiders" stress tests. */
  async analyse(key: Route, buyEth: number, whaleTokens: number, clusterTokens: number): Promise<Quote> {
    const tiny = parseEther("0.0001"), size = parseEther(String(buyEth));
    const [tinyTok, sizeTok] = await Promise.all([this.buy(key, tiny), this.buy(key, size)]);
    if (tinyTok === 0n || sizeTok === 0n) throw new Error("pool returned zero tokens");
    const w = BigInt(Math.floor(whaleTokens)) * 10n ** 18n, c = BigInt(Math.floor(clusterTokens)) * 10n ** 18n;
    const [tinyBack, sizeBack, whaleOnly, whalePlus, clusterOnly, clusterPlus] = await Promise.all([
      this.sell(key, tinyTok), this.sell(key, sizeTok),
      w > 0n ? this.sell(key, w) : Promise.resolve(0n), w > 0n ? this.sell(key, w + sizeTok) : Promise.resolve(0n),
      c > 0n ? this.sell(key, c) : Promise.resolve(0n), c > 0n ? this.sell(key, c + sizeTok) : Promise.resolve(0n),
    ]);    const n = (x: bigint) => Number(formatEther(x));
    const tinyRate = n(tinyTok) / 0.0001, sizeRate = n(sizeTok) / buyEth;            // tokens per ETH
    const tinySellRate = n(tinyBack) / n(tinyTok), sizeSellRate = n(sizeBack) / n(sizeTok);
    const exitAfter = (only: bigint, plus: bigint) => (plus > only ? n(plus - only) : n(sizeBack));
    const r2 = (x: number) => Math.round(x * 100) / 100;
    return {
      spotEthPerToken: 1 / tinyRate,
      tokensForBuy: n(sizeTok),
      buyImpactPct: r2((tinyRate / sizeRate - 1) * 100),
      sellImpactPct: r2((1 - sizeSellRate / tinySellRate) * 100),
      roundTripPct: r2((1 - n(sizeBack) / buyEth) * 100),
      dumpStressLossPct: r2((1 - (w > 0n ? exitAfter(whaleOnly, whalePlus) : n(sizeBack)) / buyEth) * 100),
      clusterDumpLossPct: r2((1 - (c > 0n ? exitAfter(clusterOnly, clusterPlus) : n(sizeBack)) / buyEth) * 100),
      feeNow: r2((1 - n(tinyBack) / 0.0001) * 100),
      at: Date.now(),
    };
  }

  /** What selling `tokens` right now would pay, in ETH (net of pool + hook fees). */
  async liquidationValue(key: Route, tokens: number) {
    if (tokens <= 0) return 0;
    return Number(formatEther(await this.sell(key, parseEther(tokens.toFixed(18)))));
  }
}
