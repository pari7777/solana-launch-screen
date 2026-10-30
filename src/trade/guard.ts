/**
 * Signing guard (rules R087–R092): every transaction from the trade API is decoded and checked BEFORE it is
 * signed — by the bot wallet in keypair mode, or before it is handed to your browser wallet.
 */
import { VersionedTransaction } from "@solana/web3.js";
import { config } from "../config";
import { PUMP_PROGRAM } from "../decoders/pump-launch";
import { PUMP_AMM_PROGRAM } from "../decoders/pumpswap";
import { TOKEN_2022, TOKEN_PROGRAM } from "../data/accounts";

const SYSTEM = "11111111111111111111111111111111";
const COMPUTE = "ComputeBudget111111111111111111111111111111";
const ATA = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";
const MEMO = "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr";
const PUMP_FEES = "pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ";
export const ALLOWED_PROGRAMS = new Set([PUMP_PROGRAM, PUMP_AMM_PROGRAM, PUMP_FEES, SYSTEM, COMPUTE, ATA, TOKEN_PROGRAM, TOKEN_2022, MEMO]);

export interface GuardResult { ok: boolean; rule?: string; reason: string; tx?: VersionedTransaction }

export function validateTx(raw: Uint8Array, owner: string, refSol: number): GuardResult {
  let tx: VersionedTransaction;
  try { tx = VersionedTransaction.deserialize(raw); } catch (e) { return { ok: false, rule: "R089", reason: `cannot decode transaction (${(e as Error).message})` }; }
  const msg = tx.message;
  const keys = msg.staticAccountKeys.map((k) => k.toBase58());
  if (keys[0] !== owner) return { ok: false, rule: "R089", reason: "fee payer is not your wallet", tx };
  if (msg.header.numRequiredSignatures !== 1) return { ok: false, rule: "R089", reason: "transaction asks for extra signers", tx };
  if (!msg.recentBlockhash || msg.recentBlockhash === SYSTEM) return { ok: false, rule: "R092", reason: "missing recent blockhash", tx };
  const allowed = new Set([...ALLOWED_PROGRAMS, ...config.extraPrograms]);
  let direct = 0;
  for (const ix of msg.compiledInstructions) {
    const prog = keys[ix.programIdIndex];
    if (!prog || !allowed.has(prog)) return { ok: false, rule: "R087", reason: `unknown program ${prog ?? "(lookup table)"}`, tx };
    const data = Buffer.from(ix.data);
    if (prog === SYSTEM && data.length >= 12 && data.readUInt32LE(0) === 2) {
      const from = ix.accountKeyIndexes[0];
      if (from !== undefined && keys[from] === owner) direct += Number(data.readBigUInt64LE(4)) / 1e9;
    }
    if ((prog === TOKEN_PROGRAM || prog === TOKEN_2022) && data.length && [4, 6, 13].includes(data[0]))
      return { ok: false, rule: "R088", reason: "token approval / authority change inside the swap", tx };
  }
  const cap = 3 * config.priorityFeeSol + refSol * (config.platformFeePct / 100) * 2 + 0.003;
  if (direct > cap) return { ok: false, rule: "R089", reason: `sends ${direct.toFixed(4)} SOL directly (cap ${cap.toFixed(4)})`, tx };
  return { ok: true, reason: "ok", tx };
}
