/** Market context: SOL/USD, priority-fee pressure, RPC slot lag, and venue-aware fees. */
import { config, isLiveKeypair } from "../config";
import type { Rpc } from "./rpc";
import type { Venue } from "../types";
import { PUMP_PROGRAM } from "../decoders/pump-launch";

export const feePct = (venue: Venue) =>
  (venue === "pumpswap" ? config.pumpswapFeePct : config.pumpFeePct) + (isLiveKeypair() || config.mode === "browser" ? config.platformFeePct : 0);

export class MarketData {
  solUsd: number | null = null;
  priorityFeeMicroLamports: number | null = null;   // median recent priority fee on pump.fun accounts
  rpcSlot: number | null = null;
  streamSlot: number | null = null;
  private timers: NodeJS.Timeout[] = [];
  onSlot?: (slot: number) => void;
  constructor(private rpc: Rpc) {}

  get rpcLagSlots() { return this.rpcSlot && this.streamSlot ? this.streamSlot - this.rpcSlot : null; }

  start() {
    const every = (ms: number, f: () => Promise<void>) => { f().catch(() => {}); this.timers.push(setInterval(() => f().catch(() => {}), ms)); };
    every(60_000, () => this.price());
    every(5_000, async () => { this.rpcSlot = await this.rpc.call<number>("getSlot", [{ commitment: "processed" }]); this.onSlot?.(this.rpcSlot); });
    every(15_000, async () => {
      const r = await this.rpc.call<any[]>("getRecentPrioritizationFees", [[PUMP_PROGRAM]]);
      const v = r.map((x) => x.prioritizationFee).sort((a, b) => a - b);
      this.priorityFeeMicroLamports = v.length ? v[Math.floor(v.length / 2)] : null;
    });
  }
  stop() { this.timers.forEach(clearInterval); }

  private async price() {
    const srcs: [string, (j: any) => number][] = [
      ["https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd", (j) => j.solana.usd],
      ["https://api.binance.com/api/v3/ticker/price?symbol=SOLUSDT", (j) => Number(j.price)],
      ["https://api.kraken.com/0/public/Ticker?pair=SOLUSD", (j) => Number((Object.values(j.result)[0] as any).c[0])],
    ];
    for (const [url, pick] of srcs) {
      try {
        const r = await fetch(url, { signal: AbortSignal.timeout(6000) });
        const v = pick(await r.json());
        if (v > 0) { this.solUsd = v; return; }
      } catch { /* next source */ }
    }
  }
}
