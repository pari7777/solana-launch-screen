/** Wallet graph and concentration metrics for one launch (same ideas as the Solana bot). */
import type { Trade, WalletTrace } from "../types";
import type { TokenState } from "./token-state";

export const TOTAL_SUPPLY = 100_000_000_000;            // Clanker v4 default; each launch passes its real supply

export interface FundingGraph {
  creatorFunder: string | null; linked: string[]; sharedFunderGroups: Record<string, string[]>; clustered: string[];
  flaggedBuyers: { wallet: string; via: string }[];
}

export function buildFundingGraph(creator: string, creatorTrace: WalletTrace | null, traces: Map<string, WalletTrace>,
                                  isFlagged: (w: string | null | undefined) => string | null): FundingGraph {
  const cf = creatorTrace?.funder && !creatorTrace.funderIsService ? creatorTrace.funder : null;
  const linked = new Set<string>(), groups: Record<string, string[]> = {}, flagged: { wallet: string; via: string }[] = [];
  for (const [w, t] of traces) {
    if (t.funder === creator || (cf && t.funder === cf) || (cf && w === cf)) { linked.add(w); continue; }
    if (t.funder && !t.funderIsService) (groups[t.funder] ??= []).push(w);
    const f = isFlagged(w) ?? (t.funder && !t.funderIsService ? isFlagged(t.funder) : null);
    if (f) flagged.push({ wallet: w, via: f });
  }
  const shared = Object.fromEntries(Object.entries(groups).filter(([, ws]) => ws.length >= 2));
  return { creatorFunder: cf, linked: [...linked], sharedFunderGroups: shared, clustered: Object.values(shared).flat(), flaggedBuyers: flagged };
}

export interface Risk {
  holders: Map<string, number>; buyers: string[]; sellers: Set<string>; ethIn: Map<string, number>;
  creatorPct: number; top10Pct: number; top1Pct: number; top1Wallet: string | null; topHolderTokens: number;
  linkedPct: number; clusterPct: number; insiderPct: number; combinedPct: number; clusterTokens: number;
  firstBlockWallets: string[]; firstBlockPct: number;
  independentBuyers: string[]; dustFrac: number; freshFrac: number; tracedBuyers: number;
  washWallets: string[]; washShare: number; swingPct: number | null; dropFromFirstPct: number | null;
  linkedSelling: string[]; firstBlockSelling: string[]; extensionsPct: number; supply: number;
}

export function computeRisk(creator: string, launchBlock: number, st: TokenState, graph: FundingGraph,
                            traces: Map<string, WalletTrace>, extensionsSupplyTokens: number, opts: { dustEth: number; supply?: number }): Risk {
  const supply = opts.supply && opts.supply > 0 ? opts.supply : TOTAL_SUPPLY;
  const pct = (t: number) => Math.round((t / supply) * 10000) / 100;
  const trades: Trade[] = st.trades;
  const holders = new Map(st.holders());
  const firstBuyBlock = new Map<string, number>(), ethIn = new Map<string, number>(), sellers = new Set<string>();
  const counts = new Map<string, { buy: number; sell: number; vol: number }>();
  for (const t of trades) {
    const c = counts.get(t.wallet) ?? { buy: 0, sell: 0, vol: 0 }; c[t.side]++; c.vol += t.eth; counts.set(t.wallet, c);
    if (t.side === "buy") { if (!firstBuyBlock.has(t.wallet)) firstBuyBlock.set(t.wallet, t.block); ethIn.set(t.wallet, (ethIn.get(t.wallet) ?? 0) + t.eth); }
    else sellers.add(t.wallet);
  }
  const ranked = [...holders.entries()];
  const others = ranked.filter(([w]) => w !== creator);
  const sum = (ws: Iterable<string>) => { let s = 0; for (const w of ws) s += holders.get(w) ?? 0; return s; };
  const linked = new Set(graph.linked), clustered = new Set(graph.clustered);
  const buyers = [...firstBuyBlock.keys()].filter((w) => w !== creator);
  // launch-block snipers: bought in the creation block or the next one
  const firstBlock = buyers.filter((w) => (firstBuyBlock.get(w) ?? Infinity) <= launchBlock + 1);
  const dust = new Set(buyers.filter((w) => (ethIn.get(w) ?? 0) < opts.dustEth));
  const traced = buyers.filter((w) => traces.has(w)).map((w) => traces.get(w)!);
  const fresh = traced.filter((t) => t.txCount < 5 || (t.ageHours !== null && t.ageHours < 1)).length;
  const wash = [...counts.entries()].filter(([w, c]) => w !== creator && c.buy && c.sell && c.buy + c.sell >= 3).map(([w]) => w);
  const totVol = [...counts.values()].reduce((a, c) => a + c.vol, 0) || 1;
  const prices = st.prices.map((x) => x.p);
  return {
    holders, buyers, sellers, ethIn,
    creatorPct: pct(holders.get(creator) ?? 0),
    top10Pct: pct(ranked.slice(0, 10).reduce((a, [, v]) => a + v, 0)),
    top1Pct: others.length ? pct(others[0][1]) : 0, top1Wallet: others[0]?.[0] ?? null,
    topHolderTokens: ranked[0]?.[1] ?? 0,
    linkedPct: pct(sum(linked)), clusterPct: pct(sum(clustered)),
    insiderPct: pct((holders.get(creator) ?? 0) + sum(linked)),
    combinedPct: pct((holders.get(creator) ?? 0) + sum(new Set([...linked, ...clustered, ...firstBlock]))),
    clusterTokens: sum(new Set([creator, ...linked, ...clustered])),
    firstBlockWallets: firstBlock, firstBlockPct: pct(sum(firstBlock)),
    independentBuyers: buyers.filter((w) => !linked.has(w) && !clustered.has(w) && !dust.has(w)),
    dustFrac: buyers.length ? dust.size / buyers.length : 0,
    freshFrac: traced.length ? fresh / traced.length : 0, tracedBuyers: traced.length,
    washWallets: wash, washShare: wash.reduce((a, w) => a + counts.get(w)!.vol, 0) / totVol,
    swingPct: prices.length >= 2 ? Math.round((Math.max(...prices) / Math.min(...prices) - 1) * 1000) / 10 : null,
    dropFromFirstPct: prices.length >= 2 ? Math.round((1 - prices[prices.length - 1] / prices[0]) * 1000) / 10 : null,
    linkedSelling: [...sellers].filter((w) => linked.has(w) || clustered.has(w)),
    firstBlockSelling: [...sellers].filter((w) => firstBlock.includes(w)),
    extensionsPct: pct(extensionsSupplyTokens), supply,
  };
}
