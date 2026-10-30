/** The six-second rule is a deadline: slow data must turn into WAIT on time, never into a late decision. */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { config } from "../src/config";
import { openDb, type Sql } from "../src/data/db";
import { MarketData } from "../src/data/quotes";
import { Rpc } from "../src/data/rpc";
import { Store } from "../src/data/store";
import { WalletTracer } from "../src/data/wallet-history";
import { bondingCurvePda } from "../src/decoders/bonding-curve";
import { Screener, type Record_ } from "../src/engine/screener";
import { addr, Curve, FakeChain, mintAccount } from "./fixtures/builders";

let sql: Sql, store: Store;
beforeAll(async () => {
  Object.assign(config, { observeSeconds: 0.3, decisionSeconds: 1, recheckAt: [3, 4], checkPumpfunApi: false, rulesOverridePath: "" });
  sql = await openDb({ dir: null }); store = new Store(sql); await store.init();
}, 30_000);
afterAll(async () => { await sql?.close(); });

function rig(delayMs: number) {
  const chain = new FakeChain(); chain.delayMs = delayMs;
  const rpc = new Rpc(chain.transport, 32);
  const recs: Record_[] = [];
  const s = new Screener(rpc, store, new WalletTracer(rpc), new MarketData(rpc), {
    canAutoBuy: () => "test", onSelected: async () => "n/a", onRecord: (r) => recs.push(r),
    watchMint: () => {}, unwatchMint: () => {}, watchWallet: () => {}, streamOk: () => true });
  const launch = () => {
    const mint = addr(), c = new Curve(); chain.mints.set(mint, mintAccount()); chain.curves.set(mint, c);
    s.onLaunch({ signature: `${mint}-s`, instructionIndex: 0, slot: 1, mint, deployer: addr(), creator: "", bondingCurve: bondingCurvePda(mint),
      name: mint.slice(0, 6), symbol: mint.slice(0, 5), uri: "", vsol: 30, vtok: 1.073e9, receivedAt: Date.now(), source: "replay" });
    return mint;
  };
  return { launch, recs };
}
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("decision deadline", () => {
  it("a slow RPC (3 s per call) still yields a WAIT inside the deadline", async () => {
    const { launch, recs } = rig(3000);
    const t0 = Date.now(); const mint = launch();
    await wait(1300);
    const r = recs.find((x) => x.output.token_address === mint)!;
    expect(r).toBeDefined();
    expect(r.meta.elapsed_ms).toBeLessThanOrEqual(config.decisionSeconds * 1000 + 100);
    expect(r.output.decision).toBe("WAIT");
    expect(r.output.missing_data).toContain("Token and bonding-curve accounts");
    expect(Date.now() - t0).toBeGreaterThan(900);
  }, 15_000);

  it("a fast RPC decides right after the observation window", async () => {
    const { launch, recs } = rig(20);
    const mint = launch(); await wait(800);
    const r = recs.find((x) => x.output.token_address === mint)!;
    expect(r.meta.elapsed_ms).toBeLessThan(config.observeSeconds * 1000 + 250);
    expect(r.output.missing_data).not.toContain("Token and bonding-curve accounts");
  }, 15_000);

  it("25 simultaneous launches all decide within the deadline", async () => {
    const { launch, recs } = rig(60);
    const mints = Array.from({ length: 25 }, launch);
    await wait(1400);
    const done = mints.map((m) => recs.find((x) => x.output.token_address === m));
    expect(done.every(Boolean)).toBe(true);
    const worst = Math.max(...done.map((r) => r!.meta.elapsed_ms));
    expect(worst).toBeLessThanOrEqual(config.decisionSeconds * 1000 + 150);
  }, 15_000);
});
