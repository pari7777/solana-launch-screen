/** Rule registry for Base: loads the rules, applies rules-overrides.json, evaluates them for one launch. */
import fs from "node:fs";
import { config } from "../config";
import type { RuleDef, RuleResult } from "../types";
import { EVALUATORS } from "./evaluators";
import type { Evidence } from "./evidence";
import { RULE_DEFS } from "./rules";

export * from "./evidence";
export { EVALUATORS };

export const MISSING_LABEL: Record<string, string> = {
  token_contract: "Token contract read", pool_key: "Uniswap v4 pool key", pool_quote: "Executable pool quote",
  creator_wallet_history: "Creator wallet history", creator_funding_source: "Creator funding source",
  holder_distribution: "Holder distribution", rpc_head: "RPC head freshness", transaction: "Signed transaction",
  failed_sell_history: "Failed-sell history", volume_reconciliation: "Volume reconciliation", offchain_identity: "Off-chain identity verification",
  metadata_links: "Metadata link / address screening", audit_reports: "Audit verification", exploit_monitoring: "Exploit monitoring feed",
  liquidity_lock: "Liquidity lock (non-Clanker)", token_transfers: "Token transfer history",
};

let cached: RuleDef[] | null = null;
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
    if (!rule.applies_to.includes(ev.venue)) return { rule, status: "NOT_APPLICABLE", text: `not applicable to ${ev.venue}`, evidence: {} } as RuleResult;
    try { return { rule, ...EVALUATORS[rule.condition].fn(ev, rule.params ?? {}) } as RuleResult; }
    catch (e) { return { rule, status: "MISSING", text: `evaluation error: ${(e as Error).message}`, evidence: {}, missing: ["evaluation_error"] } as RuleResult; }
  });
}
