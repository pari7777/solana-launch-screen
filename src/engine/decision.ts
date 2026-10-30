/**
 * Decision (spec section 4) and the exact output JSON (spec section 5).
 *   REJECT             a verified critical risk / hard limit, or still unresolved at the final re-check
 *   WAIT               critical evidence missing, stale or contradictory
 *   MONITOR            gates pass, more independent trading evidence needed
 *   SELECT_FOR_REVIEW  gates pass and score ≥ SELECT_SCORE
 */
import { config } from "../config";
import { MISSING_LABEL, type Evidence } from "../rules/registry";
import type { Decision, DecisionOutput, Factor, RuleResult } from "../types";
import { applyGates, type Gates } from "./gates";
import { FACTOR_LABEL, factorBlocked, factorScores, weightedScore } from "./scoring";
import { INITIAL_VSOL, TOTAL_SUPPLY } from "../decoders/bonding-curve";

const SAFE_EXT = new Set([18, 19, 20, 21, 22, 23]);
const short = (a?: string | null) => (a ? `${a.slice(0, 4)}…${a.slice(-4)}` : "—");

export interface DecisionResult {
  output: DecisionOutput;
  decision: Decision;
  score: number;
  factors: Record<Factor, number>;
  gates: Gates;
  results: RuleResult[];
  gated: boolean;
  topHolder: string | null;          // largest non-deployer wallet (watched for dumps after a buy)
  topHolderTokens: number;
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

  // ── reasons ──
  const reasonOf = (r: RuleResult) => ({ rule_id: r.rule.rule_id, reason: r.rule.title, severity: r.rule.severity, evidence: r.text });
  const rejection = [...gates.rejects, ...gates.waits, ...gates.monitors, ...gates.warns].map(reasonOf);
  if (decision === "REJECT" && !gated) {
    rejection.unshift({ rule_id: "S000", reason: ev.final ? "Unresolved at the final re-check" : "Weighted score below threshold",
      severity: "HIGH", evidence: ev.final && (gates.waits.length || gates.monitors.length)
        ? `still ${gates.waits.length ? "WAIT" : "MONITOR"} after ${config.recheckAt.at(-1) ?? 0}s` : `score ${score} < ${config.monitorScore}` });
  }

  const selection: DecisionOutput["top_selection_reasons"] = [];
  if (decision !== "REJECT") {
    const q = ev.quote, r = ev.risk, t = ev.deployerTrace;
    const text: Partial<Record<Factor, string | null>> = {
      contract: ev.contract ? `mint & freeze authority revoked · standard 1B supply · ${ev.contract.mint.owner.startsWith("Tokenz") ? "Token-2022 (metadata only)" : "SPL Token"} · standard pump.fun curve` : null,
      liquidity: q ? `${realSol(ev)?.toFixed(2)} SOL in curve · buy impact ${q.buyImpactPct}% · round-trip ${q.roundTripPct}% · dump-stress loss ${q.dumpStressLossPct}%` : null,
      creator: t ? `deployer ${t.old ? "1000+ txs" : `${t.txCount} txs`}, ${t.ageHours.toFixed(0)}h old · ${t.funderIsService ? "exchange-funded" : t.funder ? `funder ${short(t.funder)}` : "long history"} · no prior launches · holds ${r.deployerPct}%` : null,
      holders: `top-10 ${r.top10Pct}% · largest wallet ${r.top1Pct}% · linked ${r.linkedPct}% · clustered ${r.clusterPct}% · snipers ${r.bundlePct}%`,
      buyers: `${r.independentBuyers.length} independent buyers of ${r.buyers.length} · ${Math.round(r.freshFrac * 100)}% fresh wallets`,
      execution: q ? `swing ${r.swingPct ?? 0}% · priority-fee pressure ${ev.market.priorityFeeMicroLamports ?? "n/a"} µlamports/CU · RPC lag ${ev.market.rpcLagSlots ?? "n/a"} slots` : null,
    };
    for (const f of Object.keys(FACTOR_LABEL) as Factor[]) {
      if (factors[f] >= 80 && text[f] && !factorBlocked(f, results))
        selection.push({ factor_id: FACTOR_LABEL[f][0], factor: FACTOR_LABEL[f][1], score: factors[f], evidence: text[f]! });
    }
  }

