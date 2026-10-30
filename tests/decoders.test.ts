import { describe, expect, it } from "vitest";
import { activeExtensions, decodeMint, EXT, TOKEN_2022 } from "../src/data/accounts";
import { findFunder } from "../src/data/wallet-history";
import { bondingCurvePda, decodeCurve, liquidationValue, quote } from "../src/decoders/bonding-curve";
import { decodePumpLogs, PUMP_PROGRAM } from "../src/decoders/pump-launch";
import { decodePool } from "../src/decoders/pumpswap";
import bs58 from "bs58";
import { addr, createEventData, curveAccount, mintAccount, programData, tradeEventData } from "./fixtures/builders";

describe("pump.fun log decoding", () => {
  it("decodes create + dev buy with slot, signature and top-level instruction index", () => {
    const mint = addr(), user = addr(), curve = bondingCurvePda(mint);
    const logs = [
      "Program ComputeBudget111111111111111111111111111111 invoke [1]", "Program ComputeBudget111111111111111111111111111111 success",
      `Program ${PUMP_PROGRAM} invoke [1]`, "Program log: Instruction: Create",
      "Program TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA invoke [2]", "Program TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA success",
      programData(createEventData({ name: "Lotus Leaf", symbol: "LOTUS", uri: "ipfs://x", mint, curve, user })),
      `Program ${PUMP_PROGRAM} success`,
      `Program ${PUMP_PROGRAM} invoke [1]`, "Program log: Instruction: Buy",
      programData(tradeEventData({ mint, sol: 0.5, tokens: 17_500_000, isBuy: true, user, vsol: 30.49, vtok: 1_055_500_000 })),
      `Program ${PUMP_PROGRAM} success`,
    ];
    const { creates, trades } = decodePumpLogs("SIG123", 777, logs);
    expect(creates).toHaveLength(1);
    expect(creates[0]).toMatchObject({ signature: "SIG123", slot: 777, instructionIndex: 1, mint, deployer: user, bondingCurve: curve,
                                       name: "Lotus Leaf", symbol: "LOTUS", uri: "ipfs://x" });
    expect(creates[0].vsol).toBeCloseTo(30); expect(creates[0].vtok).toBeCloseTo(1_073_000_000);
    expect(trades).toHaveLength(1);
    expect(trades[0]).toMatchObject({ mint, wallet: user, side: "buy", sol: 0.5, tokens: 17_500_000 });
    expect(trades[0].vsol).toBeCloseTo(30.49);
  });

  it("ignores foreign and truncated program data", () => {
    const r = decodePumpLogs("S", 1, ["Program data: AAAA", "Program data: " + Buffer.alloc(40, 3).toString("base64"), "Log truncated"]);
    expect(r.creates).toHaveLength(0); expect(r.trades).toHaveLength(0);
  });
});

