/**
 * Rule registry: loads the 120 declarative rules, applies config/rules-overrides.json, validates every rule
 * against its evaluator, and evaluates them all for one launch.
 *
 * Status per rule:  TRIGGERED · PASS · MISSING (evidence not available) · NOT_APPLICABLE (venue not in applies_to)
 */
import fs from "node:fs";
import type { RuleDef, RuleResult } from "../types";
import { config } from "../config";
import { RULE_DEFS } from "./rules-001-120";
import { contractEvaluators } from "./contract";
import { liquidityEvaluators } from "./liquidity";
import { walletEvaluators } from "./wallets";

export * from "./helpers";
import type { Evaluator } from "./helpers";
import type { Evidence } from "./helpers";

export const EVALUATORS: Record<string, Evaluator> = { ...contractEvaluators, ...liquidityEvaluators, ...walletEvaluators };

export const MISSING_LABEL: Record<string, string> = {
  contract_accounts: "Token and bonding-curve accounts",
  deployer_wallet_history: "Deployer wallet history",
  deployer_funding_source: "Deployer funding source",
  pumpfun_history: "pump.fun launch history",
  pool_reserves: "Pool reserves / executable quote",
  holder_distribution: "Holder distribution",
  buyer_funding_traces: "Early-buyer funding traces",
  token_metadata: "Token metadata",
  rpc_slot: "RPC slot freshness",
  priority_fees: "Network priority-fee data",
  failed_sell_history: "Failed-sell history",
  volume_reconciliation: "Volume reconciliation",
  token_transfers: "Token transfer history",
  offchain_identity: "Off-chain identity verification",
  metadata_links: "Metadata link / address screening",
  audit_reports: "Audit verification",
  exploit_monitoring: "Exploit monitoring feed",
  liquidity_lock: "Verified liquidity lock status",
  vesting_schedule: "Verified vesting / unlock schedule",
};

let cached: RuleDef[] | null = null;

/** Rules with overrides applied (enable/disable, severity, on_trigger, params) from RULES_OVERRIDE_PATH. */
export function loadRules(overridePath = config.rulesOverridePath): RuleDef[] {
  if (cached) return cached;
  let overrides: Record<string, Partial<RuleDef>> = {};
  try { if (overridePath && fs.existsSync(overridePath)) overrides = JSON.parse(fs.readFileSync(overridePath, "utf8")); }
  catch (e) { console.error(`Could not read ${overridePath}: ${(e as Error).message} — using defaults`); }
  cached = RULE_DEFS.map((r) => {
    const o = overrides[r.rule_id];
    const merged: RuleDef = o ? { ...r, ...o, params: { ...(r.params ?? {}), ...(o.params ?? {}) }, rule_id: r.rule_id } : r;
    const ev = EVALUATORS[merged.condition];
    if (!ev) throw new Error(`${r.rule_id}: no evaluator for condition "${merged.condition}"`);
    if (!merged.evidence_required?.length) merged.evidence_required = ev.requires;
    return merged;
  });
  return cached;
}
export function resetRuleCache() { cached = null; }

export function evaluateAll(ev: Evidence, rules = loadRules()): RuleResult[] {
  return rules.filter((r) => r.enabled).map((rule) => {
    if (!rule.applies_to.includes(ev.venue))
      return { rule, status: "NOT_APPLICABLE", text: `not applicable to ${ev.venue}`, evidence: {} } as RuleResult;
    try {
      const o = EVALUATORS[rule.condition].fn(ev, rule.params ?? {});
      return { rule, ...o } as RuleResult;
    } catch (e) {
      return { rule, status: "MISSING", text: `evaluation error: ${(e as Error).message}`, evidence: {}, missing: ["evaluation_error"] } as RuleResult;
    }
  });
}
