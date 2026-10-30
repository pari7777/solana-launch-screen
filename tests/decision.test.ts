import { describe, expect, it } from "vitest";
import { config } from "../src/config";
import { decide } from "../src/engine/decision";
import { evaluateAll, loadRules } from "../src/rules/registry";
import { PositionManager, type Position } from "../src/trade/positions";
import { makeEvidence, type Scenario } from "./fixtures/evidence";

const run = (s: Scenario = {}) => { const ev = makeEvidence(s); return decide(ev, evaluateAll(ev, loadRules("")), (d) => d === "SELECT_FOR_REVIEW"); };

const SPEC_KEYS = ["chain", "token_address", "launch_timestamp", "decision_deadline_seconds", "decision", "risk_score", "confidence",
  "data_completeness", "top_selection_reasons", "top_rejection_reasons", "launch_wallet", "market", "risk_rules_checked",
  "risk_rules_triggered", "missing_data", "auto_buy_allowed"];

describe("decision engine", () => {
  it("selects a clean launch and emits exactly the specified JSON shape", () => {
    const r = run();
    expect(r.decision).toBe("SELECT_FOR_REVIEW");
    expect(Object.keys(r.output)).toEqual(SPEC_KEYS);
    expect(Object.keys(r.output.launch_wallet)).toEqual(["deployer", "funding_source", "initial_liquidity_provider", "creator_token_share_pct",
      "linked_wallet_clusters", "previous_launches", "privileged_authorities"]);
    expect(Object.keys(r.output.market)).toEqual(["liquidity_usd", "buy_price_impact_pct", "sell_price_impact_pct", "estimated_round_trip_cost_pct", "sell_simulation"]);
    expect(r.output.chain).toBe("SOLANA");
    expect(r.output.risk_score).toBeGreaterThanOrEqual(config.selectScore);
    expect(r.output.market.sell_simulation).toBe("MODELED_PASS");
    expect(r.output.auto_buy_allowed).toBe(true);
    expect(r.output.top_selection_reasons.length).toBeGreaterThan(3);
    expect(r.output.market.liquidity_usd).toBeGreaterThan(0);
  });

  it("a hard gate overrides a perfect score", () => {
    const r = run({ mint: { mintAuthority: true } });
    expect(r.decision).toBe("REJECT"); expect(r.gated).toBe(true); expect(r.output.confidence).toBe("HIGH");
    expect(r.output.top_rejection_reasons[0].severity).toBe("CRITICAL");
    expect(r.output.risk_rules_triggered).toContain("R003");
    expect(r.output.launch_wallet.privileged_authorities).toContain("mint_authority");
    expect(r.output.auto_buy_allowed).toBe(false);
  });

  it("missing critical evidence → WAIT with null risk_score and listed missing data", () => {
    const r = run({ noContract: true, noDeployerTrace: true });
    expect(r.decision).toBe("WAIT");
    expect(r.output.risk_score).toBeNull();
    expect(r.output.missing_data).toContain("Token and bonding-curve accounts");
    expect(r.output.missing_data).toContain("Deployer wallet history");
    expect(r.output.market.sell_simulation).toBe("NOT_VERIFIED");
    expect(r.output.data_completeness).toBeLessThan(0.85);
    expect(["LOW", "MEDIUM"]).toContain(r.output.confidence);
  });

  it("still WAIT at the final re-check → REJECT", () => {
    const r = run({ noContract: true, final: true, stage: 3 });
    expect(r.decision).toBe("REJECT");
    expect(r.output.top_rejection_reasons[0].rule_id).toBe("S000");
  });

  it("too few independent buyers → MONITOR", () => {
    expect(run({ buyers: [{ sol: 0.3 }] }).decision).toBe("MONITOR");
  });

  it("known rugger, rug-funded deployer and serial launcher are rejected", () => {
    expect(run({ history: { rugger: "dumped 88% of own coin" } }).output.risk_rules_triggered).toContain("R026");
    expect(run({ history: { funderFlag: "funded a rugger" } }).output.risk_rules_triggered).toEqual(expect.arrayContaining(["R028", "R031"]));
    expect(run({ history: { prior: [{ mint: "M", decision: "REJECT" }] } }).decision).toBe("REJECT");
  });
});

