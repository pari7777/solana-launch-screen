import { describe, expect, it } from "vitest";
import { ADDR } from "../src/config";
import { decide } from "../src/engine/decision";
import { TokenState } from "../src/graph/token-state";
import { buildFundingGraph, computeRisk } from "../src/graph/risk";
import { evaluateAll, loadRules, type Evidence } from "../src/rules/registry";

const creator = "0x1111111111111111111111111111111111111111";
const token = "0x2222222222222222222222222222222222222222";
function evidence(over: Partial<Evidence> = {}): Evidence {
  const st = new TokenState(token, false, new Set());
  const graph = buildFundingGraph(creator, null, new Map(), () => null);
  const risk = computeRisk(creator, 100, st, graph, new Map(), 0, { dustEth: 0.002 });
  return {
    venue: "clanker_v4", stage: 1, final: false, now: Date.now(), ageSec: 5,
    launch: { signature: "0xab", instructionIndex: 0, slot: 100, token: token as any, creator: creator as any, sender: creator as any, name: "Test", symbol: "TST",
      image: "", metadata: "", context: "", startingTick: 0, hook: ADDR.knownHooks[0] as any, poolId: "0x00" as any, pairedToken: ADDR.weth as any,
      locker: "0x29d17C1A8D851d7d4cA97FAe97AcAdb398D9cCE0" as any, mevModule: "0x0" as any, extensionsSupply: 0n, extensions: [], receivedAt: Date.now(), blockTime: 0 },
    poolKey: { currency0: ADDR.weth as any, currency1: token as any, fee: 0x800000, tickSpacing: 200, hooks: ADDR.knownHooks[0] as any },
    onchain: { totalSupply: 100_000_000_000, decimals: 18, isContract: true }, onchainError: null,
    quote: { spotEthPerToken: 1e-10, tokensForBuy: 1e8, buyImpactPct: 1, sellImpactPct: 1, roundTripPct: 3, dumpStressLossPct: 5, clusterDumpLossPct: 5, feeNow: 2, at: Date.now() },
    quoteError: null, sellReverted: false, risk, graph,
    creatorTrace: { wallet: creator, txCount: 400, ageHours: 2000, isContract: false, funder: "0x3333333333333333333333333333333333333333", funderIsService: true, fundingTx: null },
    creatorTraceError: null, senderIsPlatform: false, buyerTracesNeeded: 0, buyerTracesDone: 0,
    history: { rugger: null, prior: [], copycat: false, funderFlag: null, funderLaunches: 0 }, poolEth: 0.5,
    market: { ethUsd: 3000, streamOk: true, headLagBlocks: 1 }, ...over,
  };
}

describe("Base rules", () => {
  it("loads 120 spec rules + Base and custom rules, each with an evaluator", () => {
    const r = loadRules();
    expect(r.filter((x) => /^R\d{3}$/.test(x.rule_id))).toHaveLength(120);
    expect(r.some((x) => x.rule_id === "B001")).toBe(true);
  });
  it("a clean launch passes every hard gate; too few buyers keeps it on MONITOR", () => {
    const ev = evidence(); const res = decide(ev, evaluateAll(ev), () => false);
    expect(res.gates.rejects.map((r) => r.rule.rule_id)).toEqual([]);
    expect(res.output.chain).toBe("BASE");
    expect(["MONITOR", "WAIT"]).toContain(res.decision);
  });
  it("an unknown hook is rejected", () => {
    const ev = evidence(); ev.launch.hook = "0x9999999999999999999999999999999999999999" as any;
    expect(decide(ev, evaluateAll(ev), () => false).output.risk_rules_triggered).toContain("R006");
  });
  it("sniper-fee window waits instead of rejecting on round-trip cost", () => {
    const ev = evidence({ quote: { ...evidence().quote!, roundTripPct: 60, feeNow: 50 } });
    const res = decide(ev, evaluateAll(ev), () => false);
    expect(res.decision).toBe("WAIT");
    expect(res.output.risk_rules_triggered).toContain("B001");
    expect(res.output.risk_rules_triggered).not.toContain("R022");
  });
  it("a known rugger creator is rejected", () => {
    const ev = evidence({ history: { rugger: "dumped 95% of own coin", prior: [], copycat: false, funderFlag: null, funderLaunches: 0 } });
    expect(decide(ev, evaluateAll(ev), () => false).decision).toBe("REJECT");
  });
});
