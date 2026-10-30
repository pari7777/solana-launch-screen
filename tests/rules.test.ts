import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { EXT } from "../src/data/accounts";
import { evaluateAll, EVALUATORS, loadRules, resetRuleCache } from "../src/rules/registry";
import { makeEvidence } from "./fixtures/evidence";

const status = (results: ReturnType<typeof evaluateAll>, id: string) => results.find((r) => r.rule.rule_id === id)?.status;
afterEach(() => resetRuleCache());

describe("rule library", () => {
  it("has R001–R120 plus custom rules, each with an evaluator and valid fields", () => {
    const rules = loadRules("");
    const ids = rules.map((r) => r.rule_id);
    for (let i = 1; i <= 120; i++) expect(ids).toContain(`R${String(i).padStart(3, "0")}`);
    expect(new Set(ids).size).toBe(ids.length);
    for (const r of rules) {
      expect(EVALUATORS[r.condition], r.rule_id).toBeDefined();
      expect(["CRITICAL", "HIGH", "MEDIUM", "LOW"]).toContain(r.severity);
      expect(["REJECT", "WAIT", "MONITOR", "WARN"]).toContain(r.on_trigger);
      expect(["WAIT", "IGNORE"]).toContain(r.on_missing_evidence);
      expect(r.version).toBe(1); expect(r.applies_to.length).toBeGreaterThan(0); expect(r.title.length).toBeGreaterThan(5);
    }
  });

  it("R015 matches the specified rule format exactly", () => {
    const r = loadRules("").find((x) => x.rule_id === "R015")!;
    expect({ rule_id: r.rule_id, version: r.version, category: r.category, severity: r.severity, applies_to: r.applies_to,
             condition: r.condition, evidence_required: r.evidence_required, on_trigger: r.on_trigger,
             on_missing_evidence: r.on_missing_evidence, enabled: r.enabled }).toEqual({
      rule_id: "R015", version: 1, category: "liquidity_exit", severity: "CRITICAL", applies_to: ["pump_bonding_curve", "pumpswap"],
      condition: "sell_simulation_failed_due_to_restriction", evidence_required: ["simulation_result", "transaction_context", "curve_or_pool_state"],
      on_trigger: "REJECT", on_missing_evidence: "WAIT", enabled: true });
  });

  it("a clean launch triggers no REJECT or WAIT rule", () => {
    const res = evaluateAll(makeEvidence(), loadRules(""));
    const bad = res.filter((r) => r.status === "TRIGGERED" && ["REJECT", "WAIT"].includes(r.rule.on_trigger));
    expect(bad.map((r) => `${r.rule.rule_id} ${r.text}`)).toEqual([]);
  });

  it("every TRIGGERED result carries the evidence its rule requires", () => {
    const scenarios = [
      makeEvidence({ mint: { mintAuthority: true, freezeAuthority: true } }),
      makeEvidence({ mint: { ext: [{ type: EXT.TransferHook, data: Buffer.alloc(64, 1) }, { type: EXT.PermanentDelegate, data: Buffer.alloc(32, 2) },
                                   { type: EXT.Pausable, data: Buffer.alloc(33, 3) }, { type: 31, data: Buffer.alloc(4) }] } }),
      makeEvidence({ devBuySol: 4, deployerSells: 0.9, symbol: "BONK", name: "Official Solana Coin",
                     deployerTrace: { txCount: 3, ageHours: 0.2 }, history: { rugger: "dumped 90%", copycat: true, prior: [{ mint: "x", decision: "REJECT" }] } }),
      makeEvidence({ buyers: [{ sol: 2, trace: { funder: "DEPLOYER" } }, { sol: 1.5, trace: { funder: "SAME" } }, { sol: 1.5, trace: { funder: "SAME" } },
                              { sol: 2, atMs: 100, sellFrac: 0.5 }, { sol: 0.001 }] }),
    ];
    for (const ev of scenarios) for (const r of evaluateAll(ev, loadRules(""))) {
      if (r.status !== "TRIGGERED") continue;
      for (const k of r.rule.evidence_required) expect(Object.keys(r.evidence), `${r.rule.rule_id} missing ${k}`).toContain(k);
    }
  });

  it("contract permissions trigger the right rules", () => {
    const res = evaluateAll(makeEvidence({ mint: { mintAuthority: true } }), loadRules(""));
    for (const id of ["R003", "R062", "R065"]) expect(status(res, id), id).toBe("TRIGGERED");
    const hook = evaluateAll(makeEvidence({ mint: { ext: [{ type: EXT.TransferHook, data: Buffer.alloc(64, 1) }] } }), loadRules(""));
    for (const id of ["R001", "R005", "R009", "R010", "R015", "R070"]) expect(status(hook, id), id).toBe("TRIGGERED");
    const r015 = hook.find((r) => r.rule.rule_id === "R015")!;
    expect((r015.evidence as any).simulation_result.blocked).toBe(true);
  });

  it("missing evidence yields MISSING, venue filtering yields NOT_APPLICABLE", () => {
    const res = evaluateAll(makeEvidence({ noContract: true }), loadRules(""));
    expect(status(res, "R003")).toBe("MISSING"); expect(status(res, "R015")).toBe("MISSING");
    expect(status(res, "R023")).toBe("NOT_APPLICABLE");      // LP lock: other AMMs only
    expect(status(res, "R087")).toBe("NOT_APPLICABLE");      // signing guard
  });

  it("wallet-graph rules: creator-linked buyers, shared funders, launch-block snipers", () => {
    const res = evaluateAll(makeEvidence({ buyers: [{ sol: 2.5, trace: { funder: "DEPLOYER" } }, { sol: 0.3 }, { sol: 0.3 }, { sol: 0.3 }] }), loadRules(""));
    expect(status(res, "R037")).toBe("TRIGGERED");
    const cl = evaluateAll(makeEvidence({ buyers: [{ sol: 2, trace: { funder: "GANG" } }, { sol: 2, trace: { funder: "GANG" } }, { sol: 2, trace: { funder: "GANG" } }, { sol: 0.3 }] }), loadRules(""));
    expect(status(cl, "R041")).toBe("TRIGGERED");
    const ex = evaluateAll(makeEvidence({ buyers: [0, 1, 2, 3].map(() => ({ sol: 1, trace: { funder: "EXCHANGE", funderIsService: true } })) }), loadRules(""));
    expect(status(ex, "R041")).toBe("PASS");                 // exchange-funded wallets are not a cluster
    const sn = evaluateAll(makeEvidence({ buyers: [0, 1, 2, 3].map(() => ({ sol: 2, atMs: 100 })) }), loadRules(""));
    expect(status(sn, "R043")).toBe("TRIGGERED");
  });

  it("overrides change params, actions and enabled flags without code edits", () => {
    const f = path.join(os.tmpdir(), `ov-${Date.now()}.json`);
    fs.writeFileSync(f, JSON.stringify({ R051: { params: { max_pct: 99 } }, R034: { on_trigger: "WARN" }, R105: { enabled: false } }));
    const rules = loadRules(f);
    expect(rules.find((r) => r.rule_id === "R051")!.params!.max_pct).toBe(99);
    expect(rules.find((r) => r.rule_id === "R034")!.on_trigger).toBe("WARN");
    expect(rules.find((r) => r.rule_id === "R105")!.enabled).toBe(false);
    fs.unlinkSync(f);
  });
});
