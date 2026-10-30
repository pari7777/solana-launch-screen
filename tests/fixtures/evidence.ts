/** Builds a complete Evidence object for a launch, so rules and decisions can be tested without a network. */
import { activeExtensions, decodeMint } from "../../src/data/accounts";
import { bondingCurvePda, decodeCurve, quote } from "../../src/decoders/bonding-curve";
import { PUMP_PROGRAM } from "../../src/decoders/pump-launch";
import { clusterRisk } from "../../src/graph/cluster-risk";
import { buildFundingGraph } from "../../src/graph/funding-graph";
import type { Evidence } from "../../src/rules/registry";
import type { ContractInfo, LaunchEvent, TradeEvent, WalletTrace } from "../../src/types";
import { addr, Curve, curveAccount, mintAccount } from "./builders";

export interface Scenario {
  mint?: Parameters<typeof mintAccount>[0];
  noContract?: boolean;
  noDeployerTrace?: boolean;
  deployerTrace?: Partial<WalletTrace>;
  devBuySol?: number;
  buyers?: { sol: number; trace?: Partial<WalletTrace>; atMs?: number; sellFrac?: number }[];
  deployerSells?: number;
  symbol?: string; name?: string;
  stage?: number; final?: boolean;
  history?: Partial<Evidence["history"]>;
  flagged?: Record<string, string>;
}

export function makeEvidence(s: Scenario = {}): Evidence {
  const mint = addr(), deployer = addr(), t0 = Date.now() - 3000;
  const launch: LaunchEvent = { signature: addr() + "sig", instructionIndex: 1, slot: 100, mint, deployer, creator: deployer,
    bondingCurve: bondingCurvePda(mint), name: s.name ?? "Lotus Leaf", symbol: s.symbol ?? "LOTUS", uri: "", receivedAt: t0, source: "replay" };
  const c = new Curve(); const trades: TradeEvent[] = [];
  const push = (wallet: string, side: "buy" | "sell", sol: number, tokens: number, at: number) =>
    trades.push({ signature: addr(), eventIndex: 0, slot: 101, mint, wallet, side, sol, tokens, vsol: c.vs, vtok: c.vt, receivedAt: t0 + at, source: "replay" });
  const devTok = c.buy(s.devBuySol ?? 0.3); push(deployer, "buy", s.devBuySol ?? 0.3, devTok, 50);
  const price0 = (30 + (s.devBuySol ?? 0.3) * 0.9875) / (c.vt);
  const traces = new Map<string, WalletTrace>();
  const buyers: NonNullable<Scenario["buyers"]> = s.buyers ?? Array.from({ length: 5 }, () => ({ sol: 0.3 }));
  buyers.forEach((b, i) => {
    const w = addr(); const tok = c.buy(b.sol); push(w, "buy", b.sol, tok, b.atMs ?? 900 + i * 150);
    if (i < 4) traces.set(w, { wallet: w, txCount: 150, ageHours: 900, old: false, funder: addr(), funderIsService: false,
                               fundingSignature: "x", fundingSlot: 1, fundingLamports: 1, ...b.trace });
    if (b.sellFrac) { const st = tok * b.sellFrac; c.sell(st); push(w, "sell", 0, st, 2000); }
  });
  if (s.deployerSells) { const st = devTok * s.deployerSells; c.sell(st); push(deployer, "sell", 0, st, 2500); }
  // resolve trace placeholders that reference the deployer
  for (const t of traces.values()) if (t.funder === "DEPLOYER") t.funder = deployer;
  const m = mintAccount(s.mint);
  const contract: ContractInfo | null = s.noContract ? null : {
    mint: decodeMint(m.data, m.owner), curve: decodeCurve(curveAccount(c.vs, c.vt), PUMP_PROGRAM), curveKey: launch.bondingCurve, fetchedAt: Date.now() };
  const deployerTrace: WalletTrace | null = s.noDeployerTrace ? null :
    { wallet: deployer, txCount: 320, ageHours: 2000, old: false, funder: addr(), funderIsService: false, fundingSignature: "f", fundingSlot: 1, fundingLamports: 1, ...s.deployerTrace };
  const flagged = s.flagged ?? {};
  const graph = buildFundingGraph(deployer, deployerTrace, traces, (w) => (w && flagged[w]) || null);
  const risk = clusterRisk(deployer, t0, price0, trades, graph, traces, { bundleMs: 600, dustSol: 0.01 });
  return {
    venue: "pump_bonding_curve", stage: s.stage ?? 1, final: s.final ?? false, now: Date.now(), launch, contract, contractError: s.noContract ? "timeout" : null,
    activeExtensions: contract ? activeExtensions(contract.mint) : null, reserves: { vsol: c.vs, vtok: c.vt, at: Date.now() - 200 },
    quote: quote(c.vs, c.vt, 0.05, 1.25, 0.0005, risk.topHolderTokens, risk.clusterTokens), feePct: 1.25, risk, graph,
    deployerTrace, deployerTraceError: s.noDeployerTrace ? "pending" : null, buyerTracesNeeded: Math.min(4, buyers.length), buyerTracesDone: traces.size,
    history: { rugger: null, prior: [], pumpfunChecked: true, pumpfunPast: { count: 0, graduated: 0 }, copycat: false, funderFlag: null, funderLaunches: 0, ...s.history },
    metadata: { checked: false, ok: null },
    market: { rpcLagSlots: 2, priorityFeeMicroLamports: 5000, solUsd: 150, streamOk: true },
  };
}
