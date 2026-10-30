/** Weighted score (spec section 4): 30/25/15/10/10/10. Only meaningful when no hard gate fired. */
import type { Evidence } from "../rules/registry";
import type { Factor, RuleResult } from "../types";
import type { Gates } from "./gates";

export const WEIGHTS: Record<Factor, number> = { contract: 30, liquidity: 25, creator: 15, holders: 10, buyers: 10, execution: 10 };
export const FACTOR_LABEL: Record<Factor, [number, string]> = {
  contract: [1, "Contract and sellability safety"], liquidity: [2, "Real, executable liquidity"],
  creator: [3, "Creator and deployer wallet risk"], holders: [4, "Early-holder distribution"],
  buyers: [5, "Independent buyer quality"], execution: [6, "Risk-adjusted entry conditions"],
};
const DEFAULT_PENALTY = { CRITICAL: 40, HIGH: 25, MEDIUM: 15, LOW: 8 } as const;
const clamp = (x: number) => Math.round(Math.max(0, Math.min(100, x)));

export function factorScores(ev: Evidence, gates: Gates) {
  const q = ev.quote, r = ev.risk;
  const s: Record<Factor, number> = {
    contract: 100,
    liquidity: q ? 100 - 4 * Math.max(0, q.buyImpactPct - 1.5) - 3 * Math.max(0, q.roundTripPct - 5) - 0.8 * Math.max(0, q.dumpStressLossPct - 25) : 50,
    creator: 100,
    holders: 100 - 2 * Math.max(0, r.top10Pct - 15) - 4 * Math.max(0, r.top1Pct - 4) - Math.max(0, r.extensionsPct - 10),
    buyers: Math.min(100, 40 + 12 * r.independentBuyers.length) - 50 * r.freshFrac - 40 * r.dustFrac,
    execution: 100 - 0.5 * Math.max(0, (r.swingPct ?? 0) - 30) - 2 * Math.max(0, (q?.feeNow ?? 0) - 3),
  };
  for (const w of gates.warns) s[w.rule.factor] -= Number((w.evidence as any).penalty ?? w.rule.penalty ?? DEFAULT_PENALTY[w.rule.severity]);
  for (const k of Object.keys(s) as Factor[]) s[k] = clamp(s[k]);
  for (const x of gates.rejects) s[x.rule.factor] = 0;
  return s;
}
export const weightedScore = (s: Record<Factor, number>) =>
  Math.round((Object.keys(WEIGHTS) as Factor[]).reduce((a, k) => a + s[k] * WEIGHTS[k], 0) / 100);
export const factorBlocked = (f: Factor, results: RuleResult[]) =>
  results.some((r) => r.rule.factor === f && (r.status === "TRIGGERED" || (r.status === "MISSING" && r.rule.on_missing_evidence === "WAIT")));