  // ── launch wallet ──
  const pct = (ws: string[]) => Math.round(ws.reduce((a, w) => a + (ev.risk.holders.get(w) ?? 0), 0) / TOTAL_SUPPLY * 10000) / 100;
  const clusters: DecisionOutput["launch_wallet"]["linked_wallet_clusters"] = [];
  if (ev.graph.linked.length) clusters.push({ type: "DEPLOYER_LINKED", funder: ev.graph.deployerFunder ?? ev.launch.deployer, wallets: ev.graph.linked, share_pct: pct(ev.graph.linked) });
  for (const [f, ws] of Object.entries(ev.graph.sharedFunderGroups)) clusters.push({ type: "SHARED_FUNDER", funder: f, wallets: ws, share_pct: pct(ws) });
  if (ev.risk.bundleWallets.length) clusters.push({ type: "LAUNCH_BLOCK_SNIPERS", funder: "unknown", wallets: ev.risk.bundleWallets, share_pct: ev.risk.bundlePct });

  const authorities: string[] = [];
  if (ev.contract?.mint.mintAuthority) authorities.push("mint_authority");
  if (ev.contract?.mint.freezeAuthority) authorities.push("freeze_authority");
  for (const e of ev.activeExtensions ?? []) if (!SAFE_EXT.has(e.type)) authorities.push(`token2022:${e.name}`);

  const prev: Record<string, unknown>[] = ev.history.prior.map((p) => ({ token_address: p.mint, outcome: p.decision }));
  if (ev.history.pumpfunPast?.count) prev.push({ source: "pump.fun", count: ev.history.pumpfunPast.count, graduated: ev.history.pumpfunPast.graduated });

  const t = ev.deployerTrace;
  const funding = t?.funder ? (t.funderIsService ? `${t.funder} (exchange/service)` : t.funder) : t?.old ? "unknown (long wallet history)" : "unknown";

  const r015 = results.find((r) => r.rule.rule_id === "R015");
  const rs = realSol(ev);
  const missingLabels = [...new Set(results.filter((r) => r.status === "MISSING")
    .sort((a, b) => Number(b.rule.on_missing_evidence === "WAIT") - Number(a.rule.on_missing_evidence === "WAIT"))
    .flatMap((r) => r.missing ?? []).map((m) => MISSING_LABEL[m] ?? m))];

  const output: DecisionOutput = {
    chain: "SOLANA",
    token_address: ev.launch.mint,
    launch_timestamp: new Date(ev.launch.receivedAt).toISOString(),
    decision_deadline_seconds: config.decisionSeconds,
    decision,
    risk_score: decision === "WAIT" ? null : score,
    confidence,
    data_completeness: completeness,
    top_selection_reasons: selection,
    top_rejection_reasons: rejection.slice(0, 5),
    launch_wallet: {
      deployer: ev.launch.deployer,
      funding_source: funding,
      initial_liquidity_provider: ev.contract?.curveKey ?? ev.launch.bondingCurve ?? "unknown",
      creator_token_share_pct: ev.risk.holders.size ? ev.risk.deployerPct : null,
      linked_wallet_clusters: clusters,
      previous_launches: prev,
      privileged_authorities: authorities,
    },
    market: {
      liquidity_usd: rs !== null && ev.market.solUsd ? Math.round(rs * ev.market.solUsd * 100) / 100 : null,
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
  return { output, decision, score, factors, gates, results, gated, topHolder,
           topHolderTokens: topHolder ? ev.risk.holders.get(topHolder) ?? 0 : 0 };
}

function realSol(ev: Evidence) {
  if (ev.reserves) return Math.max(0, ev.reserves.vsol - INITIAL_VSOL);
  return ev.contract ? ev.contract.curve.rsol : null;
}
