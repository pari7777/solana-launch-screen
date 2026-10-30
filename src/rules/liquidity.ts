/** Liquidity, exit, market-quality and execution evaluators. */
import { config } from "../config";
import { INITIAL_VSOL, sellOut } from "../decoders/bonding-curve";
import { PUMP_PROGRAM } from "../decoders/pump-launch";
import { sellRestrictions } from "./contract";
import { type Evaluator, type Evidence, missing, pass, trig } from "./helpers";

const needQuote = (ev: Evidence) => (ev.quote && ev.reserves ? null : missing(["pool_reserves"], "no reserve data to quote the trade"));
const curveState = (ev: Evidence) => ({
  vsol: ev.reserves?.vsol ?? ev.contract?.curve.vsol ?? null, vtok: ev.reserves?.vtok ?? ev.contract?.curve.vtok ?? null,
  real_sol: realSol(ev), complete: ev.contract?.curve.complete ?? null,
});
/** Real SOL in the curve = virtual SOL − the 30 virtual SOL every pump.fun curve starts with (stream reserves are fresher). */
export const realSol = (ev: Evidence) => (ev.reserves ? Math.max(0, ev.reserves.vsol - INITIAL_VSOL) : ev.contract?.curve.rsol ?? null);

const unobservable = (label: string, why: string): Evaluator => ({ requires: [label], fn: () => missing([label], why) });

