/**
 * Live state of one launched token, built from its Transfer and Swap events:
 * holder balances, buys and sells per wallet (with ETH amounts), and price history.
 * When the coin is paired with something other than ETH, `ethRate` converts the paired side to ETH.
 */
import { formatEther } from "viem";
import { ADDR, INFRA, lc } from "../config";
import type { PoolSwap, TokenTransfer, Trade } from "../types";
import { ethPerToken } from "../chain/pool";

const ROUTERS = new Set([ADDR.poolManager, ADDR.universalRouter].map(lc));
const n = (x: bigint) => Number(formatEther(x < 0n ? -x : x));

export class TokenState {
  balances = new Map<string, bigint>();
  trades: Trade[] = [];
  prices: { at: number; p: number }[] = [];
  swapsByTx = new Map<string, PoolSwap>();
  private seen = new Set<string>();
  private pendingTransfers: TokenTransfer[] = [];

  ethRate = 1;                                   // ETH-wei per raw unit of the paired currency
  private routers: Set<string>;

  constructor(readonly token: string, readonly tokenIsCurrency0: boolean, readonly ignore: Set<string>, extraRouters: string[] = []) {
    this.routers = new Set([...ROUTERS, ...extraRouters.map(lc)]);
  }

  isHolder = (a: string) => !INFRA.has(a) && !this.ignore.has(a) && !this.routers.has(a) && a !== lc(this.token);

  addSwaps(s: PoolSwap[]) {
    for (const x of s) {
      this.swapsByTx.set(x.tx, x);
      this.prices.push({ at: x.at, p: ethPerToken(x.sqrtPriceX96, this.tokenIsCurrency0) * this.ethRate });
    }
    // transfers that arrived before their swap can now be priced
    const pend = this.pendingTransfers; this.pendingTransfers = [];
    this.applyTrades(pend);
  }

  addTransfers(ts: TokenTransfer[]) {
    const fresh = ts.filter((t) => { const k = `${t.tx}:${t.logIndex}`; if (this.seen.has(k)) return false; this.seen.add(k); return true; });
    for (const t of fresh) {
      if (this.isHolder(t.from)) this.balances.set(t.from, (this.balances.get(t.from) ?? 0n) - t.amount);
      if (this.isHolder(t.to)) this.balances.set(t.to, (this.balances.get(t.to) ?? 0n) + t.amount);
    }
    this.applyTrades(fresh);
  }

  private applyTrades(ts: TokenTransfer[]) {
    for (const t of ts) {
      const buy = this.routers.has(t.from) && this.isHolder(t.to);
      const sell = this.routers.has(t.to) && this.isHolder(t.from);
      if (!buy && !sell) continue;
      const s = this.swapsByTx.get(t.tx);
      if (!s) { if (!this.pendingTransfers.some((p) => p.tx === t.tx && p.logIndex === t.logIndex)) this.pendingTransfers.push(t); continue; }
      const ethLeg = this.tokenIsCurrency0 ? s.amount1 : s.amount0;
      this.trades.push({ tx: t.tx, block: t.block, wallet: buy ? t.to : t.from, side: buy ? "buy" : "sell", tokens: n(t.amount),
                         eth: n(ethLeg) * this.ethRate, priceEth: ethPerToken(s.sqrtPriceX96, this.tokenIsCurrency0) * this.ethRate, at: t.at });
    }
  }

  /** The paired currency's ETH value became known: re-price what was recorded so far. */
  setEthRate(r: number) {
    if (!(r > 0) || r === this.ethRate) return;
    const k = r / this.ethRate; this.ethRate = r;
    for (const t of this.trades) { t.eth *= k; if (t.priceEth !== null) t.priceEth *= k; }
    for (const x of this.prices) x.p *= k;
  }

  /** Transfers that moved tokens to a wallet without a swap (dev buy via extension, airdrops, direct sends). */
  balanceOf(a: string) { const v = this.balances.get(a); return v && v > 0n ? n(v) : 0; }
  holders() { return [...this.balances.entries()].filter(([, v]) => v > 0n).map(([a, v]) => [a, n(v)] as [string, number]).sort((x, y) => y[1] - x[1]); }
}
