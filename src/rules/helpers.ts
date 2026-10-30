/** Shared types and helpers for rule evaluators (kept separate to avoid import cycles). */
import type { ClusterRisk } from "../graph/cluster-risk";
import type { FundingGraph } from "../graph/funding-graph";
import type { ContractInfo, LaunchEvent, Quote, RuleOutcome, Venue, WalletTrace } from "../types";

export interface Evidence {
  venue: Venue;
  stage: number;
  final: boolean;
  now: number;
  launch: LaunchEvent;
  contract: ContractInfo | null;
  contractError: string | null;
  activeExtensions: { type: number; name: string; detail?: string }[] | null;
  reserves: { vsol: number; vtok: number; at: number } | null;
  quote: Quote | null;
  feePct: number;
  risk: ClusterRisk;
  graph: FundingGraph;
  deployerTrace: WalletTrace | null;
  deployerTraceError: string | null;
  buyerTracesNeeded: number;
  buyerTracesDone: number;
  history: {
    rugger: string | null;
    prior: { mint: string; decision: string }[];
    pumpfunChecked: boolean;
    pumpfunPast: { count: number; graduated: number } | null;
    copycat: boolean;
    funderFlag: string | null;
    funderLaunches: number;
  };
  metadata: { checked: boolean; ok: boolean | null };
  market: { rpcLagSlots: number | null; priorityFeeMicroLamports: number | null; solUsd: number | null; streamOk: boolean };
}

export type Params = Record<string, number>;
export interface Evaluator { requires: string[]; fn: (ev: Evidence, p: Params) => RuleOutcome }

// helpers for evaluators
export const trig = (text: string, evidence: Record<string, unknown>): RuleOutcome => ({ status: "TRIGGERED", text, evidence });
export const pass = (text: string, evidence: Record<string, unknown> = {}): RuleOutcome => ({ status: "PASS", text, evidence });
export const missing = (what: string[], text = "required evidence not available yet"): RuleOutcome =>
  ({ status: "MISSING", text, evidence: {}, missing: what });