describe("account decoding", () => {
  it("reads authorities and supply from an SPL mint", () => {
    const m = mintAccount({ mintAuthority: true, freezeAuthority: true });
    const d = decodeMint(m.data, m.owner);
    expect(d.mintAuthority).toBe(true); expect(d.freezeAuthority).toBe(true); expect(d.supplyRaw).toBe(10n ** 15n); expect(d.decimals).toBe(6);
    const clean = decodeMint(mintAccount().data, mintAccount().owner);
    expect(clean.mintAuthority).toBe(false); expect(clean.freezeAuthority).toBe(false);
  });

  it("decodes Token-2022 extensions and ignores unset ones", () => {
    const hook = Buffer.concat([Buffer.alloc(32, 1), Buffer.alloc(32, 2)]);
    const m = mintAccount({ ext: [{ type: EXT.MetadataPointer, data: Buffer.alloc(64) }, { type: EXT.TransferHook, data: hook },
                                  { type: EXT.PermanentDelegate, data: Buffer.alloc(32) }] });
    expect(m.owner).toBe(TOKEN_2022);
    const d = decodeMint(m.data, m.owner);
    expect(d.extensions.map((e) => e.type)).toEqual([18, 14, 12]);
    const active = activeExtensions(d).map((e) => e.name);
    expect(active).toContain("TransferHook"); expect(active).not.toContain("PermanentDelegate");
  });

  it("decodes the bonding curve and derives the same PDA as other tooling", () => {
    const c = decodeCurve(curveAccount(42, 800_000_000), PUMP_PROGRAM);
    expect(c.vsol).toBeCloseTo(42); expect(c.vtok).toBeCloseTo(800_000_000); expect(c.rsol).toBeCloseTo(12); expect(c.complete).toBe(false);
    // cross-checked against an independent Python (solders) derivation
    expect(bondingCurvePda("So11111111111111111111111111111111111111112")).toBe("6PiyjiAPkp2KdZtqkyQYzVsD1Prv7t8v4TaYd8ip4YFd");
  });

  it("decodes PumpSwap pool vault addresses at the packed offsets", () => {
    const base = addr(), quote_ = addr(), bv = addr(), qv = addr();
    const d = Buffer.alloc(260); d.set(bs58.decode(base), 43); d.set(bs58.decode(quote_), 75); d.set(bs58.decode(bv), 139); d.set(bs58.decode(qv), 171);
    expect(decodePool("P", d)).toMatchObject({ baseMint: base, quoteMint: quote_, baseVault: bv, quoteVault: qv });
  });

  it("finds the funder of a wallet from its first transaction", () => {
    const w = addr(), f = addr();
    expect(findFunder({ transaction: { message: { accountKeys: [{ pubkey: f }], instructions: [
      { program: "system", parsed: { type: "transfer", info: { source: f, destination: w, lamports: 5 } } }] } }, meta: {} }, w))
      .toEqual({ source: f, lamports: 5 });
  });
});

describe("curve math", () => {
  it("round-trip costs at least both fees, and liquidation value falls with size", () => {
    const q = quote(32, 1_000_000_000, 0.05, 1.25, 0.0005, 30_000_000, 60_000_000);
    expect(q.roundTripPct).toBeGreaterThan(2.5); expect(q.roundTripPct).toBeLessThan(6);
    expect(q.clusterDumpLossPct).toBeGreaterThan(q.dumpStressLossPct);
    const small = liquidationValue(32, 1e9, 1e6, 1.25, 0) / 1e6, big = liquidationValue(32, 1e9, 1e8, 1.25, 0) / 1e8;
    expect(big).toBeLessThan(small);
  });
});

describe("rpc failover", () => {
  it("rotates endpoints, rests one that rate-limits, and passes real errors through", async () => {
    const { multiTransport } = await import("../src/data/rpc");
    const http = await import("node:http");
    const hits = { a: 0, b: 0 };
    const srv = (name: "a" | "b", limited: boolean) => http.createServer((req, res) => {
      let body = ""; req.on("data", (c) => (body += c)); req.on("end", () => {
        hits[name]++;
        const m = JSON.parse(body).method;
        if (limited) { res.writeHead(429); return res.end("slow down"); }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(m === "bad" ? { jsonrpc: "2.0", id: 1, error: { message: "Invalid params" } } : { jsonrpc: "2.0", id: 1, result: name }));
      });
    });
    const A = srv("a", true).listen(0), B = srv("b", false).listen(0);
    await new Promise((r) => setTimeout(r, 50));
    const t = multiTransport([`http://127.0.0.1:${(A.address() as any).port}`, `http://127.0.0.1:${(B.address() as any).port}`]);
    const out = await Promise.all(Array.from({ length: 6 }, () => t("getSlot", [], 2000)));
    expect(out.every((x) => x === "b")).toBe(true);
    const firstWave = hits.a;                                 // parallel calls may all try A before it is rested
    for (let i = 0; i < 6; i++) expect(await t("getSlot", [], 2000)).toBe("b");
    expect(hits.a).toBe(firstWave);                           // once rested, A is not called again
    await expect(t("bad", [], 2000)).rejects.toThrow("Invalid params");
    expect(t.status()[0].restingFor).toBeGreaterThan(0);
    A.close(); B.close();
  });
});
