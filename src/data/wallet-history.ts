/**
 * Wallet history: age, activity, who funded the wallet, and whether that funder is an exchange/service.
 * Results are cached and in-flight requests are shared, so a busy creator is traced only once.
 */
import type { WalletTrace } from "../types";
import type { Rpc } from "./rpc";
import { config } from "../config";

type Entry<T> = { until: number; p: Promise<T> };

export class WalletTracer {
  private wallets = new Map<string, Entry<WalletTrace>>();
  private services = new Map<string, Entry<boolean>>();
  onTrace?: (t: WalletTrace) => void;
  constructor(private rpc: Rpc) {}

  private cached<T>(m: Map<string, Entry<T>>, key: string, ttlMs: number, f: () => Promise<T>): Promise<T> {
    const hit = m.get(key);
    if (hit && hit.until > Date.now()) return hit.p;
    const p = f();
    p.catch(() => m.delete(key));              // never cache failures
    m.set(key, { until: Date.now() + ttlMs, p });
    if (m.size > 20000) for (const [k, v] of m) if (v.until < Date.now()) m.delete(k);
    return p;
  }

  trace(wallet: string) { return this.cached(this.wallets, wallet, 6 * 3600e3, () => this.doTrace(wallet)); }
  isService(wallet: string) { return this.cached(this.services, wallet, 24 * 3600e3, () => this.doService(wallet)); }

  private async doTrace(wallet: string): Promise<WalletTrace> {
    const sigs = await this.rpc.call<any[]>("getSignaturesForAddress", [wallet, { limit: 1000 }]);
    const n = sigs.length;
    const times = sigs.map((s) => s.blockTime).filter(Boolean) as number[];
    const ageHours = times.length ? (Date.now() / 1000 - Math.min(...times)) / 3600 : 0;
    const t: WalletTrace = { wallet, txCount: n, ageHours: Math.round(ageHours * 100) / 100, old: n >= 1000,
      funder: null, funderIsService: null, fundingSignature: null, fundingSlot: null, fundingLamports: null };
    if (n > 0 && n < 1000) {
      const first = sigs[n - 1];
      const tx = await this.rpc.call<any>("getTransaction", [first.signature,
        { encoding: "jsonParsed", maxSupportedTransactionVersion: 0, commitment: "confirmed" }]);
      const f = findFunder(tx, wallet);
      if (f) {
        Object.assign(t, { funder: f.source, fundingSignature: first.signature, fundingSlot: first.slot ?? tx?.slot ?? null,
                           fundingLamports: f.lamports });
        try { t.funderIsService = await this.isService(f.source); } catch { t.funderIsService = null; }
      }
    }
    this.onTrace?.(t);
    return t;
  }

  /** Exchanges and bots: 1000 signatures inside SERVICE_SPAN_MINUTES. Funding links through them mean nothing. */
  private async doService(wallet: string) {
    const sigs = await this.rpc.call<any[]>("getSignaturesForAddress", [wallet, { limit: 1000 }]);
    if (sigs.length < 1000) return false;
    const t = sigs.map((s) => s.blockTime).filter(Boolean) as number[];
    return t.length > 0 && Math.max(...t) - Math.min(...t) < config.serviceSpanMinutes * 60;
  }
}

export function findFunder(tx: any, wallet: string): { source: string; lamports: number | null } | null {
  if (!tx) return null;
  const msg = tx.transaction?.message ?? {};
  const ixs: any[] = [...(msg.instructions ?? [])];
  for (const inner of tx.meta?.innerInstructions ?? []) ixs.push(...(inner.instructions ?? []));
  for (const ix of ixs) {
    const p = ix.parsed;
    if (ix.program !== "system" || !p || typeof p !== "object") continue;
    const info = p.info ?? {};
    if ((p.type === "transfer" || p.type === "transferWithSeed") && info.destination === wallet)
      return { source: info.source, lamports: Number(info.lamports ?? 0) };
    if ((p.type === "createAccount" || p.type === "createAccountWithSeed") && info.newAccount === wallet)
      return { source: info.source, lamports: Number(info.lamports ?? 0) };
  }
  const k = msg.accountKeys?.[0];
  const payer = typeof k === "string" ? k : k?.pubkey;
  return payer && payer !== wallet ? { source: payer, lamports: null } : null;
}
