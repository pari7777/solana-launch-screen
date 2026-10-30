/** pump.fun bonding-curve account decoding and constant-product curve math. */
import { PublicKey } from "@solana/web3.js";
import type { CurveInfo, Quote } from "../types";
import { PUMP_PROGRAM } from "./pump-launch";

export const TOTAL_SUPPLY = 1_000_000_000;
export const DECIMALS = 6;
export const INITIAL_VSOL = 30;
export const INITIAL_VTOK = 1_073_000_000;

export function bondingCurvePda(mint: string) {
  return PublicKey.findProgramAddressSync([Buffer.from("bonding-curve"), new PublicKey(mint).toBuffer()],
    new PublicKey(PUMP_PROGRAM))[0].toBase58();
}

export function decodeCurve(data: Buffer, owner: string): CurveInfo {
  if (data.length < 49) throw new Error("curve account too short");
  const u = (o: number) => Number(data.readBigUInt64LE(o));
  return { owner, vtok: u(8) / 10 ** DECIMALS, vsol: u(16) / 1e9, rtok: u(24) / 10 ** DECIMALS, rsol: u(32) / 1e9,
           supply: u(40) / 10 ** DECIMALS, complete: data[48] !== 0 };
}

// constant product with fee taken from the input (buy) or output (sell)
export function buyOut(vs: number, vt: number, sol: number, feePct: number) {
  const x = sol * (1 - feePct / 100); const out = vt - (vs * vt) / (vs + x);
  return { tokens: out, vs: vs + x, vt: vt - out };
}
export function sellOut(vs: number, vt: number, tokens: number, feePct: number) {
  const gross = vs - (vs * vt) / (vt + tokens);
  return { sol: gross * (1 - feePct / 100), vs: vs - gross, vt: vt + tokens };
}

/**
 * Entry and exit price impact, immediate round-trip cost, and two stress tests:
 * the largest holder sells first, and every linked/clustered wallet sells first (% loss on the buy size).
 */
export function quote(vs: number, vt: number, buySol: number, feePct: number, priorityFee: number,
                      topHolderTokens = 0, clusterTokens = 0): Quote {
  const spot = vs / vt;
  const pure = buyOut(vs, vt, buySol, 0);
  const buyImpactPct = (buySol / pure.tokens / spot - 1) * 100;
  const sellBack = sellOut(pure.vs, pure.vt, pure.tokens, 0);
  const sellImpactPct = (1 - sellBack.sol / (pure.tokens * (pure.vs / pure.vt))) * 100;
  const b = buyOut(vs, vt, buySol, feePct);
  const prio = 2 * priorityFee;
  const rt = sellOut(b.vs, b.vt, b.tokens, feePct);
  const stress = (holderTokens: number) => {
    const s = holderTokens > 0 ? sellOut(b.vs, b.vt, holderTokens, feePct) : { vs: b.vs, vt: b.vt };
    return (1 - (sellOut(s.vs, s.vt, b.tokens, feePct).sol - prio) / buySol) * 100;
  };
  const r2 = (x: number) => Math.round(x * 100) / 100;
  return { spot, tokens: b.tokens, buyImpactPct: r2(buyImpactPct), sellImpactPct: r2(sellImpactPct),
           roundTripPct: r2((1 - (rt.sol - prio) / buySol) * 100), dumpStressLossPct: r2(stress(topHolderTokens)),
           clusterDumpLossPct: r2(stress(clusterTokens)) };
}

/** Net SOL from selling ALL tokens now: price impact, fees and priority fee included. */
export function liquidationValue(vs: number, vt: number, tokens: number, feePct: number, priorityFee: number, haircutPct = 0) {
  if (!(vs > 0 && vt > 0 && tokens > 0)) return 0;
  return Math.max(0, (sellOut(vs, vt, tokens, feePct).sol - priorityFee) * (1 - haircutPct / 100));
}
