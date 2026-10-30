/**
 * Rule evaluators for Clanker v4 launches on Base.
 * What a Clanker launch guarantees by construction (verified in clanker-devco/v4-contracts):
 *   - the token is Clanker's own fixed ERC-20 (100B supply, no tax, no blacklist, no owner mint; only the
 *     Superchain bridge can mint/burn for cross-chain moves; the admin can change image/metadata only)
 *   - liquidity is minted into Clanker's LP locker and cannot be withdrawn
 *   - vault allocations are locked for at least 7 days
 * So the real risks are: who the creator is, how much supply insiders hold, the sniper-fee window, and exit cost.
 */
import { ADDR, lc } from "../config";
import { TOTAL_SUPPLY } from "../graph/risk";
import { type Evaluator, type Evidence, missing, pass, trig } from "./evidence";

const short = (a?: string | null) => (a ? `${a.slice(0, 6)}…${a.slice(-4)}` : "—");
const KNOWN_HOOKS = new Set(ADDR.knownHooks.map(lc));
const KNOWN_LOCKERS = new Set(["0x29d17C1A8D851d7d4cA97FAe97AcAdb398D9cCE0", "0x63D2DfEA64b3433F4071A98665bcD7Ca14d93496"].map(lc));
const fixedToken: Evaluator = { requires: ["factory"], fn: (ev) =>
  pass("token deployed by the official Clanker v4 factory — fixed ERC-20 with no mint, tax, blacklist or pause", { factory: ADDR.clankerFactory }) };
const needQuote = (ev: Evidence) => (ev.quote ? null : missing(["pool_quote"], ev.quoteError ? `no quote: ${ev.quoteError}` : "no quote yet"));
const sniperWindow = (ev: Evidence, p: Record<string, number>) => (ev.quote?.feeNow ?? 0) > (p.sniper_fee_pct ?? 12);
const above = (v: number, max: number, text: string, e: Record<string, unknown>, ok: string) => (v > max ? trig(text, e) : pass(ok, e));
const pctOf = (ev: Evidence, ws: string[]) => Math.round(ws.reduce((a, w) => a + (ev.risk.holders.get(w) ?? 0), 0) / TOTAL_SUPPLY * 10000) / 100;
const unobservable = (label: string, why: string): Evaluator => ({ requires: [label], fn: () => missing([label], why) });

