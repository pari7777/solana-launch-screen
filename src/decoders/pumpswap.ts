/**
 * PumpSwap (pump AMM) pools — where pump.fun coins trade after the bonding curve completes.
 * Pool layout (repr(C, packed), after the 8-byte discriminator):
 *   pool_bump u8 · index u16 · creator · base_mint · quote_mint · lp_mint · pool_base_token_account ·
 *   pool_quote_token_account · lp_supply u64 · coin_creator · …
 */
import bs58 from "bs58";
import type { Rpc } from "../data/rpc";

export const PUMP_AMM_PROGRAM = "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA";
export const WSOL = "So11111111111111111111111111111111111111112";
const OFF = { creator: 11, baseMint: 43, quoteMint: 75, lpMint: 107, baseVault: 139, quoteVault: 171, lpSupply: 203 };

export interface PumpSwapPool { address: string; baseMint: string; quoteMint: string; baseVault: string; quoteVault: string }

export function decodePool(address: string, data: Buffer): PumpSwapPool {
  if (data.length < OFF.lpSupply + 8) throw new Error("pool account too short");
  const pk = (o: number) => bs58.encode(data.subarray(o, o + 32));
  return { address, baseMint: pk(OFF.baseMint), quoteMint: pk(OFF.quoteMint), baseVault: pk(OFF.baseVault), quoteVault: pk(OFF.quoteVault) };
}

/** SPL token account: amount u64 at offset 64. */
export const tokenAccountAmount = (data: Buffer) => data.readBigUInt64LE(64);

export async function findPool(rpc: Rpc, mint: string): Promise<PumpSwapPool | null> {
  const res = await rpc.call<any[]>("getProgramAccounts", [PUMP_AMM_PROGRAM, {
    encoding: "base64",
    filters: [{ memcmp: { offset: OFF.baseMint, bytes: mint } }, { memcmp: { offset: OFF.quoteMint, bytes: WSOL } }],
  }], 10_000);
  const pools = res.map((a) => decodePool(a.pubkey, Buffer.from(a.account.data[0], "base64")));
  if (!pools.length) return null;
  if (pools.length === 1) return pools[0];
  const withRes = await Promise.all(pools.map(async (p) => ({ p, r: await poolReserves(rpc, p).catch(() => null) })));
  withRes.sort((a, b) => (b.r?.vsol ?? 0) - (a.r?.vsol ?? 0));
  return withRes[0].p;
}

/** Pool reserves in human units (token has 6 decimals, WSOL 9). */
export async function poolReserves(rpc: Rpc, pool: PumpSwapPool) {
  const res = await rpc.call<any>("getMultipleAccounts", [[pool.baseVault, pool.quoteVault], { encoding: "base64", commitment: "confirmed" }]);
  const [b, q] = res.value;
  if (!b || !q) throw new Error("pool vaults not found");
  return { vtok: Number(tokenAccountAmount(Buffer.from(b.data[0], "base64"))) / 1e6,
           vsol: Number(tokenAccountAmount(Buffer.from(q.data[0], "base64"))) / 1e9 };
}
