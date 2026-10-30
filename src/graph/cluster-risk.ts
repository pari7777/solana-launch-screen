/** Holder distribution and trading-behaviour metrics from the first seconds of trades. */
import { TOTAL_SUPPLY } from "../decoders/bonding-curve";
import type { TradeEvent, WalletTrace } from "../types";
import type { FundingGraph } from "./funding-graph";

export interface ClusterRisk {
  holders: Map<string, number>;
  buyers: string[]; sellers: Set<string>;
  deployerPct: number; top10Pct: number; top1Pct: number; top1Wallet: string | null; topHolderTokens: number;
  linkedPct: number; clusterPct: number; insiderPct: number; combinedPct: number;
  bundleWallets: string[]; bundlePct: number;
  independentBuyers: string[]; dustFrac: number; freshFrac: number; tracedBuyers: number;
  washWallets: string[]; washShare: number;
  swingPct: number | null; dropFromLaunchPct: number | null;
  linkedSelling: string[]; bundleSelling: string[];
  clusterTokens: number;
  solIn: Map<string, number>;
}

const pct = (t: number) => Math.round((t / TOTAL_SUPPLY) * 100 * 100) / 100;

export function clusterRisk(deployer: string, launchAt: number, price0: number | null, trades: TradeEvent[],
                            graph: FundingGraph, traces: Map<string, WalletTrace>,
                            opts: { bundleMs: number; dustSol: number }): ClusterRisk {
  const holders = new Map<string, number>(), firstBuy = new Map<string, number>(), buySol = new Map<string, number>();
  const sellers = new Set<string>(), counts = new Map<string, { buy: number; sell: number; vol: number }>();
  for (const t of trades) {
    const c = counts.get(t.wallet) ?? { buy: 0, sell: 0, vol: 0 }; c[t.side]++; c.vol += t.sol; counts.set(t.wallet, c);
    if (t.side === "buy") {
      holders.set(t.wallet, (holders.get(t.wallet) ?? 0) + t.tokens);
      if (!firstBuy.has(t.wallet)) firstBuy.set(t.wallet, t.receivedAt - launchAt);
      buySol.set(t.wallet, (buySol.get(t.wallet) ?? 0) + t.sol);
    } else {
      holders.set(t.wallet, Math.max(0, (holders.get(t.wallet) ?? 0) - t.tokens)); sellers.add(t.wallet);
    }
  }
  const ranked = [...holders.entries()].sort((a, b) => b[1] - a[1]);
  const others = ranked.filter(([w]) => w !== deployer);
  const sum = (ws: Iterable<string>) => { let s = 0; for (const w of ws) s += holders.get(w) ?? 0; return s; };
  const linked = new Set(graph.linked), clustered = new Set(graph.clustered);
  const buyers = [...firstBuy.keys()].filter((w) => w !== deployer);
  const bundle = buyers.filter((w) => (firstBuy.get(w) ?? Infinity) <= opts.bundleMs);
  const dust = new Set(buyers.filter((w) => (buySol.get(w) ?? 0) < opts.dustSol));
  const traced = buyers.filter((w) => traces.has(w)).map((w) => traces.get(w)!);
  const fresh = traced.filter((t) => !t.old && (t.ageHours < 1 || t.txCount < 5)).length;
  const wash = [...counts.entries()].filter(([w, c]) => w !== deployer && c.buy && c.sell && c.buy + c.sell >= 3).map(([w]) => w);
  const totVol = [...counts.values()].reduce((a, c) => a + c.vol, 0) || 1;
  const prices = trades.filter((t) => !t.fromCreate && t.vsol > 0 && t.vtok > 0).map((t) => t.vsol / t.vtok);
  const all = price0 ? [price0, ...prices] : prices;
  return {
    holders, buyers, sellers, solIn: buySol,
    deployerPct: pct(holders.get(deployer) ?? 0),
    top10Pct: pct(ranked.slice(0, 10).reduce((a, [, v]) => a + v, 0)),
    top1Pct: others.length ? pct(others[0][1]) : 0, top1Wallet: others[0]?.[0] ?? null,
    topHolderTokens: ranked[0]?.[1] ?? 0,
    linkedPct: pct(sum(linked)), clusterPct: pct(sum(clustered)),
    insiderPct: pct((holders.get(deployer) ?? 0) + sum(linked)),
    combinedPct: pct((holders.get(deployer) ?? 0) + sum(new Set([...linked, ...clustered, ...bundle]))),
    clusterTokens: sum(new Set([deployer, ...linked, ...clustered])),
    bundleWallets: bundle, bundlePct: pct(sum(bundle)),
    independentBuyers: buyers.filter((w) => !linked.has(w) && !clustered.has(w) && !dust.has(w)),
    dustFrac: buyers.length ? dust.size / buyers.length : 0,
    freshFrac: traced.length ? fresh / traced.length : 0, tracedBuyers: traced.length,
    washWallets: wash, washShare: wash.reduce((a, w) => a + counts.get(w)!.vol, 0) / totVol,
    swingPct: all.length >= 2 ? Math.round((Math.max(...all) / Math.min(...all) - 1) * 1000) / 10 : null,
    dropFromLaunchPct: price0 && prices.length ? Math.round((1 - prices[prices.length - 1] / price0) * 1000) / 10 : null,
    linkedSelling: [...sellers].filter((w) => linked.has(w) || clustered.has(w)),
    bundleSelling: [...sellers].filter((w) => bundle.includes(w)),
  };
}
