/** Token mint + bonding-curve account reads: authorities, supply and Token-2022 extensions. */
import bs58 from "bs58";
import type { ContractInfo, MintInfo } from "../types";
import type { Rpc } from "./rpc";
import { bondingCurvePda, decodeCurve } from "../decoders/bonding-curve";

export const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
export const TOKEN_2022 = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
const ZERO32 = Buffer.alloc(32);

export const EXT = {
  TransferFeeConfig: 1, MintCloseAuthority: 3, ConfidentialTransferMint: 4, DefaultAccountState: 6, NonTransferable: 9,
  InterestBearingConfig: 10, PermanentDelegate: 12, TransferHook: 14, ConfidentialTransferFeeConfig: 16,
  MetadataPointer: 18, TokenMetadata: 19, GroupPointer: 20, TokenGroup: 21, GroupMemberPointer: 22, TokenGroupMember: 23,
  ConfidentialMintBurn: 24, ScaledUiAmount: 25, Pausable: 26,
} as const;
export const EXT_NAME: Record<number, string> = Object.fromEntries(Object.entries(EXT).map(([k, v]) => [v, k]));
export const SAFE_EXTENSIONS = new Set<number>([18, 19, 20, 21, 22, 23]);

export function decodeMint(data: Buffer, owner: string): MintInfo {
  if (data.length < 82) throw new Error("mint account too short");
  const m: MintInfo = {
    owner,
    mintAuthority: data.readUInt32LE(0) === 1 && !data.subarray(4, 36).equals(ZERO32),
    freezeAuthority: data.readUInt32LE(46) === 1 && !data.subarray(50, 82).equals(ZERO32),
    supplyRaw: data.readBigUInt64LE(36), decimals: data[44], extensions: [],
  };
  if (owner === TOKEN_2022 && data.length > 166) {
    let p = 166;                                   // byte 165 = account type, TLV entries follow
    while (p + 4 <= data.length) {
      const type = data.readUInt16LE(p), len = data.readUInt16LE(p + 2); p += 4;
      if (type === 0 && len === 0) break;
      m.extensions.push({ type, data: data.subarray(p, p + len) }); p += len;
    }
  }
  return m;
}

/** Live (configured) extensions — an extension with an empty authority/program does nothing. */
export function activeExtensions(m: MintInfo) {
  const out: { type: number; name: string; detail?: string }[] = [];
  for (const { type, data } of m.extensions) {
    const d = Buffer.from(data);
    if (type === EXT.PermanentDelegate && d.subarray(0, 32).equals(ZERO32)) continue;
    if (type === EXT.TransferHook && d.subarray(32, 64).equals(ZERO32)) continue;
    if (type === EXT.Pausable && d.subarray(0, 32).equals(ZERO32)) continue;
    if (type === EXT.DefaultAccountState && d[0] !== 2) continue;           // 2 = frozen by default
    if (type === EXT.TransferFeeConfig) {
      // newer fee: epoch u64, max_fee u64, bps u16 at the end of the 108-byte value
      const bps = d.length >= 108 ? d.readUInt16LE(106) : -1;
      out.push({ type, name: EXT_NAME[type], detail: bps >= 0 ? `${bps / 100}% fee` : undefined }); continue;
    }
    out.push({ type, name: EXT_NAME[type] ?? `type ${type}`,
      detail: type === EXT.PermanentDelegate || type === EXT.TransferHook ? bs58.encode(d.subarray(type === EXT.TransferHook ? 32 : 0, type === EXT.TransferHook ? 64 : 32)) : undefined });
  }
  return out;
}

let diag = 0;
export async function fetchContract(rpc: Rpc, mint: string, curveKey?: string): Promise<ContractInfo> {
  const ck = curveKey || bondingCurvePda(mint);
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await rpc.call<any>("getMultipleAccounts", [[mint, ck], { encoding: "base64", commitment: "processed" }]);
    const [a, c] = res.value;
    if (a && c) {
      const cd = Buffer.from(c.data[0], "base64");
      const info: ContractInfo = { mint: decodeMint(Buffer.from(a.data[0], "base64"), a.owner),
        curve: decodeCurve(cd, c.owner), curveKey: ck, fetchedAt: Date.now() };
      if (diag < 12 && process.env.CURVE_DIAG !== "off") {
        diag++;
        console.log(`[curve-diag] mint=${mint} curveKey=${ck} pda=${bondingCurvePda(mint)} owner=${c.owner} len=${cd.length} ` +
          `u64s=${[8, 16, 24, 32, 40].map((o) => cd.length >= o + 8 ? cd.readBigUInt64LE(o).toString() : "-").join(",")} ` +
          `complete=${cd[48]} mintOwner=${a.owner} supply=${info.mint.supplyRaw} dec=${info.mint.decimals} ext=${info.mint.extensions.map((e) => e.type).join("|")}`);
      }
      return info;
    }
    await new Promise((r) => setTimeout(r, 350));
  }
  throw new Error("mint or curve account not visible yet");
}
