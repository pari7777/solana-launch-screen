/**
 * Wallet funding graph for one launch: deployer → its funder, early buyers → their funders.
 * Exchange / bot hot wallets are excluded from linking (everyone withdraws from Binance).
 */
import type { WalletTrace } from "../types";

export interface FundingGraph {
  deployerFunder: string | null;            // null when unknown or a service
  linked: string[];                         // buyers funded by the deployer or the deployer's funder (or who funded the deployer)
  sharedFunderGroups: Record<string, string[]>;   // non-service funder → ≥2 early buyers it funded
  clustered: string[];
  flaggedBuyers: { wallet: string; via: string }[];
}

export function buildFundingGraph(deployer: string, deployerTrace: WalletTrace | null,
                                  buyerTraces: Map<string, WalletTrace>,
                                  isFlagged: (w: string | null | undefined) => string | null): FundingGraph {
  const dFunder = deployerTrace && deployerTrace.funder && !deployerTrace.funderIsService ? deployerTrace.funder : null;
  const linked = new Set<string>();
  const groups: Record<string, string[]> = {};
  const flagged: { wallet: string; via: string }[] = [];
  for (const [w, t] of buyerTraces) {
    if (t.funder === deployer || (dFunder && t.funder === dFunder) || (dFunder && w === dFunder)) { linked.add(w); continue; }
    if (t.funder && !t.funderIsService) (groups[t.funder] ??= []).push(w);
    const f = isFlagged(w) ?? (t.funder && !t.funderIsService ? isFlagged(t.funder) : null);
    if (f) flagged.push({ wallet: w, via: f });
  }
  const shared = Object.fromEntries(Object.entries(groups).filter(([, ws]) => ws.length >= 2));
  return { deployerFunder: dFunder, linked: [...linked], sharedFunderGroups: shared,
           clustered: Object.values(shared).flat(), flaggedBuyers: flagged };
}
