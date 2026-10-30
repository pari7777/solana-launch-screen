/** Builds unsigned pump.fun / PumpSwap swap transactions through PumpPortal's local-transaction API. */
import { config } from "../config";

export async function buildSwapTx(owner: string, action: "buy" | "sell", mint: string, amount: number | string, inSol: boolean) {
  const r = await fetch(config.tradeUrl, {
    method: "POST", headers: { "content-type": "application/json" }, signal: AbortSignal.timeout(8000),
    body: JSON.stringify({ publicKey: owner, action, mint, amount, denominatedInSol: inSol ? "true" : "false",
                           slippage: config.slippagePct, priorityFee: config.priorityFeeSol, pool: "auto" }),
  });
  if (r.status !== 200) throw new Error(`trade API ${r.status}: ${(await r.text()).slice(0, 120)}`);
  return new Uint8Array(await r.arrayBuffer());
}