export const EVALUATORS: Record<string, Evaluator> = {
  // ── contract ──
  clanker_fixed_token: fixedToken,
  hook_not_clanker: { requires: ["hook"], fn: (ev) => KNOWN_HOOKS.has(lc(ev.launch.hook))
    ? pass("pool uses an official Clanker fee hook", { hook: ev.launch.hook })
    : trig(`pool uses an unrecognised hook ${short(ev.launch.hook)} — custom code runs on every trade`, { hook: ev.launch.hook }) },
  locker_not_clanker: { requires: ["locker"], fn: (ev) => KNOWN_LOCKERS.has(lc(ev.launch.locker))
    ? pass("liquidity locked in Clanker's LP locker (cannot be withdrawn)", { locker: ev.launch.locker })
    : trig(`liquidity held by an unrecognised locker ${short(ev.launch.locker)}`, { locker: ev.launch.locker }) },
  supply_mismatch: { requires: ["onchain_supply"], fn: (ev) => {
    if (!ev.onchain || ev.onchain.totalSupply === null) return missing(["token_contract"], `token not readable (${ev.onchainError ?? "pending"})`);
    return ev.onchain.totalSupply !== TOTAL_SUPPLY || ev.onchain.decimals !== 18
      ? trig(`on-chain supply ${ev.onchain.totalSupply.toLocaleString()} (decimals ${ev.onchain.decimals}) ≠ Clanker standard 100,000,000,000`, { onchain_supply: ev.onchain.totalSupply })
      : pass("standard 100B supply, 18 decimals", { onchain_supply: ev.onchain.totalSupply });
  } },
  pool_key_unresolved: { requires: ["pool_key"], fn: (ev) => ev.poolKey ? pass("pool key reconciles with the launch's pool id", { pool_key: ev.poolKey })
    : trig("could not reconstruct a pool key matching the launch's pool id", { pool_key: null }) },
  paired_not_weth: { requires: ["paired_token"], fn: (ev) => lc(ev.launch.pairedToken) === lc(ADDR.weth)
    ? pass("paired with WETH", { paired_token: ev.launch.pairedToken })
    : trig(`paired with ${short(ev.launch.pairedToken)}, not WETH — not supported by this bot`, { paired_token: ev.launch.pairedToken }) },
  // a sell that cannot even be quoted
  sell_simulation_failed_due_to_restriction: { requires: ["simulation_result", "transaction_context", "curve_or_pool_state"], fn: (ev) => {
    if (!ev.poolKey) return missing(["pool_key"]);
    const ctx = { transaction_context: { quoter: ADDR.quoter, pool_key: ev.poolKey, hook: ev.launch.hook },
                  curve_or_pool_state: { spot_eth_per_token: ev.quote?.spotEthPerToken ?? null, fee_now_pct: ev.quote?.feeNow ?? null } };
    if (ev.sellReverted && ev.ageSec > 60) return trig("the Uniswap Quoter cannot execute a sell on this pool", { simulation_result: { sell: "reverted" }, ...ctx });
    if (!ev.quote) return missing(["pool_quote"], ev.quoteError ?? "no quote yet");
    return pass("buy and sell both quote through the pool and its hook", { simulation_result: { round_trip_pct: ev.quote.roundTripPct }, ...ctx });
  } },
  impersonation: { requires: ["symbol"], fn: (ev) => {
    const big = new Set(["eth", "weth", "usdc", "usdt", "btc", "cbbtc", "base", "degen", "brett", "toshi", "aero", "virtual", "clanker", "zora", "higher", "doginme", "keycat", "mfer"]);
    const s = ev.launch.symbol.trim().toLowerCase().replace(/^\$/, "");
    return big.has(s) ? trig(`symbol $${ev.launch.symbol} imitates an established Base token`, { symbol: ev.launch.symbol }) : pass("symbol not an established token");
  } },
  impersonation_brand: { requires: ["name"], fn: (ev) => {
    const b = ["coinbase", "base official", "uniswap", "metamask", "farcaster", "official", "jesse pollak", "elon"].find((x) => ev.launch.name.toLowerCase().includes(x));
    return b ? trig(`name "${ev.launch.name}" claims a brand/official identity ("${b}")`, { name: ev.launch.name }) : pass("no brand or 'official' claim");
  } },
  relaunch_copycat: { requires: ["matching_launch"], fn: (ev) => ev.history.copycat
    ? trig("same name or symbol launched recently (copy / relaunch)", { matching_launch: true }) : pass("first coin with this name and symbol") },

  // ── liquidity & execution ──
  sniper_fee_window: { requires: ["fee_now_pct"], fn: (ev, p) => {
    if (!ev.quote) return ev.quoteError && /delay|locked|not.*open|revert/i.test(ev.quoteError)
      ? trig("trading not open yet (MEV block delay)", { fee_now_pct: null }) : missing(["pool_quote"], ev.quoteError ?? "no quote yet");
    return sniperWindow(ev, p) ? trig(`Clanker sniper fee still high — a round trip costs ${ev.quote.feeNow}% even at tiny size`, { fee_now_pct: ev.quote.feeNow })
                               : pass(`launch fees settled (tiny round trip ${ev.quote.feeNow}%)`, { fee_now_pct: ev.quote.feeNow });
  } },
  round_trip_uneconomic: { requires: ["round_trip_pct"], fn: (ev, p) => {
    const m = needQuote(ev); if (m) return m;
    if (sniperWindow(ev, p)) return pass("judged after the sniper-fee window (see B001)", { round_trip_pct: ev.quote!.roundTripPct });
    return above(ev.quote!.roundTripPct, p.max_pct, `instant round-trip costs ${ev.quote!.roundTripPct}% (max ${p.max_pct}%)`, { round_trip_pct: ev.quote!.roundTripPct },
                 `round-trip cost ${ev.quote!.roundTripPct}%`);
  } },
  price_impact_above_limit: { requires: ["buy_impact_pct"], fn: (ev, p) => { const m = needQuote(ev); if (m) return m;
    return above(ev.quote!.buyImpactPct, p.max_pct, `entry price impact ${ev.quote!.buyImpactPct}%`, { buy_impact_pct: ev.quote!.buyImpactPct }, `entry impact ${ev.quote!.buyImpactPct}%`); } },
  exit_slippage_above_limit: { requires: ["sell_impact_pct"], fn: (ev, p) => { const m = needQuote(ev); if (m) return m;
    return above(ev.quote!.sellImpactPct, p.max_pct, `exit price impact ${ev.quote!.sellImpactPct}%`, { sell_impact_pct: ev.quote!.sellImpactPct }, `exit impact ${ev.quote!.sellImpactPct}%`); } },
  dump_stress_exit_loss: { requires: ["dump_stress_loss_pct", "top_holder_pct"], fn: (ev, p) => { const m = needQuote(ev); if (m) return m;
    if (sniperWindow(ev, p)) return pass("judged after the sniper-fee window");
    return above(ev.quote!.dumpStressLossPct, p.max_loss_pct, `if the largest holder sells first, the exit loses ${ev.quote!.dumpStressLossPct}%`,
                 { dump_stress_loss_pct: ev.quote!.dumpStressLossPct, top_holder_pct: ev.risk.top1Pct }, `largest-holder dump stress ${ev.quote!.dumpStressLossPct}%`); } },
  cluster_dump_stress: { requires: ["cluster_dump_loss_pct", "cluster_pct"], fn: (ev, p) => { const m = needQuote(ev); if (m) return m;
    if (sniperWindow(ev, p)) return pass("judged after the sniper-fee window");
    return above(ev.quote!.clusterDumpLossPct, p.max_loss_pct, `if the creator + linked wallets sell first, the exit loses ${ev.quote!.clusterDumpLossPct}%`,
                 { cluster_dump_loss_pct: ev.quote!.clusterDumpLossPct, cluster_pct: ev.risk.insiderPct }, `insider dump stress ${ev.quote!.clusterDumpLossPct}%`); } },
  quote_stale: { requires: ["quote_age_ms"], fn: (ev, p) => { if (!ev.quote) return missing(["pool_quote"]);
    const age = ev.now - ev.quote.at; return age > p.stale_ms ? trig(`quote is ${(age / 1000).toFixed(0)}s old`, { quote_age_ms: age }) : pass("quote fresh"); } },
  fee_slippage_unestimable: { requires: ["pool_quote"], fn: (ev) => needQuote(ev) ?? pass("fees and slippage quoted by Uniswap's Quoter") },
  too_few_trades: { requires: ["trade_count"], fn: (ev, p) => {
    const n = ev.risk.buyers.length + [...ev.risk.sellers].filter((s) => s !== lc(ev.launch.creator)).length;
    return n < p.min_trades ? trig(`${n} trade(s) by others so far (need ${p.min_trades})`, { trade_count: n }) : pass(`${n} trades by others`); } },
  price_swing_high: { requires: ["swing_pct"], fn: (ev, p) => { const s = ev.risk.swingPct; if (s === null) return pass("not enough prices yet");
    return s > p.max_swing_pct ? trig(`price swung ${s}% in the window`, { swing_pct: s }) : pass(`price swing ${s}%`); } },
  early_price_crash: { requires: ["drop_pct"], fn: (ev, p) => { const d = ev.risk.dropFromFirstPct; if (d === null) return pass("no trades yet");
    return d > p.max_drop_pct ? trig(`price already ${d}% below the first trade`, { drop_pct: d }) : pass(`price ${d <= 0 ? "above" : `${d}% below`} first trade`); } },
  head_lagging: { requires: ["head_lag_blocks"], fn: (ev, p) => { const l = ev.market.headLagBlocks; if (l === null) return missing(["rpc_head"]);
    return l > p.max_lag_blocks ? trig(`bot is ${l} blocks behind the chain`, { head_lag_blocks: l }) : pass(`${l} blocks behind`); } },
  holder_data_stale: { requires: ["stream_ok"], fn: (ev) => ev.market.streamOk ? pass("block polling live") : trig("block polling interrupted — holder data may be stale", { stream_ok: false }) },

  // ── creator & wallets ──
  creator_linked_to_operator: { requires: ["previous_launches", "funder_launches"], fn: (ev, p) => {
    const prior = ev.history.prior.length, funder = ev.graph.creatorFunder, fl = ev.history.funderLaunches;
    const e = { previous_launches: prior, funder_launches: fl + 1, funder };
    if (prior > p.max_past_launches) return trig(`creator launched ${prior} other Clanker coin(s) in ${p.lookback_hours}h`, e);
    if (funder && fl + 1 >= p.funder_max_creators) return trig(`funding wallet ${short(funder)} is behind ${fl + 1} launch creators`, e);
    if (!ev.creatorTrace) return missing(["creator_funding_source"]);
    return pass("first launch from this creator and its funder", e);
  } },
  creator_rug_history: { requires: ["rug_evidence"], fn: (ev) => ev.history.rugger ? trig(`creator is a known rugger — ${ev.history.rugger}`, { rug_evidence: ev.history.rugger }) : pass("no rug history learned") },
  funding_wallet_flagged: { requires: ["funder", "flag"], fn: (ev) => {
    if (!ev.creatorTrace) return missing(["creator_wallet_history"]);
    return ev.history.funderFlag ? trig(`funding wallet ${short(ev.graph.creatorFunder)} ${ev.history.funderFlag}`, { funder: ev.graph.creatorFunder, flag: ev.history.funderFlag })
                                 : pass(ev.creatorTrace.funderIsService ? "funded from an exchange / service wallet" : "funding wallet not flagged");
  } },
  creator_history_too_short: { requires: ["tx_count", "age_hours"], fn: (ev, p) => {
    const t = ev.creatorTrace; if (!t) return missing(["creator_wallet_history"], `creator not traced (${ev.creatorTraceError ?? "pending"})`);
    const young = t.txCount < p.min_txs || (t.ageHours !== null && t.ageHours < p.min_age_hours);
    return young ? trig(`creator wallet is new (${t.txCount} txs sent${t.ageHours !== null ? `, ${t.ageHours.toFixed(1)}h old` : ""})`, { tx_count: t.txCount, age_hours: t.ageHours })
                 : pass(`creator wallet ${t.txCount} txs${t.ageHours !== null ? `, ${Math.round(t.ageHours)}h old` : ""}`, { tx_count: t.txCount, age_hours: t.ageHours });
  } },
  funding_source_unknown: { requires: ["funder"], fn: (ev) => { const t = ev.creatorTrace; if (!t) return missing(["creator_wallet_history"]);
    return !t.funder && t.txCount < 1000 ? trig("could not identify who funded the creator", { funder: null, penalty: 15 }) : pass(t.funder ? `funded by ${t.funderIsService ? "an exchange / service" : short(t.funder)}` : "long wallet history"); } },
  creator_selling_early: { requires: ["creator_sold"], fn: (ev) => ev.risk.sellers.has(lc(ev.launch.creator)) ? trig("creator sold in the first seconds", { creator_sold: true }) : pass("creator has not sold") },
  creator_share_warning: { requires: ["creator_share_pct"], fn: (ev, p) => ev.risk.creatorPct > p.warn_pct
    ? trig(`creator holds ${ev.risk.creatorPct}% of supply`, { creator_share_pct: ev.risk.creatorPct, penalty: (ev.risk.creatorPct - p.warn_pct) * p.penalty_per_pct }) : pass(`creator holds ${ev.risk.creatorPct}%`) },
  creator_share_above_limit: { requires: ["creator_share_pct"], fn: (ev, p) =>
    above(ev.risk.creatorPct, p.max_pct, `creator holds ${ev.risk.creatorPct}% (max ${p.max_pct}%)`, { creator_share_pct: ev.risk.creatorPct }, `creator holds ${ev.risk.creatorPct}%`) },
  extension_allocation: { requires: ["extensions_pct"], fn: (ev, p) =>
    above(ev.risk.extensionsPct, p.max_pct, `${ev.risk.extensionsPct}% of supply set aside for vault / airdrop / presale extensions`, { extensions_pct: ev.risk.extensionsPct, extensions: ev.launch.extensions },
          `${ev.risk.extensionsPct}% of supply in extensions`) },
  vault_unlock_supply: { requires: ["vault_pct"], fn: (ev, p) => {
    const hasVault = ev.launch.extensions.some((x) => ADDR.vaults.map(lc).includes(lc(x)));
    return hasVault && ev.risk.extensionsPct > p.max_pct ? trig(`up to ${ev.risk.extensionsPct}% of supply unlocks to insiders after the vault lock (≥ 7 days)`, { vault_pct: ev.risk.extensionsPct })
                                                          : pass(hasVault ? `vault allocation ${ev.risk.extensionsPct}%` : "no vault allocation", { vault_pct: hasVault ? ev.risk.extensionsPct : 0 });
  } },
  linked_buyers_share: { requires: ["wallets", "share_pct"], fn: (ev, p) =>
    above(ev.risk.linkedPct, p.max_pct, `${ev.graph.linked.length} creator-linked wallet(s) hold ${ev.risk.linkedPct}%`, { wallets: ev.graph.linked, share_pct: ev.risk.linkedPct }, `creator-linked wallets hold ${ev.risk.linkedPct}%`) },
  creator_funded_buyers: { requires: ["wallets", "share_pct"], fn: (ev, p) => { const ws = ev.graph.linked.filter((w) => ev.risk.buyers.includes(w)); const s = pctOf(ev, ws);
    return above(s, p.max_pct, `${ws.length} wallet(s) funded by the creator bought ${s}%`, { wallets: ws, share_pct: s }, ws.length ? `creator-funded buyers hold ${s}%` : "no creator-funded buyers"); } },
  linked_wallets_selling: { requires: ["wallets"], fn: (ev) => ev.risk.linkedSelling.length ? trig(`${ev.risk.linkedSelling.length} linked / clustered wallet(s) already selling`, { wallets: ev.risk.linkedSelling }) : pass("no linked wallet selling") },
  early_pump_and_dump: { requires: ["wallets"], fn: (ev) => { const ws = [...new Set([...ev.risk.linkedSelling, ...ev.risk.firstBlockSelling])];
    return ws.length ? trig(`${ws.length} insider / launch-block wallet(s) already dumping`, { wallets: ws }) : pass("early wallets holding"); } },
  shared_funder_cluster_share: { requires: ["groups", "share_pct"], fn: (ev, p) =>
    above(ev.risk.clusterPct, p.max_pct, `${ev.graph.clustered.length} buyers share funding wallets and hold ${ev.risk.clusterPct}%`, { groups: ev.graph.sharedFunderGroups, share_pct: ev.risk.clusterPct }, `shared-funder clusters hold ${ev.risk.clusterPct}%`) },
  linked_wash: { requires: ["wallets"], fn: (ev) => { const set = new Set([...ev.graph.linked, ...ev.graph.clustered, lc(ev.launch.creator)]);
    const ws = ev.risk.washWallets.filter((w) => set.has(w)); return ws.length ? trig(`${ws.length} linked wallet(s) buying and selling back-to-back`, { wallets: ws }) : pass("no linked wash trading"); } },
  launch_block_snipers_share: { requires: ["wallets", "share_pct"], fn: (ev, p) =>
    above(ev.risk.firstBlockPct, p.max_pct, `${ev.risk.firstBlockWallets.length} launch-block buyer(s) hold ${ev.risk.firstBlockPct}%`, { wallets: ev.risk.firstBlockWallets, share_pct: ev.risk.firstBlockPct }, `launch-block buyers hold ${ev.risk.firstBlockPct}%`) },
  wash_trading: { requires: ["wallets", "volume_share"], fn: (ev, p) => ev.risk.washWallets.length >= p.min_wallets && ev.risk.washShare > p.min_share
    ? trig(`${ev.risk.washWallets.length} wallets wash-trading ${(ev.risk.washShare * 100).toFixed(0)}% of volume`, { wallets: ev.risk.washWallets, volume_share: ev.risk.washShare }) : pass(`wash volume ${(ev.risk.washShare * 100).toFixed(0)}%`) },
  cluster_rug_history: { requires: ["wallets"], fn: (ev) => ev.graph.flaggedBuyers.length ? trig(`${ev.graph.flaggedBuyers.length} early buyer(s) linked to known ruggers`, { wallets: ev.graph.flaggedBuyers }) : pass("no early buyer linked to ruggers") },
  holder_distribution_unavailable: { requires: ["holders"], fn: (ev) => ev.risk.holders.size || ev.stage === 1 ? pass(`${ev.risk.holders.size} holders tracked`, { holders: ev.risk.holders.size }) : missing(["holder_distribution"]) },
  wallet_graph_ambiguous: { requires: ["traced", "needed"], fn: (ev) => ev.buyerTracesDone < ev.buyerTracesNeeded
    ? trig(`${ev.buyerTracesDone}/${ev.buyerTracesNeeded} early buyers traced so far`, { traced: ev.buyerTracesDone, needed: ev.buyerTracesNeeded }) : pass(`${ev.buyerTracesDone} early buyers traced`) },
  funding_graph_unresolved: { requires: ["creator_trace"], fn: (ev) => ev.creatorTrace ? pass("creator funding resolved") : missing(["creator_wallet_history"], `creator not traced (${ev.creatorTraceError ?? "pending"})`) },
  buyer_independence_uncertain: { requires: ["fresh_frac"], fn: (ev, p) => ev.risk.tracedBuyers >= 2 && ev.risk.freshFrac >= p.fresh_frac
    ? trig(`${Math.round(ev.risk.freshFrac * 100)}% of traced buyers are brand-new wallets`, { fresh_frac: ev.risk.freshFrac, penalty: p.penalty }) : pass(`${Math.round(ev.risk.freshFrac * 100)}% fresh buyer wallets`) },
  single_holder_above_limit: { requires: ["wallet", "share_pct"], fn: (ev, p) =>
    above(ev.risk.top1Pct, p.max_pct, `one wallet (${short(ev.risk.top1Wallet)}) owns ${ev.risk.top1Pct}%`, { wallet: ev.risk.top1Wallet, share_pct: ev.risk.top1Pct }, `largest non-creator wallet ${ev.risk.top1Pct}%`) },
  top10_above_limit: { requires: ["share_pct"], fn: (ev, p) => above(ev.risk.top10Pct, p.max_pct, `top-10 holders own ${ev.risk.top10Pct}% (max ${p.max_pct}%)`, { share_pct: ev.risk.top10Pct }, `top-10 holders ${ev.risk.top10Pct}%`) },
  insider_share_above_limit: { requires: ["share_pct"], fn: (ev, p) => above(ev.risk.insiderPct, p.max_pct, `creator + linked wallets hold ${ev.risk.insiderPct}%`, { share_pct: ev.risk.insiderPct }, `insiders hold ${ev.risk.insiderPct}%`) },
  combined_insider_cluster_share: { requires: ["share_pct"], fn: (ev, p) => above(ev.risk.combinedPct, p.max_pct, `insiders, clusters and launch-block buyers hold ${ev.risk.combinedPct}%`, { share_pct: ev.risk.combinedPct }, `insiders + clusters + snipers ${ev.risk.combinedPct}%`) },
  creator_cluster_selling: { requires: ["wallets"], fn: (ev) => { const ws = [...(ev.risk.sellers.has(lc(ev.launch.creator)) ? [lc(ev.launch.creator)] : []), ...ev.risk.linkedSelling];
    return ws.length ? trig("creator cluster is selling into early demand", { wallets: ws }) : pass("creator cluster holding"); } },
  known_manipulation_link: { requires: ["links"], fn: (ev) => { const links = [ev.history.rugger && `creator: ${ev.history.rugger}`, ev.history.funderFlag && `funder ${ev.history.funderFlag}`,
    ...ev.graph.flaggedBuyers.map((b) => `buyer ${short(b.wallet)}: ${b.via}`)].filter(Boolean);
    return links.length ? trig(`linked to known bad actors (${links.length})`, { links }) : pass("no link to known bad actors"); } },
  too_few_independent_buyers: { requires: ["independent_buyers"], fn: (ev, p) => ev.risk.independentBuyers.length < p.min_buyers
    ? trig(`${ev.risk.independentBuyers.length} independent buyer(s) so far (need ${p.min_buyers})`, { independent_buyers: ev.risk.independentBuyers.length }) : pass(`${ev.risk.independentBuyers.length} independent buyers`) },
  bot_buyers_majority: { requires: ["fresh_frac", "dust_frac"], fn: (ev, p) => {
    const bots = (ev.risk.tracedBuyers >= p.min_traced && ev.risk.freshFrac >= p.fresh_frac) || (ev.risk.buyers.length >= 3 && ev.risk.dustFrac >= p.dust_frac);
    return bots ? trig(`first buyers look automated (${Math.round(ev.risk.freshFrac * 100)}% fresh, ${Math.round(ev.risk.dustFrac * 100)}% dust)`, { fresh_frac: ev.risk.freshFrac, dust_frac: ev.risk.dustFrac }) : pass("first buyers look organic"); } },
  insufficient_evidence: { requires: ["core_evidence"], fn: (ev, p) => { const core = { token: !!ev.onchain, creator: !!ev.creatorTrace, quote: !!ev.quote };
    const have = Object.values(core).filter(Boolean).length / 3;
    return have < p.min_core ? trig(`only ${Math.round(have * 100)}% of core evidence available`, { core_evidence: core }) : pass(`${Math.round(have * 100)}% of core evidence`); } },

  // ── handled elsewhere / not observable in the first minutes ──
  tx_guard_at_signing: { requires: ["transaction"], fn: () => missing(["transaction"], "checked when a live transaction is built") },
  liquidity_lock_unverified: unobservable("liquidity_lock", "applies to non-Clanker AMMs"),
  balance_classification: unobservable("token_transfers", "applies to non-Clanker AMMs"),
  audit_claims: unobservable("audit_reports", "audit verification needs external reports"),
  offchain_identity_claims: unobservable("offchain_identity", "identity claims need off-chain verification"),
  sells_failing: unobservable("failed_sell_history", "failed-sell history needs more time"),
  volume_unreconciled: unobservable("volume_reconciliation", "volume reconciliation needs more time"),
  active_exploit: unobservable("exploit_monitoring", "needs an external exploit feed"),
  metadata_links: unobservable("metadata_links", "link / address screening not available"),
  token_transfer_distribution: { requires: ["token_transfers"], fn: (ev) => {
    const direct = [...ev.risk.holders.keys()].filter((w) => !ev.risk.ethIn.has(w) && w !== lc(ev.launch.creator) && (ev.risk.holders.get(w) ?? 0) / TOTAL_SUPPLY > 0.005);
    return direct.length >= 3 ? trig(`${direct.length} wallets received tokens without buying (direct transfers)`, { token_transfers: direct.length })
                              : pass("no notable direct token distribution", { token_transfers: direct.length });
  } },
};
