/** Hard gates: what each rule result means for the decision, before any score is considered. */
import type { RuleResult, Severity } from "../types";

const SEV: Record<Severity, number> = { CRITICAL: 0, HIGH: 1, MEDIUM: 2, LOW: 3 };

export interface Gates {
  rejects: RuleResult[];      // triggered rules with on_trigger REJECT
  waits: RuleResult[];        // triggered WAIT rules + missing evidence where on_missing_evidence = WAIT
  monitors: RuleResult[];     // triggered MONITOR rules
  warns: RuleResult[];        // triggered WARN rules (score penalty only)
}

export function applyGates(results: RuleResult[]): Gates {
  const by = (f: (r: RuleResult) => boolean) =>
    results.filter(f).sort((a, b) => SEV[a.rule.severity] - SEV[b.rule.severity] || a.rule.rule_id.localeCompare(b.rule.rule_id));
  return {
    rejects: by((r) => r.status === "TRIGGERED" && r.rule.on_trigger === "REJECT"),
    waits: by((r) => (r.status === "TRIGGERED" && r.rule.on_trigger === "WAIT") || (r.status === "MISSING" && r.rule.on_missing_evidence === "WAIT")),
    monitors: by((r) => r.status === "TRIGGERED" && r.rule.on_trigger === "MONITOR"),
    warns: by((r) => r.status === "TRIGGERED" && r.rule.on_trigger === "WARN"),
  };
}
