/**
 * Executes swaps.
 *   keypair  – builds the tx, runs the signing guard, signs with the local bot wallet, sends, confirms
 *   browser  – builds the tx and runs the guard; your wallet extension (Phantom / Solflare / Backpack) signs it
 * Fills are measured from the confirmed transaction's balance changes, not estimated.
 */
import type { Keypair } from "@solana/web3.js";
import type { Rpc } from "../data/rpc";
import { validateTx } from "./guard";
import { buildSwapTx } from "./pumpportal";

export interface Fill { signature: string; solDelta: number; tokenDelta: number }

export class Executor {
  constructor(private rpc: Rpc, private keypair: Keypair | null) {}

  /** Unsigned, guard-checked transaction for a browser wallet (base64). */
  async prepare(owner: string, side: "buy" | "sell", mint: string, amount: number | string, refSol: number) {
    const raw = await buildSwapTx(owner, side, mint, amount, side === "buy");
    const g = validateTx(raw, owner, refSol);
    if (!g.ok) throw new Error(`[${g.rule}] signing guard refused: ${g.reason}`);
    return Buffer.from(raw).toString("base64");
  }

  /** Keypair mode: build → guard → sign → send → confirm → measure. */
  async swap(side: "buy" | "sell", mint: string, amount: number | string, refSol: number): Promise<Fill> {
    if (!this.keypair) throw new Error("no bot wallet loaded");
    const owner = this.keypair.publicKey.toBase58();
    const raw = await buildSwapTx(owner, side, mint, amount, side === "buy");
    const g = validateTx(raw, owner, refSol);
    if (!g.ok || !g.tx) throw new Error(`[${g.rule}] signing guard refused: ${g.reason}`);
    g.tx.sign([this.keypair]);
    const sig = await this.rpc.call<string>("sendTransaction", [Buffer.from(g.tx.serialize()).toString("base64"),
      { encoding: "base64", skipPreflight: true, maxRetries: 3 }], 8000);
    await this.confirm(sig);
    return this.measure(sig, owner, mint);
  }

  async confirm(sig: string, timeoutMs = 45_000) {
    const end = Date.now() + timeoutMs;
    while (Date.now() < end) {
      await new Promise((r) => setTimeout(r, 1000));
      const st = (await this.rpc.call<any>("getSignatureStatuses", [[sig], { searchTransactionHistory: true }])).value?.[0];
      if (st?.err) throw new Error(`transaction failed: ${JSON.stringify(st.err)}`);
      if (st?.confirmationStatus === "confirmed" || st?.confirmationStatus === "finalized") return;
    }
    throw new Error(`not confirmed within ${timeoutMs / 1000}s`);
  }

  /** SOL and token balance change of `owner` in a confirmed transaction. */
  async measure(sig: string, owner: string, mint: string): Promise<Fill> {
    let tx: any = null;
    for (let i = 0; i < 10 && !tx; i++) {
      tx = await this.rpc.call<any>("getTransaction", [sig, { encoding: "jsonParsed", maxSupportedTransactionVersion: 0, commitment: "confirmed" }]);
      if (!tx) await new Promise((r) => setTimeout(r, 800));
    }
    if (!tx) throw new Error("confirmed transaction not retrievable");
    const keys: string[] = tx.transaction.message.accountKeys.map((k: any) => (typeof k === "string" ? k : k.pubkey));
    const i = keys.indexOf(owner);
    const solDelta = i >= 0 ? (tx.meta.postBalances[i] - tx.meta.preBalances[i]) / 1e9 : 0;
    const tok = (arr: any[]) => (arr ?? []).filter((b) => b.owner === owner && b.mint === mint)
                                          .reduce((a, b) => a + Number(b.uiTokenAmount.uiAmount ?? 0), 0);
    return { signature: sig, solDelta, tokenDelta: tok(tx.meta.postTokenBalances) - tok(tx.meta.preTokenBalances) };
  }
}
