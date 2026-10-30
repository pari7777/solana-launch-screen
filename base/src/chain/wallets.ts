/**
 * Wallet history on Base: how active (nonce), how old (first transaction) and who funded it.
 * Uses the chain itself for the nonce and Blockscout's free, keyless API for history.
 * A funder that has sent thousands of transactions is an exchange / service wallet — links through it are ignored.
 */
import type { PublicClient } from "viem";
import { config } from "../config";
import type { Hex, WalletTrace } from "../types";
import { timed } from "./client";

type Entry<T> = { until: number; p: Promise<T> };

export class WalletTracer {
  private cache = new Map<string, Entry<WalletTrace>>();
  private nonces = new Map<string, Entry<number>>();
  onTrace?: (t: WalletTrace) => void;
  explorerOk = 0; explorerFail = 0;
  constructor(private client: PublicClient, private fetchJson: (url: string) => Promise<any> = defaultFetch) {}

  private cached<T>(m: Map<string, Entry<T>>, k: string, ttl: number, f: () => Promise<T>) {
    const hit = m.get(k);
    if (hit && hit.until > Date.now()) return hit.p;
    const p = f(); p.catch(() => m.delete(k));
    m.set(k, { until: Date.now() + ttl, p });
    if (m.size > 20000) for (const [key, v] of m) if (v.until < Date.now()) m.delete(key);
    return p;
  }

  nonce(w: string) {
    return this.cached(this.nonces, w.toLowerCase(), 3600e3, () => timed(() => this.client.getTransactionCount({ address: w as Hex })));
  }

  trace(w: string) { return this.cached(this.cache, w.toLowerCase(), 6 * 3600e3, () => this.doTrace(w)); }

  private async doTrace(wallet: string): Promise<WalletTrace> {
    const addr = wallet.toLowerCase();
    const [txCount, code] = await Promise.all([this.nonce(addr), timed(() => this.client.getCode({ address: addr as Hex }))]);
    const t: WalletTrace = { wallet: addr, txCount, ageHours: null, isContract: !!code && code !== "0x",
                             funder: null, funderIsService: null, fundingTx: null };
    // earliest transactions touching the wallet (normal + internal): the first one bringing ETH in is the funder
    const [normal, internal] = await Promise.all([
      this.explorer({ action: "txlist", address: addr, sort: "asc", page: "1", offset: "10" }),
      this.explorer({ action: "txlistinternal", address: addr, sort: "asc", page: "1", offset: "10" }),
    ]);
    const all = [...(normal ?? []), ...(internal ?? [])].filter((x: any) => x?.timeStamp)
      .sort((a: any, b: any) => Number(a.timeStamp) - Number(b.timeStamp));
    if (all.length) t.ageHours = Math.round((Date.now() / 1000 - Number(all[0].timeStamp)) / 36) / 100;
    const inbound = all.find((x: any) => String(x.to).toLowerCase() === addr && BigInt(x.value ?? 0) > 0n && String(x.from).toLowerCase() !== addr);
    if (inbound) {
      t.funder = String(inbound.from).toLowerCase();
      t.fundingTx = String(inbound.hash ?? inbound.transactionHash ?? "");
      try { t.funderIsService = (await this.nonce(t.funder)) >= config.serviceNonce; } catch { t.funderIsService = null; }
    }
    this.onTrace?.(t);
    return t;
  }

  private async explorer(q: Record<string, string>): Promise<any[] | null> {
    const url = `${config.explorerApi}?module=account&${new URLSearchParams(q)}`;
    try {
      const j = await this.fetchJson(url);
      this.explorerOk++;
      return Array.isArray(j?.result) ? j.result : [];
    } catch { this.explorerFail++; return null; }
  }
}

async function defaultFetch(url: string) {
  const r = await fetch(url, { signal: AbortSignal.timeout(4000), headers: { accept: "application/json" } });
  if (!r.ok) throw new Error(`explorer HTTP ${r.status}`);
  return r.json();
}
