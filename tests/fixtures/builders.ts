/** Test builders: real-format pump.fun event logs, account bytes, and a scriptable fake Solana RPC. */
import bs58 from "bs58";
import { Keypair } from "@solana/web3.js";
import { CREATE_DISC, PUMP_PROGRAM, TRADE_DISC } from "../../src/decoders/pump-launch";
import { TOKEN_2022, TOKEN_PROGRAM } from "../../src/data/accounts";
import { bondingCurvePda } from "../../src/decoders/bonding-curve";
import type { Transport } from "../../src/data/rpc";

export const addr = () => Keypair.generate().publicKey.toBase58();
const pk = (a: string) => Buffer.from(bs58.decode(a));
const u64 = (n: bigint | number) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(Math.round(Number(n)))); return b; };
const str = (s: string) => { const b = Buffer.from(s, "utf8"); const l = Buffer.alloc(4); l.writeUInt32LE(b.length); return Buffer.concat([l, b]); };

export function createEventData(o: { name: string; symbol: string; uri?: string; mint: string; curve: string; user: string; creator?: string }) {
  return Buffer.concat([CREATE_DISC, str(o.name), str(o.symbol), str(o.uri ?? ""), pk(o.mint), pk(o.curve), pk(o.user),
    pk(o.creator ?? o.user), u64(0), u64(1_073_000_000e6), u64(30e9), u64(793_100_000e6), u64(1e15)]);
}
export function tradeEventData(o: { mint: string; sol: number; tokens: number; isBuy: boolean; user: string; vsol: number; vtok: number }) {
  return Buffer.concat([TRADE_DISC, pk(o.mint), u64(o.sol * 1e9), u64(o.tokens * 1e6), Buffer.from([o.isBuy ? 1 : 0]), pk(o.user),
    u64(0), u64(o.vsol * 1e9), u64(o.vtok * 1e6), u64(0), u64(0)]);
}
export const programData = (b: Buffer) => `Program data: ${b.toString("base64")}`;

export function mintAccount(o: { mintAuthority?: boolean; freezeAuthority?: boolean; supply?: bigint; decimals?: number;
                                 ext?: { type: number; data: Buffer }[] } = {}) {
  const d = Buffer.alloc(82);
  d.writeUInt32LE(o.mintAuthority ? 1 : 0, 0); if (o.mintAuthority) d.fill(7, 4, 36);
  d.writeBigUInt64LE(o.supply ?? 10n ** 15n, 36); d[44] = o.decimals ?? 6; d[45] = 1;
  d.writeUInt32LE(o.freezeAuthority ? 1 : 0, 46); if (o.freezeAuthority) d.fill(9, 50, 82);
  if (!o.ext) return { owner: TOKEN_PROGRAM, data: d };
  const parts: Buffer[] = [d, Buffer.alloc(165 - 82), Buffer.from([1])];
  for (const e of o.ext) { const h = Buffer.alloc(4); h.writeUInt16LE(e.type, 0); h.writeUInt16LE(e.data.length, 2); parts.push(h, e.data); }
  return { owner: TOKEN_2022, data: Buffer.concat(parts) };
}
export function curveAccount(vsol: number, vtok: number, complete = false) {
  return Buffer.concat([Buffer.alloc(8), u64(vtok * 1e6), u64(vsol * 1e9), u64((vtok - 279_900_000) * 1e6), u64((vsol - 30) * 1e9), u64(1e15), Buffer.from([complete ? 1 : 0])]);
}

/** Constant-product helper mirroring the curve so fixtures produce consistent reserves. */
export class Curve {
  vs = 30; vt = 1_073_000_000;
  buy(sol: number) { const x = sol * 0.9875; const out = this.vt - (this.vs * this.vt) / (this.vs + x); this.vs += x; this.vt -= out; return out; }
  sell(tok: number) { const g = this.vs - (this.vs * this.vt) / (this.vt + tok); this.vs -= g; this.vt += tok; return g; }
}

export interface WalletProfile { n: number; ageH: number; funder?: string | null; service?: boolean }

/** Fake JSON-RPC: per-mint accounts, per-wallet signature histories and funding transactions, optional latency. */
export class FakeChain {
  mints = new Map<string, { owner: string; data: Buffer }>();
  curves = new Map<string, Curve>();
  profiles = new Map<string, WalletProfile>();
  delayMs = 0;
  calls: string[] = [];
  default: WalletProfile = { n: 150, ageH: 900 };

  wallet(w: string, p: WalletProfile) { this.profiles.set(w, p); return w; }
  profile(w: string): WalletProfile {
    if (!this.profiles.has(w)) this.profiles.set(w, { ...this.default, funder: addrFor(w) });
    return this.profiles.get(w)!;
  }

  transport: Transport = async (method, params) => {
    this.calls.push(method);
    if (this.delayMs) await new Promise((r) => setTimeout(r, this.delayMs));
    const now = Math.floor(Date.now() / 1000);
    switch (method) {
      case "getMultipleAccounts": {
        const [mint, curveKey] = params[0] as string[];
        const m = this.mints.get(mint), c = this.curves.get(mint);
        if (!m || !c || curveKey !== bondingCurvePda(mint)) return { value: [null, null] };
        return { value: [{ owner: m.owner, data: [m.data.toString("base64"), "base64"] },
                         { owner: PUMP_PROGRAM, data: [curveAccount(c.vs, c.vt).toString("base64"), "base64"] }] };
      }
      case "getSignaturesForAddress": {
        const w = params[0] as string, p = this.profile(w);
        const times = p.service ? Array.from({ length: p.n }, (_, i) => now - i) : Array.from({ length: p.n }, (_, i) => now - Math.floor(p.ageH * 3600 * i / Math.max(1, p.n - 1)));
        return times.map((t, i) => ({ signature: `${w}:${i}`, blockTime: t, slot: 1000 + i }));
      }
      case "getTransaction": {
        const w = String(params[0]).split(":")[0], f = this.profile(w).funder;
        return { slot: 999, transaction: { message: { accountKeys: [{ pubkey: f ?? w }],
          instructions: f ? [{ program: "system", parsed: { type: "transfer", info: { source: f, destination: w, lamports: 1e9 } } }] : [] } }, meta: {} };
      }
      case "getSignatureStatuses": return { value: [{ slot: 4242, confirmationStatus: "confirmed", err: null }] };
      case "getSlot": return 5000;
      case "getRecentPrioritizationFees": return [{ prioritizationFee: 1000 }];
      default: return null;
    }
  };
}

// deterministic, distinct funder per wallet
const funders = new Map<string, string>();
const addrFor = (w: string) => { if (!funders.has(w)) funders.set(w, addr()); return funders.get(w)!; };