// ─────────── trailing drawdown on net liquidation value ───────────
function manager() {
  const saved: any[] = [];
  const store: any = { savePosition: async (p: any) => { saved.push({ ...p }); }, put: async () => {}, get: async (_: string, d: any) => d,
                       pnlSummary: async () => ({ today: 0 }), openPositions: async () => [] };
  const pm = new PositionManager(store, {} as any, null, null);
  return { pm, saved };
}
const pos = (over: Partial<Position> = {}): Position => ({ mint: "M", symbol: "T", mode: "paper", wallet: null, status: "PENDING", venue: "pump_bonding_curve",
  tokens: 1_500_000, costSol: 0.05, netLiquidationValue: 0, highWaterValue: 0, vs: 32, vt: 1_000_000_000, openedAt: Date.now(), score: 90,
  meta: { deployer: "D", linked: [], whale: null, whaleBag: 0, whaleSold: 0 }, ...over });

describe("trailing drawdown (35% below the NLV high-water mark)", () => {
  it("confirming a position sets the high-water mark to its net liquidation value and opens it", () => {
    const { pm, saved } = manager(); const p = pos(); pm.positions.set(p.mint, p);
    pm.onPositionConfirmed(p);
    expect(p.status).toBe("OPEN"); expect(p.highWaterValue).toBe(p.netLiquidationValue); expect(p.highWaterValue).toBeGreaterThan(0);
    expect(saved.at(-1).status).toBe("OPEN");
  });

  it("raises the high-water mark, saves every update, and exits at exactly 35% below it", async () => {
    const { pm, saved } = manager(); const p = pos(); pm.positions.set(p.mint, p); pm.onPositionConfirmed(p);
    pm.onMarketUpdate(p, 0.10); expect(p.highWaterValue).toBe(0.10);
    pm.onMarketUpdate(p, 0.08); expect(p.highWaterValue).toBe(0.10); expect(p.status).toBe("OPEN");
    pm.onMarketUpdate(p, 0.0651); expect(p.status).toBe("OPEN");            // 34.9% below the high
    const n = saved.length;
    pm.onMarketUpdate(p, 0.065);                                             // exactly 35% below → exit
    expect(saved.length).toBeGreaterThan(n);
    expect(saved.some((s) => s.status === "EXIT_PENDING")).toBe(true);
    await new Promise((r) => setTimeout(r, 10));
    expect(pm.positions.has("M")).toBe(false);                               // paper exit filled and closed
    expect(saved.at(-1).status).toBe("CLOSED");
    expect(saved.at(-1).exitReason).toMatch(/trailing drawdown 35%/);
  });

  it("ignores market updates unless the position is OPEN", () => {
    const { pm } = manager(); const p = pos({ status: "EXIT_PENDING", highWaterValue: 0.1 });
    pm.onMarketUpdate(p, 0.5); expect(p.highWaterValue).toBe(0.1);
  });

  it("deployer selling triggers an immediate full exit", async () => {
    const { pm, saved } = manager(); const p = pos(); pm.positions.set(p.mint, p); pm.onPositionConfirmed(p);
    pm.onTrade({ signature: "s", eventIndex: 0, slot: 1, mint: "M", wallet: "D", side: "sell", sol: 0.1, tokens: 1e6, vsol: 31.9, vtok: 1_001_000_000, receivedAt: Date.now(), source: "replay" });
    await new Promise((r) => setTimeout(r, 10));
    expect(saved.at(-1).status).toBe("CLOSED"); expect(saved.at(-1).exitReason).toBe("deployer sold");
  });
});
