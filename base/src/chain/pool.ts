/**
 * Clanker v4 pools on Uniswap v4: rebuild the pool key from the launch event, read prices, and get
 * executable quotes from Uniswap's own Quoter. Quotes run the pool's hook, so they include Clanker's
 * dynamic fee AND the falling "sniper fee" charged in the first seconds/minutes after launch.
 */
import { encodeAbiParameters, keccak256, parseEther, formatEther, type PublicClient } from "viem";
import { ADDR, lc } from "../config";
import type { Hex, PoolKey, Quote } from "../types";
import { QUOTER_ABI } from "./abi";
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

/** WETH per token from a v4 sqrtPriceX96 (both sides have 18 decimals on Clanker/WETH pools). */
export function ethPerToken(sqrtPriceX96: bigint, tokenIsCurrency0: boolean) {
  const r = Number(sqrtPriceX96) / 2 ** 96;
  const p = r * r;                                   // currency1 per currency0
  return tokenIsCurrency0 ? p : 1 / p;
}
export const ethPerTokenFromTick = (tick: number, tokenIsCurrency0: boolean) => {
  const p = Math.pow(1.0001, tick);
  return tokenIsCurrency0 ? p : 1 / p;
};

export class PoolQuoter {
  constructor(private client: PublicClient) {}

  async quote(key: PoolKey, ethIsInput: boolean, amount: bigint): Promise<bigint> {
    const wethIs0 = lc(key.currency0) === lc(ADDR.weth);
    const zeroForOne = ethIsInput ? wethIs0 : !wethIs0;
    const r = await timed(() => this.client.simulateContract({
      address: ADDR.quoter as Hex, abi: QUOTER_ABI, functionName: "quoteExactInputSingle",
      args: [{ poolKey: key, zeroForOne, exactAmount: amount, hookData: "0x" }],
    }));
    return (r.result as readonly [bigint, bigint])[0];
  }

  buy = (key: PoolKey, ethWei: bigint) => this.quote(key, true, ethWei);
  sell = (key: PoolKey, tokenWei: bigint) => this.quote(key, false, tokenWei);

  /** Full executable picture for a buy of `buyEth`, plus "sell after the whale / after the insiders" stress tests. */
  async analyse(key: PoolKey, buyEth: number, whaleTokens: number, clusterTokens: number): Promise<Quote> {
    const tiny = parseEther("0.0001"), size = parseEther(String(buyEth));
    const [tinyTok, sizeTok] = await Promise.all([this.buy(key, tiny), this.buy(key, size)]);
    if (tinyTok === 0n || sizeTok === 0n) throw new Error("pool returned zero tokens");
    const w = BigInt(Math.floor(whaleTokens)) * 10n ** 18n, c = BigInt(Math.floor(clusterTokens)) * 10n ** 18n;
    const [tinyBack, sizeBack, whaleOnly, whalePlus, clusterOnly, clusterPlus] = await Promise.all([
      this.sell(key, tinyTok), this.sell(key, sizeTok),
      w > 0n ? this.sell(key, w) : Promise.resolve(0n), w > 0n ? this.sell(key, w + sizeTok) : Promise.resolve(0n),
      c > 0n ? this.sell(key, c) : Promise.resolve(0n), c > 0n ? this.sell(key, c + sizeTok) : Promise.resolve(0n),
    ]);
    const n = (x: bigint) => Number(formatEther(x));
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
  async liquidationValue(key: PoolKey, tokens: number) {
    if (tokens <= 0) return 0;
    return Number(formatEther(await this.sell(key, parseEther(tokens.toFixed(18)))));
  }
}
