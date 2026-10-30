/** Creator, funding-wallet, early-buyer, cluster and distribution evaluators. */
import { config } from "../config";
import { TOTAL_SUPPLY } from "../decoders/bonding-curve";
import { type Evaluator, type Evidence, missing, pass, trig } from "./helpers";

const short = (a?: string | null) => (a ? `${a.slice(0, 4)}…${a.slice(-4)}` : "—");
const needTrace = (ev: Evidence) => (ev.deployerTrace ? null : missing(["deployer_wallet_history"], `deployer not traced (${ev.deployerTraceError ?? "pending"})`));
const pctOf = (ev: Evidence, ws: string[]) => Math.round(ws.reduce((a, w) => a + (ev.risk.holders.get(w) ?? 0), 0) / TOTAL_SUPPLY * 10000) / 100;
const above = (v: number, max: number, text: string, evidence: Record<string, unknown>, ok: string) => (v > max ? trig(text, evidence) : pass(ok, evidence));

export const walletEvaluators: Record<string, Evaluator> = {
  deployer_linked_to_operator: { requires: ["previous_launches", "funder_launches"], fn: (ev, p) => {
    const prior = ev.history.prior.length, pf = ev.history.pumpfunPast?.count ?? 0;
    const funder = ev.graph.deployerFunder, fl = ev.history.funderLaunches;
    const e = { previous_launches: Math.max(prior, pf), funder_launches: fl + 1, funder };
    if (prior > p.max_past_launches) return trig(`deployer launched ${prior} other coin(s) in ${p.lookback_hours}h`, e);
    if (pf > p.max_past_launches) return trig(`deployer has ${pf} past pump.fun coins (${ev.history.pumpfunPast!.graduated} graduated)`, e);
    if (funder && fl + 1 >= p.funder_max_deployers) return trig(`funding wallet ${short(funder)} is behind ${fl + 1} launch deployers`, e);
    if (!ev.deployerTrace) return missing(["deployer_funding_source"]);
    return pass("first launch from this deployer and its funder", e);
  } },
  creator_rug_history: { requires: ["rug_evidence"], fn: (ev) =>
    ev.history.rugger ? trig(`deployer is a known rugger — ${ev.history.rugger}`, { rug_evidence: ev.history.rugger }) : pass("no rug history learned for this deployer") },
  funding_wallet_flagged: { requires: ["funder", "flag"], fn: (ev) => {
    const m = needTrace(ev); if (m) return m;
    return ev.history.funderFlag ? trig(`funding wallet ${short(ev.graph.deployerFunder)} ${ev.history.funderFlag}`, { funder: ev.graph.deployerFunder, flag: ev.history.funderFlag })
                                 : pass(ev.deployerTrace!.funderIsService ? "funded from an exchange / service wallet" : "funding wallet not flagged");
  } },
  creator_funded_buyers: { requires: ["wallets", "share_pct"], fn: (ev, p) => {
    const ws = ev.graph.linked.filter((w) => ev.risk.buyers.includes(w));
    const share = pctOf(ev, ws);
    return above(share, p.max_pct, `${ws.length} wallet(s) funded by the deployer or its funder bought ${share}%`, { wallets: ws, share_pct: share },
                 ws.length ? `deployer-funded buyers hold ${share}%` : "no deployer-funded buyers found");
  } },
  creator_selling_early: { requires: ["deployer_sold"], fn: (ev) =>
    ev.risk.sellers.has(ev.launch.deployer) ? trig("deployer sold in the first seconds", { deployer_sold: true }) : pass("deployer has not sold") },
  creator_share_warning: { requires: ["creator_share_pct"], fn: (ev, p) =>
    ev.risk.deployerPct > p.warn_pct ? trig(`deployer holds ${ev.risk.deployerPct}% of supply`, { creator_share_pct: ev.risk.deployerPct, penalty: (ev.risk.deployerPct - p.warn_pct) * p.penalty_per_pct })
                                     : pass(`deployer holds ${ev.risk.deployerPct}%`) },
  creator_share_above_limit: { requires: ["creator_share_pct"], fn: (ev, p) =>
    above(ev.risk.deployerPct, p.max_pct, `deployer holds ${ev.risk.deployerPct}% (max ${p.max_pct}%)`, { creator_share_pct: ev.risk.deployerPct }, `deployer holds ${ev.risk.deployerPct}%`) },
  funding_source_unknown: { requires: ["funder"], fn: (ev) => {
    const m = needTrace(ev); if (m) return m;
    const t = ev.deployerTrace!;
    return !t.funder && !t.old ? trig("could not identify who funded the deployer", { funder: null, penalty: 20 })
                               : pass(t.old ? "long wallet history" : `funded by ${t.funderIsService ? "an exchange / service" : short(t.funder)}`);
  } },
  creator_history_too_short: { requires: ["tx_count", "age_hours"], fn: (ev, p) => {
    const m = needTrace(ev); if (m) return m;
    const t = ev.deployerTrace!;
    const short_ = t.txCount < p.min_txs || (!t.old && t.ageHours < p.min_age_hours);
    return short_ ? trig(`deployer wallet is new (${t.txCount} txs, ${t.ageHours.toFixed(1)}h old)`, { tx_count: t.txCount, age_hours: t.ageHours })
                  : pass(`deployer wallet ${t.old ? "1000+ txs" : `${t.txCount} txs`}, ${t.ageHours.toFixed(0)}h old`, { tx_count: t.txCount, age_hours: t.ageHours });
  } },
  wallet_graph_ambiguous: { requires: ["traced", "needed"], fn: (ev) =>
    ev.buyerTracesDone < ev.buyerTracesNeeded ? trig(`${ev.buyerTracesDone}/${ev.buyerTracesNeeded} early buyers traced so far`, { traced: ev.buyerTracesDone, needed: ev.buyerTracesNeeded })
                                              : pass(`${ev.buyerTracesDone} early buyers traced`) },
  funding_graph_unresolved: { requires: ["deployer_trace"], fn: (ev) => needTrace(ev) ?? pass("deployer funding resolved") },
  linked_buyers_share: { requires: ["wallets", "share_pct"], fn: (ev, p) =>
    above(ev.risk.linkedPct, p.max_pct, `${ev.graph.linked.length} creator-linked wallet(s) hold ${ev.risk.linkedPct}%`,
          { wallets: ev.graph.linked, share_pct: ev.risk.linkedPct }, `creator-linked wallets hold ${ev.risk.linkedPct}%`) },
  linked_wallets_selling: { requires: ["wallets"], fn: (ev) =>
    ev.risk.linkedSelling.length ? trig(`${ev.risk.linkedSelling.length} linked / clustered wallet(s) already selling`, { wallets: ev.risk.linkedSelling })
                                 : pass("no linked wallet selling") },
  early_pump_and_dump: { requires: ["wallets"], fn: (ev) => {
    const ws = [...new Set([...ev.risk.linkedSelling, ...ev.risk.bundleSelling])];
    return ws.length ? trig(`${ws.length} early insider / launch-block wallet(s) already dumping`, { wallets: ws }) : pass("early wallets holding");
  } },
  shared_funder_cluster_share: { requires: ["groups", "share_pct"], fn: (ev, p) =>
    above(ev.risk.clusterPct, p.max_pct, `${ev.graph.clustered.length} buyers share funding wallets and hold ${ev.risk.clusterPct}%`,
          { groups: ev.graph.sharedFunderGroups, share_pct: ev.risk.clusterPct }, `shared-funder clusters hold ${ev.risk.clusterPct}%`) },
  linked_wash: { requires: ["wallets"], fn: (ev) => {
    const set = new Set([...ev.graph.linked, ...ev.graph.clustered, ev.launch.deployer]);
    const ws = ev.risk.washWallets.filter((w) => set.has(w));
    return ws.length ? trig(`${ws.length} linked wallet(s) buying and selling back-to-back`, { wallets: ws }) : pass("no linked wash trading");
  } },
  launch_block_snipers_share: { requires: ["wallets", "share_pct"], fn: (ev, p) =>
    above(ev.risk.bundlePct, p.max_pct, `${ev.risk.bundleWallets.length} launch-block sniper(s) hold ${ev.risk.bundlePct}%`,
          { wallets: ev.risk.bundleWallets, share_pct: ev.risk.bundlePct }, `launch-block snipers hold ${ev.risk.bundlePct}%`) },
  wash_trading: { requires: ["wallets", "volume_share"], fn: (ev, p) =>
    ev.risk.washWallets.length >= p.min_wallets && ev.risk.washShare > p.min_share
      ? trig(`${ev.risk.washWallets.length} wallets wash-trading ${(ev.risk.washShare * 100).toFixed(0)}% of volume`, { wallets: ev.risk.washWallets, volume_share: ev.risk.washShare })
      : pass(`wash volume ${(ev.risk.washShare * 100).toFixed(0)}%`) },
  cluster_rug_history: { requires: ["wallets"], fn: (ev) =>
    ev.graph.flaggedBuyers.length ? trig(`${ev.graph.flaggedBuyers.length} early buyer(s) linked to known ruggers`, { wallets: ev.graph.flaggedBuyers })
                                  : pass("no early buyer linked to known ruggers") },
  holder_distribution_unavailable: { requires: ["holders"], fn: (ev) =>
    ev.risk.holders.size ? pass(`${ev.risk.holders.size} holders tracked`, { holders: ev.risk.holders.size })
                         : (ev.stage > 1 ? missing(["holder_distribution"]) : pass("no holders besides the curve yet")) },
  buyer_independence_uncertain: { requires: ["fresh_frac"], fn: (ev, p) =>
    ev.risk.tracedBuyers >= 2 && ev.risk.freshFrac >= p.fresh_frac
      ? trig(`${Math.round(ev.risk.freshFrac * 100)}% of traced buyers are brand-new wallets`, { fresh_frac: ev.risk.freshFrac, penalty: p.penalty })
      : pass(`${Math.round(ev.risk.freshFrac * 100)}% fresh buyer wallets`) },
  single_holder_above_limit: { requires: ["wallet", "share_pct"], fn: (ev, p) =>
    above(ev.risk.top1Pct, p.max_pct, `one wallet (${short(ev.risk.top1Wallet)}) owns ${ev.risk.top1Pct}%`, { wallet: ev.risk.top1Wallet, share_pct: ev.risk.top1Pct },
          `largest non-deployer wallet ${ev.risk.top1Pct}%`) },
  top10_above_limit: { requires: ["share_pct"], fn: (ev, p) =>
    above(ev.risk.top10Pct, p.max_pct, `top-10 holders own ${ev.risk.top10Pct}% (max ${p.max_pct}%)`, { share_pct: ev.risk.top10Pct }, `top-10 holders ${ev.risk.top10Pct}%`) },
  insider_share_above_limit: { requires: ["share_pct"], fn: (ev, p) =>
    above(ev.risk.insiderPct, p.max_pct, `deployer + linked wallets hold ${ev.risk.insiderPct}%`, { share_pct: ev.risk.insiderPct }, `insiders hold ${ev.risk.insiderPct}%`) },
  combined_insider_cluster_share: { requires: ["share_pct"], fn: (ev, p) =>
    above(ev.risk.combinedPct, p.max_pct, `insiders, clusters and snipers together hold ${ev.risk.combinedPct}%`, { share_pct: ev.risk.combinedPct }, `insiders + clusters + snipers ${ev.risk.combinedPct}%`) },
  holder_aggregation_by_wallet: { requires: [], fn: () => pass("balances aggregated per owner wallet, curve excluded") },
  token_transfer_distribution: { requires: ["token_transfers"], fn: () => missing(["token_transfers"], "wallet-to-wallet token transfers are not in the trade stream") },
  creator_cluster_selling: { requires: ["wallets"], fn: (ev) => {
    const ws = [...(ev.risk.sellers.has(ev.launch.deployer) ? [ev.launch.deployer] : []), ...ev.risk.linkedSelling];
    return ws.length ? trig("deployer cluster is selling into early demand", { wallets: ws }) : pass("deployer cluster holding");
  } },
  known_manipulation_link: { requires: ["links"], fn: (ev) => {
    const links = [ev.history.rugger && `deployer: ${ev.history.rugger}`, ev.history.funderFlag && `funder ${ev.history.funderFlag}`,
                   ...ev.graph.flaggedBuyers.map((b) => `buyer ${short(b.wallet)}: ${b.via}`)].filter(Boolean);
    return links.length ? trig(`linked to known bad actors (${links.length})`, { links }) : pass("no link to known bad actors");
  } },
  too_few_independent_buyers: { requires: ["independent_buyers"], fn: (ev, p) =>
    ev.risk.independentBuyers.length < p.min_buyers ? trig(`${ev.risk.independentBuyers.length} independent buyer(s) so far (need ${p.min_buyers})`, { independent_buyers: ev.risk.independentBuyers.length })
                                                    : pass(`${ev.risk.independentBuyers.length} independent buyers`) },
  bot_buyers_majority: { requires: ["fresh_frac", "dust_frac"], fn: (ev, p) => {
    const bots = (ev.risk.tracedBuyers >= p.min_traced && ev.risk.freshFrac >= p.fresh_frac) || (ev.risk.buyers.length >= 3 && ev.risk.dustFrac >= p.dust_frac);
    return bots ? trig(`first buyers look automated (${Math.round(ev.risk.freshFrac * 100)}% fresh, ${Math.round(ev.risk.dustFrac * 100)}% dust)`, { fresh_frac: ev.risk.freshFrac, dust_frac: ev.risk.dustFrac })
                : pass("first buyers look organic");
  } },
  insufficient_evidence: { requires: ["core_evidence"], fn: (ev, p) => {
    const core = { contract: !!ev.contract, deployer: !!ev.deployerTrace, reserves: !!ev.quote,
                   ...(config.checkPumpfunApi ? { pumpfun: ev.history.pumpfunPast !== null } : {}) };
    const have = Object.values(core).filter(Boolean).length / Object.keys(core).length;
    return have < p.min_core ? trig(`only ${Math.round(have * 100)}% of core evidence available`, { core_evidence: core }) : pass(`${Math.round(have * 100)}% of core evidence available`);
  } },
};
