/** Decision (REJECT / WAIT / MONITOR / SELECT_FOR_REVIEW) and the output JSON, Base edition. */
import { config } from "../config";
import { PLATFORM_LABEL } from "../config";
import { MISSING_LABEL, type Evidence } from "../rules/registry";
import type { Decision, DecisionOutput, Factor, RuleResult } from "../types";
import { applyGates, type Gates } from "./gates";
import { FACTOR_LABEL, factorBlocked, factorScores, weightedScore } from "./scoring";

const short = (a?: string | null) => (a ? `${a.slice(0, 6)}…${a.slice(-4)}` : "—");

export interface DecisionResult {
  output: DecisionOutput; decision: Decision; score: number; factors: Record<Factor, number>; gates: Gates;
  results: RuleResult[]; gated: boolean; topHolder: string | null; topHolderTokens: number;
}

export function decide(ev: Evidence, results: RuleResult[], autoBuyAllowed: (d: Decision) => boolean): DecisionResult {
  const gates = applyGates(results);
  const factors = factorScores(ev, gates);
  const score = weightedScore(factors);
  const applicable = results.filter((r) => r.status !== "NOT_APPLICABLE");
  const completeness = Math.round((applicable.filter((r) => r.status !== "MISSING").length / Math.max(1, applicable.length)) * 100) / 100;

  let decision: Decision;
  if (gates.rejects.length) decision = "REJECT";
  else if (gates.waits.length) decision = ev.final ? "REJECT" : "WAIT";
  else if (score < config.monitorScore) decision = "REJECT";
  else if (gates.monitors.length || score < config.selectScore) decision = ev.final ? "REJECT" : "MONITOR";
  else decision = "SELECT_FOR_REVIEW";
  const gated = gates.rejects.length > 0;
  const confidence: DecisionOutput["confidence"] = gated ? "HIGH" : completeness >= 0.85 ? "HIGH" : completeness >= 0.6 ? "MEDIUM" : "LOW";

  const reasonOf = (r: RuleResult) => ({ rule_id: r.rule.rule_id, reason: r.rule.title, severity: r.rule.severity, evidence: r.text });
  const rejection = [...gates.rejects, ...gates.waits, ...gates.monitors, ...gates.warns].map(reasonOf);
  if (decision === "REJECT" && !gated)
    rejection.unshift({ rule_id: "S000", reason: ev.final ? "Unresolved at the final re-check" : "Weighted score below threshold", severity: "HIGH",
      evidence: ev.final && (gates.waits.length || gates.monitors.length) ? `still ${gates.waits.length ? "WAIT" : "MONITOR"} after ${config.recheckAt.at(-1) ?? 0}s` : `score ${score} < ${config.monitorScore}` });

  const selection: DecisionOutput["top_selection_reasons"] = [];
  if (decision !== "REJECT") {
    const q = ev.quote, r = ev.risk, t = ev.creatorTrace;
    const text: Partial<Record<Factor, string | null>> = {
      contract: ev.onchain ? `official ${PLATFORM_LABEL[ev.platform]} launch · supply ${ev.risk.supply.toLocaleString()} · no tax / blacklist · liquidity held by the platform` : null,
      liquidity: q ? `${ev.poolEth.toFixed(3)} ETH traded into pool · buy impact ${q.buyImpactPct}% · round-trip ${q.roundTripPct}% · dump-stress ${q.dumpStressLossPct}%` : null,
      creator: t ? `creator ${t.txCount} txs${t.ageHours !== null ? `, ${Math.round(t.ageHours)}h old` : ""} · ${t.funderIsService ? "exchange-funded" : t.funder ? `funder ${short(t.funder)}` : "long history"} · no prior launches · holds ${r.creatorPct}%` : null,
      holders: `top-10 ${r.top10Pct}% · largest ${r.top1Pct}% · linked ${r.linkedPct}% · clustered ${r.clusterPct}% · launch-block ${r.firstBlockPct}% · extensions ${r.extensionsPct}%`,
      buyers: `${r.independentBuyers.length} independent buyers of ${r.buyers.length} · ${Math.round(r.freshFrac * 100)}% fresh wallets`,
      execution: q ? `swing ${r.swingPct ?? 0}% · pool fee now ${q.feeNow ?? "n/a"}% · head lag ${ev.market.headLagBlocks ?? "n/a"} blocks` : null,
    };
    for (const f of Object.keys(FACTOR_LABEL) as Factor[])
      if (factors[f] >= 80 && text[f] && !factorBlocked(f, results)) selection.push({ factor_id: FACTOR_LABEL[f][0], factor: FACTOR_LABEL[f][1], score: factors[f], evidence: text[f]! });
  }

  const pct = (ws: string[]) => Math.round(ws.reduce((a, w) => a + (ev.risk.holders.get(w) ?? 0), 0) / ev.risk.supply * 10000) / 100;
  const clusters: DecisionOutput["launch_wallet"]["linked_wallet_clusters"] = [];
  if (ev.graph.linked.length) clusters.push({ type: "CREATOR_LINKED", funder: ev.graph.creatorFunder ?? ev.launch.creator, wallets: ev.graph.linked, share_pct: pct(ev.graph.linked) });
  for (const [f, ws] of Object.entries(ev.graph.sharedFunderGroups)) clusters.push({ type: "SHARED_FUNDER", funder: f, wallets: ws, share_pct: pct(ws) });
  if (ev.risk.firstBlockWallets.length) clusters.push({ type: "LAUNCH_BLOCK_SNIPERS", funder: "unknown", wallets: ev.risk.firstBlockWallets, share_pct: ev.risk.firstBlockPct });

  const authorities = ev.platform === "clanker" ? ["token_admin:metadata_only"] : ev.platform === "doppler" ? ["owner:capped_inflation_mint"] : ["none"];
  if (ev.risk.extensionsPct > 0) authorities.push(`extensions:${ev.risk.extensionsPct}%_supply`);
  const t = ev.creatorTrace;
  const funding = t?.funder ? (t.funderIsService ? `${t.funder} (exchange/service)` : t.funder) : "unknown";
  const r015 = results.find((r) => r.rule.rule_id === "R015");
  const missingLabels = [...new Set(results.filter((r) => r.status === "MISSING")
    .sort((a, b) => Number(b.rule.on_missing_evidence === "WAIT") - Number(a.rule.on_missing_evidence === "WAIT"))
    .flatMap((r) => r.missing ?? []).map((m) => MISSING_LABEL[m] ?? m))];

  const output: DecisionOutput = {
    chain: "BASE",
    token_address: ev.launch.token,
    launch_timestamp: new Date(ev.launch.blockTime * 1000 || ev.launch.receivedAt).toISOString(),
    decision_deadline_seconds: config.decisionSeconds,
    decision,
    risk_score: decision === "WAIT" ? null : score,
    confidence,
    data_completeness: completeness,
    top_selection_reasons: selection,
    top_rejection_reasons: rejection.slice(0, 5),
    launch_wallet: {
      deployer: ev.launch.creator,
      funding_source: funding,
      initial_liquidity_provider: ev.launch.locker,
      creator_token_share_pct: ev.risk.holders.size ? ev.risk.creatorPct : null,
      linked_wallet_clusters: clusters,
      previous_launches: ev.history.prior.map((p) => ({ token_address: p.mint, outcome: p.decision })),
      privileged_authorities: authorities,
    },
    market: {
      liquidity_usd: ev.market.ethUsd ? Math.round(ev.poolEth * ev.market.ethUsd * 100) / 100 : null,
      buy_price_impact_pct: ev.quote?.buyImpactPct ?? null,
      sell_price_impact_pct: ev.quote?.sellImpactPct ?? null,
      estimated_round_trip_cost_pct: ev.quote?.roundTripPct ?? null,
      sell_simulation: r015?.status === "TRIGGERED" ? "FAILED" : r015?.status === "PASS" ? "MODELED_PASS" : "NOT_VERIFIED",
    },
    risk_rules_checked: results.filter((r) => r.status !== "MISSING").length,
    risk_rules_triggered: results.filter((r) => r.status === "TRIGGERED").map((r) => r.rule.rule_id),
    missing_data: missingLabels,
    auto_buy_allowed: autoBuyAllowed(decision),
  };
  const topHolder = ev.risk.top1Wallet;
  return { output, decision, score, factors, gates, results, gated, topHolder, topHolderTokens: topHolder ? ev.risk.holders.get(topHolder) ?? 0 : 0 };
}