export const liquidityEvaluators: Record<string, Evaluator> = {
  no_live_curve: { requires: ["curve_or_pool_state"], fn: (ev) => {
    if (!ev.contract && !ev.reserves) return missing(["contract_accounts", "pool_reserves"]);
    const c = ev.contract?.curve;
    if (c?.complete) return trig("bonding curve already completed — coin has migrated", { curve_or_pool_state: curveState(ev) });
    if ((c && (c.vsol <= 0 || c.vtok <= 0)) || (ev.reserves && (ev.reserves.vsol <= 0 || ev.reserves.vtok <= 0)))
      return trig("curve has no reserves", { curve_or_pool_state: curveState(ev) });
    return pass("live pump.fun bonding curve", { curve_or_pool_state: curveState(ev) });
  } },
  exit_liquidity_zero: { requires: ["curve_or_pool_state", "round_trip_pct"], fn: (ev) => {
    const m = needQuote(ev); if (m) return m;
    return ev.quote!.roundTripPct >= 99 ? trig("selling the position right after buying returns ~nothing", { curve_or_pool_state: curveState(ev), round_trip_pct: ev.quote!.roundTripPct })
                                        : pass(`position can be sold back (round-trip ${ev.quote!.roundTripPct}%)`);
  } },
  sell_simulation_failed_due_to_restriction: {
    requires: ["simulation_result", "transaction_context", "curve_or_pool_state"],
    fn: (ev) => {
      const miss = [...(ev.contract ? [] : ["contract_accounts"]), ...(ev.quote ? [] : ["pool_reserves"])];
      if (miss.length) return missing(miss, "cannot model the sell without token permissions and reserves");
      const restrictions = sellRestrictions(ev);
      const b = ev.quote!;
      const simulation_result = { modeled_exit_sol: Math.round(config.buySol * (1 - b.roundTripPct / 100) * 1e6) / 1e6,
                                  blocked: restrictions.length > 0, method: "bonding-curve model + token permission check" };
      const transaction_context = { token_program: ev.contract!.mint.owner, curve_program: PUMP_PROGRAM, restrictions, buy_size_sol: config.buySol };
      const e = { simulation_result, transaction_context, curve_or_pool_state: curveState(ev) };
      return restrictions.length ? trig(`sell would fail: ${restrictions.join(", ")}`, e) : pass("modeled sell succeeds — no transfer restriction", e);
    } },
  exit_slippage_above_limit: { requires: ["sell_impact_pct"], fn: (ev, p) => {
    const m = needQuote(ev); if (m) return m;
    return ev.quote!.sellImpactPct > p.max_pct ? trig(`exit price impact ${ev.quote!.sellImpactPct}% (max ${p.max_pct}%)`, { sell_impact_pct: ev.quote!.sellImpactPct })
                                               : pass(`exit price impact ${ev.quote!.sellImpactPct}%`);
  } },
  reserves_disagree: { requires: ["onchain_vsol", "stream_vsol"], fn: (ev, p) => {
    if (!ev.contract || !ev.reserves) return missing([...(ev.contract ? [] : ["contract_accounts"]), ...(ev.reserves ? [] : ["pool_reserves"])]);
    const a = ev.contract.curve.vsol, b = ev.reserves.vsol;
    const diff = Math.abs(a - b) / Math.max(b, 1e-9) * 100;
    return diff > p.max_diff_pct ? trig(`on-chain reserves ${a.toFixed(2)} SOL vs stream ${b.toFixed(2)} SOL (${diff.toFixed(0)}% apart)`, { onchain_vsol: a, stream_vsol: b })
                                 : pass(`on-chain and stream reserves agree (${diff.toFixed(1)}%)`);
  } },
  price_source_invalid: { requires: ["curve_or_pool_state"], fn: (ev) => {
    if (!ev.contract) return missing(["contract_accounts"]);
    const c = ev.contract.curve;
    return c.owner !== PUMP_PROGRAM || c.complete || c.vsol <= 0 ? trig("price source is not a live pump.fun curve", { curve_or_pool_state: curveState(ev) })
                                                                  : pass("price from the live pump.fun curve");
  } },
  round_trip_uneconomic: { requires: ["round_trip_pct"], fn: (ev, p) => {
    const m = needQuote(ev); if (m) return m;
    return ev.quote!.roundTripPct > p.max_pct ? trig(`instant round-trip costs ${ev.quote!.roundTripPct}% (max ${p.max_pct}%)`, { round_trip_pct: ev.quote!.roundTripPct })
                                              : pass(`round-trip cost ${ev.quote!.roundTripPct}%`);
  } },
  effective_sell_tax_above_limit: { requires: ["round_trip_pct", "transfer_fee"], fn: (ev, p) => {
    const m = needQuote(ev); if (m) return m;
    const fee = (ev.activeExtensions ?? []).some((e) => e.type === 1);
    return fee || ev.quote!.roundTripPct > p.max_pct ? trig(`effective sell cost ${ev.quote!.roundTripPct}%${fee ? " + token transfer fee" : ""}`, { round_trip_pct: ev.quote!.roundTripPct, transfer_fee: fee })
                                                     : pass(`effective sell cost ${ev.quote!.roundTripPct}%, no transfer fee`);
  } },
  pool_state_incomplete: { requires: ["curve_or_pool_state"], fn: (ev) => {
    if (!ev.reserves && !ev.contract) return missing(["pool_reserves", "contract_accounts"]);
    return pass("reserves available", { curve_or_pool_state: curveState(ev) });
  } },
  price_impact_above_limit: { requires: ["buy_impact_pct"], fn: (ev, p) => {
    const m = needQuote(ev); if (m) return m;
    return ev.quote!.buyImpactPct > p.max_pct ? trig(`entry price impact ${ev.quote!.buyImpactPct}% (max ${p.max_pct}%)`, { buy_impact_pct: ev.quote!.buyImpactPct })
                                              : pass(`entry price impact ${ev.quote!.buyImpactPct}%`);
  } },
  dump_stress_exit_loss: { requires: ["dump_stress_loss_pct", "top_holder_pct"], fn: (ev, p) => {
    const m = needQuote(ev); if (m) return m;
    return ev.quote!.dumpStressLossPct > p.max_loss_pct
      ? trig(`if the largest holder sells first, the exit loses ${ev.quote!.dumpStressLossPct}%`, { dump_stress_loss_pct: ev.quote!.dumpStressLossPct, top_holder_pct: ev.risk.top1Pct })
      : pass(`largest-holder dump stress ${ev.quote!.dumpStressLossPct}%`);
  } },
  cluster_dump_stress: { requires: ["cluster_dump_loss_pct", "cluster_pct"], fn: (ev, p) => {
    const m = needQuote(ev); if (m) return m;
    return ev.quote!.clusterDumpLossPct > p.max_loss_pct
      ? trig(`if the creator + linked wallets sell first, the exit loses ${ev.quote!.clusterDumpLossPct}%`, { cluster_dump_loss_pct: ev.quote!.clusterDumpLossPct, cluster_pct: ev.risk.insiderPct })
      : pass(`insider-cluster dump stress ${ev.quote!.clusterDumpLossPct}%`);
  } },
  cluster_controls_liquidity: { requires: ["cluster_extract_sol", "others_sol"], fn: (ev, p) => {
    // How much of OTHER buyers' SOL the deployer + linked wallets could pull out by selling everything.
    // (The deployer always buys first, so "can withdraw most real SOL" is true of every new coin and proves nothing.)
    const m = needQuote(ev); if (m) return m;
    const rs = realSol(ev); if (!rs) return pass("no real SOL yet");
    const cluster = new Set([ev.launch.deployer, ...ev.graph.linked, ...ev.graph.clustered]);
    const clusterIn = ev.risk.buyers.concat([ev.launch.deployer]).filter((w, i, a) => a.indexOf(w) === i && cluster.has(w))
      .reduce((a, w) => a + (ev.risk.solIn.get(w) ?? 0), 0);
    const othersSol = Math.max(0, rs - clusterIn);
    if (othersSol < (p.min_others_sol ?? 0.5)) return pass(`only ${othersSol.toFixed(2)} SOL from independent buyers so far`);
    const out = sellOut(ev.reserves!.vsol, ev.reserves!.vtok, ev.risk.clusterTokens, ev.feePct).sol;
    const extract = Math.max(0, out - clusterIn);
    const ratio = extract / othersSol;
    const e = { cluster_extract_sol: Math.round(extract * 1e4) / 1e4, others_sol: Math.round(othersSol * 1e4) / 1e4 };
    return ratio >= p.max_ratio ? trig(`deployer cluster could take ${(ratio * 100).toFixed(0)}% of other buyers' SOL`, e)
                                : pass(`deployer cluster could take ${(ratio * 100).toFixed(0)}% of other buyers' SOL`, e);
  } },
  quote_stale: { requires: ["quote_age_ms"], fn: (ev, p) => {
    if (!ev.reserves) return missing(["pool_reserves"]);
    const age = ev.now - ev.reserves.at, fresh = ev.contract && ev.now - ev.contract.fetchedAt < p.stale_ms;
    return age > p.stale_ms && !fresh ? trig(`quote is ${(age / 1000).toFixed(0)}s old and could not be refreshed`, { quote_age_ms: age })
                                      : pass("quote is fresh");
  } },
  migration_complete: { requires: ["curve_or_pool_state"], fn: (ev) => {
    if (!ev.contract) return missing(["contract_accounts"]);
    return ev.contract.curve.complete ? trig("curve completed — trading moved to PumpSwap", { curve_or_pool_state: curveState(ev) }) : pass("still on the bonding curve");
  } },
  migration_near: { requires: ["real_sol"], fn: (ev, p) => {
    const rs = realSol(ev); if (rs === null) return missing(["pool_reserves"]);
    return rs >= p.real_sol ? trig(`${rs.toFixed(0)} SOL in curve — migration close`, { real_sol: rs }) : pass(`${rs.toFixed(2)} SOL in curve`);
  } },
  sell_model_unavailable: { requires: ["pool_reserves"], fn: (ev) => needQuote(ev) ?? pass("sell modeled from current reserves") },
  fee_slippage_unestimable: { requires: ["pool_reserves"], fn: (ev) => needQuote(ev) ?? pass("fees and worst-case slippage estimated") },
  too_few_trades: { requires: ["trade_count"], fn: (ev, p) => {
    const n = ev.risk.buyers.length + [...ev.risk.sellers].filter((s) => s !== ev.launch.deployer).length;
    return n < p.min_trades ? trig(`${n} trade(s) by others so far (need ${p.min_trades})`, { trade_count: n }) : pass(`${n} trades by others`);
  } },
  max_tx_cost_above_limit: { requires: ["max_cost_sol"], fn: (_ev, p) => {
    const cost = config.buySol * (1 + config.slippagePct / 100) + 2 * config.priorityFeeSol;
    return cost > p.max_cost_sol ? trig(`worst-case cost ${cost.toFixed(4)} SOL > limit ${p.max_cost_sol}`, { max_cost_sol: cost })
                                 : pass(`worst-case cost ${cost.toFixed(4)} SOL`);
  } },
  priority_fee_uneconomic: { requires: ["priority_fee_pct"], fn: (_ev, p) => {
    const pct = (2 * config.priorityFeeSol) / config.buySol * 100;
    return pct > p.max_pct ? trig(`priority fees are ${pct.toFixed(1)}% of the trade`, { priority_fee_pct: pct }) : pass(`priority fees ${pct.toFixed(1)}% of trade`);
  } },
  network_congestion: { requires: ["priority_fee_micro_lamports"], fn: (ev, p) => {
    const f = ev.market.priorityFeeMicroLamports; if (f === null) return missing(["priority_fees"]);
    return f > p.max_micro_lamports ? trig(`median priority fee ${f.toLocaleString()} µlamports/CU — network congested`, { priority_fee_micro_lamports: f })
                                    : pass(`median priority fee ${f.toLocaleString()} µlamports/CU`);
  } },
  rpc_lagging: { requires: ["rpc_lag_slots"], fn: (ev, p) => {
    const lag = ev.market.rpcLagSlots; if (lag === null) return missing(["rpc_slot"]);
    return lag > p.max_lag_slots ? trig(`RPC is ${lag} slots behind the stream`, { rpc_lag_slots: lag }) : pass(`RPC lag ${lag} slots`);
  } },
  price_swing_high: { requires: ["swing_pct"], fn: (ev, p) => {
    const s = ev.risk.swingPct; if (s === null) return pass("not enough prices yet");
    return s > p.max_swing_pct ? trig(`price swung ${s}% in the window`, { swing_pct: s }) : pass(`price swing ${s}%`);
  } },
  early_price_crash: { requires: ["drop_from_launch_pct"], fn: (ev, p) => {
    const d = ev.risk.dropFromLaunchPct; if (d === null) return pass("no trades yet");
    return d > p.max_drop_pct ? trig(`price already ${d}% below launch`, { drop_from_launch_pct: d }) : pass(`price ${d <= 0 ? "above" : `${d}% below`} launch`);
  } },
  holder_data_stale: { requires: ["stream_ok"], fn: (ev) =>
    ev.market.streamOk ? pass("trade stream live") : trig("trade stream disconnected — holder data may be stale", { stream_ok: false }) },
  tx_guard_at_signing: { requires: ["transaction"], fn: () => missing(["transaction"], "checked by the signing guard when a transaction is built") },
  liquidity_lock_unverified: unobservable("liquidity_lock", "LP locks only exist on other AMMs"),
  insider_unlock: unobservable("vesting_schedule", "unlock schedules only exist off pump.fun"),
  balance_classification: unobservable("token_transfers", "pool/burn classification applies to other AMMs"),
  sells_failing: unobservable("failed_sell_history", "failed-sell history needs more than 6 seconds"),
  volume_unreconciled: unobservable("volume_reconciliation", "volume reconciliation needs more than 6 seconds"),
  active_exploit: unobservable("exploit_monitoring", "needs an external exploit-monitoring feed"),
};
