/**
 * Replays launches through the real pipeline: stream events → screener (stage 1 + stage 2) → 120 rules → decision →
 * Postgres (embedded) → paper positions with the trailing-drawdown exit. Only the Solana RPC is simulated.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { config } from "../src/config";
import { openDb, type Sql } from "../src/data/db";
import { MarketData } from "../src/data/quotes";
import { Rpc } from "../src/data/rpc";
import { Store } from "../src/data/store";
import { WalletTracer } from "../src/data/wallet-history";
import { bondingCurvePda } from "../src/decoders/bonding-curve";
import { Screener, type Record_ } from "../src/engine/screener";
import { PositionManager } from "../src/trade/positions";
import type { TradeEvent } from "../src/types";
import { addr, Curve, FakeChain, mintAccount } from "./fixtures/builders";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let sql: Sql, store: Store, chain: FakeChain, screener: Screener, positions: PositionManager;
const records: Record_[] = [];
const final = (mint: string) => records.filter((r) => r.output.token_address === mint).at(-1)!;

function launch(symbol: string, deployer: string, mintOpts: Parameters<typeof mintAccount>[0] = {}, devSol = 0.3) {
  const mint = addr(), c = new Curve();
  chain.mints.set(mint, mintAccount(mintOpts)); chain.curves.set(mint, c);
  screener.onLaunch({ signature: `${mint}-sig`, instructionIndex: 0, slot: 0, mint, deployer, creator: deployer, bondingCurve: bondingCurvePda(mint),
    name: `${symbol} coin`, symbol, uri: "", vsol: 30, vtok: 1_073_000_000, receivedAt: Date.now(), source: "replay" });
  trade(mint, deployer, "buy", devSol);
  return mint;
}
function trade(mint: string, wallet: string, side: "buy" | "sell", amount: number) {
  const c = chain.curves.get(mint)!;
  const tokens = side === "buy" ? c.buy(amount) : amount; let sol = amount;
  if (side === "sell") sol = c.sell(amount);
  const t: TradeEvent = { signature: addr(), eventIndex: 0, slot: 1, mint, wallet, side, sol, tokens, vsol: c.vs, vtok: c.vt, receivedAt: Date.now(), source: "replay" };
  screener.onTrade(t); positions.onTrade(t);
  return tokens;
}

beforeAll(async () => {
  Object.assign(config, { observeSeconds: 0.35, decisionSeconds: 0.9, recheckAt: [1.3, 1.9], stage2BudgetSeconds: 0.3, maxOpen: 10,
                          maxBuysPerHour: 50, checkPumpfunApi: false, rulesOverridePath: "" });
  sql = await openDb({ dir: null }); store = new Store(sql); await store.init();
  chain = new FakeChain();
  const rpc = new Rpc(chain.transport, 16);
  const tracer = new WalletTracer(rpc); tracer.onTrace = (t) => { store.addFundingEdge(t); };
  positions = new PositionManager(store, rpc, null, null); await positions.load();
  screener = new Screener(rpc, store, tracer, new MarketData(rpc), {
    canAutoBuy: () => positions.canAutoBuy(), onSelected: (s) => positions.onSelected(s), onRecord: (r) => records.push(r),
    watchMint: () => {}, unwatchMint: () => {}, watchWallet: () => {}, streamOk: () => true,
  });
}, 30_000);
afterAll(async () => { await sql?.close(); });

describe("replay through the full pipeline", () => {
  it("screens a batch of launches into the right decisions and persists everything", async () => {
    const exch = chain.wallet(addr(), { n: 1000, ageH: 0.1, service: true });
    const rugFunder = chain.wallet(addr(), { n: 40, ageH: 500 });
    const gang = chain.wallet(addr(), { n: 30, ageH: 500 });

    const clean = launch("LOTUS", addr());
    const minty = launch("PRINT", addr(), { mintAuthority: true });
    const rugger = chain.wallet(addr(), { n: 200, ageH: 800, funder: rugFunder });
    const rug1 = launch("PUMPA", rugger, {}, 1.0);
    const cluster = launch("GANG", addr());
    const exFunded = launch("CEXFUN", chain.wallet(addr(), { n: 200, ageH: 800, funder: exch }));
    const patient = launch("PATIENT", addr());
    await sleep(120);
    for (let i = 0; i < 5; i++) { trade(clean, addr(), "buy", 0.3); }
    for (let i = 0; i < 5; i++) trade(minty, addr(), "buy", 0.3);
    for (let i = 0; i < 3; i++) trade(cluster, chain.wallet(addr(), { n: 3, ageH: 0.2, funder: gang }), "buy", 1.6);
    for (let i = 0; i < 3; i++) trade(cluster, addr(), "buy", 0.3);
    for (let i = 0; i < 5; i++) trade(exFunded, chain.wallet(addr(), { n: 200, ageH: 800, funder: exch }), "buy", 0.3);
    trade(patient, addr(), "buy", 0.3);
    await sleep(1000);                                                          // stage 1 done for all
    trade(rug1, rugger, "sell", 30_000_000);                                    // rugger dumps ~85% of its bag
    for (let i = 0; i < 5; i++) trade(patient, addr(), "buy", 0.3);              // patient coin gets real buyers
    await sleep(100);
    const rug2 = launch("PUMPB", chain.wallet(addr(), { n: 200, ageH: 800, funder: rugFunder }));
    for (let i = 0; i < 5; i++) trade(rug2, addr(), "buy", 0.3);
    await sleep(2400);                                                          // stage-2 re-checks finish

    expect(final(clean).output.decision).toBe("SELECT_FOR_REVIEW");
    expect(final(clean).meta.action).toMatch(/bought/);
    expect(final(minty).output.decision).toBe("REJECT");
    expect(final(minty).output.risk_rules_triggered).toContain("R003");
    expect(final(cluster).output.decision).toBe("REJECT");
    expect(final(cluster).output.risk_rules_triggered).toContain("R041");
    expect(final(exFunded).output.decision).toBe("SELECT_FOR_REVIEW");          // exchange funding is not a cluster
    const pat = records.filter((r) => r.output.token_address === patient);
    expect(pat[0].output.decision).toBe("MONITOR");
    expect(pat.at(-1)!.output.decision).toBe("SELECT_FOR_REVIEW");
    expect(pat.at(-1)!.meta.stage).toBeGreaterThan(1);
    expect(store.flagsOf(rugger)?.has("RUGGER")).toBe(true);
    expect(store.flagsOf(rugFunder)?.has("RUG_FUNDER")).toBe(true);
    expect(final(rug2).output.decision).toBe("REJECT");
    expect(final(rug2).output.risk_rules_triggered).toEqual(expect.arrayContaining(["R028", "R031"]));

    const launches = await sql.query("SELECT mint, decision, slot FROM launches");
    expect(launches.length).toBe(7);
    expect(launches.find((l: any) => l.mint === minty).decision).toBe("REJECT");
    expect(Number(launches[0].slot)).toBe(4242);                               // slot filled from getSignatureStatuses
    const rr = await sql.query("SELECT r.status FROM rule_results r JOIN launches l USING (chain, signature, instruction_index) WHERE l.mint=$1 AND r.rule_id='R003'", [minty]);
    expect(rr[0].status).toBe("TRIGGERED");
    expect((await sql.query("SELECT COUNT(*)::int AS n FROM decision_history"))[0].n).toBeGreaterThanOrEqual(8);   // 7 launches + a stage-2 record
    expect((await sql.query("SELECT COUNT(*)::int AS n FROM wallet_edges WHERE edge_type='FUNDING'"))[0].n).toBeGreaterThan(5);
    const stored = await store.latestOutput(clean);
    expect(stored.decision).toBe("SELECT_FOR_REVIEW");
    expect(Object.keys(stored)).toEqual(Object.keys(final(clean).output));     // key order survives the database

    // trailing drawdown on the bought clean coin: pump, then a dump > 35% from the high
    const pos = positions.positions.get(clean)!;
    expect(pos.status).toBe("OPEN");
    for (let i = 0; i < 6; i++) trade(clean, addr(), "buy", 2);
    const hwm = pos.highWaterValue;
    expect(hwm).toBeGreaterThan(pos.costSol);
    trade(clean, addr(), "sell", 200_000_000);
    await sleep(50);
    expect(positions.positions.has(clean)).toBe(false);
    const closed = (await store.closedPositions()).find((p: any) => p.mint === clean);
    expect(closed.exit_reason).toMatch(/trailing drawdown 35%/);
    expect(Number(closed.high_water_value)).toBeCloseTo(hwm, 6);
  }, 20_000);
});
