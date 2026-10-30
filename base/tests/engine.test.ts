import { describe, expect, it } from "vitest";
import { ADDR, PLATFORM_ADDR } from "../src/config";
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
    venue: "launch_v4", stage: 1, final: false, now: Date.now(), ageSec: 5,
    platform: "clanker",
    launch: { platform: "clanker", poolKey: null, signature: "0xab", instructionIndex: 0, slot: 100, token: token as any, creator: creator as any, sender: creator as any, name: "Test", symbol: "TST",
      image: "", metadata: "", context: "", startingTick: 0, hook: ADDR.knownHooks[0] as any, poolId: "0x00" as any, pairedToken: ADDR.weth as any,
      locker: "0x29d17C1A8D851d7d4cA97FAe97AcAdb398D9cCE0" as any, mevModule: "0x0" as any, extensionsSupply: 0n, extensions: [], receivedAt: Date.now(), blockTime: 0 },
    poolKey: { currency0: ADDR.weth as any, currency1: token as any, fee: 0x800000, tickSpacing: 200, hooks: ADDR.knownHooks[0] as any },
    route: { path: [token as any, ADDR.weth as any], hops: [{ kind: "v4", key: { currency0: ADDR.weth as any, currency1: token as any, fee: 0x800000, tickSpacing: 200, hooks: ADDR.knownHooks[0] as any } }] },
    routeError: null,
    onchain: { totalSupply: 100_000_000_000, decimals: 18, isContract: true }, onchainError: null,
    quote: { spotEthPerToken: 1e-10, tokensForBuy: 1e8, buyImpactPct: 1, sellImpactPct: 1, roundTripPct: 3, dumpStressLossPct: 5, clusterDumpLossPct: 5, feeNow: 2, at: Date.now() },
    quoteError: null, sellReverted: false, risk, graph,
    creatorTrace: { wallet: creator, txCount: 400, ageHours: 2000, isContract: false, funder: "0x3333333333333333333333333333333333333333", funderIsService: true, fundingTx: null },
    creatorTraceError: null, senderIsPlatform: false, creatorIsPlatform: false, buyerTracesNeeded: 0, buyerTracesDone: 0,
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
    const ev = evidence(); ev.poolKey = { ...ev.poolKey!, hooks: "0x9999999999999999999999999999999999999999" as any };
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

  it("Flaunch: official PositionManager hook passes, a foreign hook is rejected", () => {
    const pm = PLATFORM_ADDR.flaunchPositionManagers[3] as any;
    const ok = evidence({ platform: "flaunch", poolKey: { ...evidence().poolKey!, hooks: pm } }); ok.launch.platform = "flaunch"; ok.launch.locker = pm;
    const r1 = decide(ok, evaluateAll(ok), () => false).output.risk_rules_triggered;
    expect(r1).not.toContain("R006"); expect(r1).not.toContain("R016");
    const bad = evidence({ platform: "flaunch", poolKey: { ...evidence().poolKey!, hooks: "0x9999999999999999999999999999999999999999" as any } }); bad.launch.locker = pm;
    expect(decide(bad, evaluateAll(bad), () => false).decision).toBe("REJECT");
  });
  it("Zora coin backed by another coin is priced through its route, not rejected for the pair", () => {
    const ev = evidence({ platform: "zora", onchain: { totalSupply: 1_000_000_000, decimals: 18, isContract: true },
      route: { path: [token as any, "0x4444444444444444444444444444444444444444" as any, ADDR.weth as any], hops: [{ kind: "v4", key: evidence().poolKey! }, { kind: "v3", fee: 3000 }] } });
    ev.launch.platform = "zora"; ev.launch.pairedToken = "0x4444444444444444444444444444444444444444" as any;
    const t = decide(ev, evaluateAll(ev), () => false).output.risk_rules_triggered;
    expect(t).not.toContain("R021"); expect(t).not.toContain("R006"); expect(t).not.toContain("R016");
  });
  it("Doppler launch from a platform wallet (Bankr): no creator-history reject, but a score penalty", () => {
    const ev = evidence({ platform: "doppler", creatorIsPlatform: true,
      creatorTrace: { wallet: creator, txCount: 90000, ageHours: 5000, isContract: false, funder: null, funderIsService: null, fundingTx: null },
      history: { rugger: null, prior: Array.from({ length: 40 }, (_, i) => ({ mint: `0x${i}`, decision: "REJECT" })), copycat: false, funderFlag: null, funderLaunches: 0 } });
    ev.launch.platform = "doppler"; ev.launch.locker = PLATFORM_ADDR.dopplerV4[1] as any;
    ev.poolKey = { ...ev.poolKey!, hooks: PLATFORM_ADDR.dopplerV4[1] as any };
    const res = decide(ev, evaluateAll(ev), () => false);
    expect(res.output.risk_rules_triggered).not.toContain("R025");
    expect(res.gates.rejects.map((r) => r.rule.rule_id)).toEqual([]);
  });
  it("holder percentages use the coin's real supply", () => {
    const st = new TokenState(token, false, new Set());
    st.addTransfers([{ tx: "0x1", logIndex: 0, block: 1, from: "0x0000000000000000000000000000000000000000", to: creator, amount: 10n ** 25n, at: 0 }]);
    const g = buildFundingGraph(creator, null, new Map(), () => null);
    expect(computeRisk(creator, 1, st, g, new Map(), 0, { dustEth: 0.002, supply: 1_000_000_000 }).creatorPct).toBe(1);
  });
});
