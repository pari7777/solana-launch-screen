/**
 * Decodes pump.fun CreateEvent / TradeEvent from transaction logs ("Program data: <base64>").
 * The top-level instruction index is tracked from "Program … invoke [1]" lines, so every launch is keyed by
 * (signature, instruction_index) exactly as the launches table requires.
 */
import { anchorEventDisc, Reader } from "./reader";
import type { LaunchEvent, TradeEvent } from "../types";

export const PUMP_PROGRAM = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P";
export const CREATE_DISC = anchorEventDisc("CreateEvent");
export const TRADE_DISC = anchorEventDisc("TradeEvent");
const LAMPORTS = 1e9, TOKEN_UNITS = 1e6;

export function decodeCreateEvent(data: Buffer) {
  const r = new Reader(data.subarray(8));
  const name = r.string(), symbol = r.string(), uri = r.string();
  const mint = r.pubkey(), bondingCurve = r.pubkey(), user = r.pubkey();
  let creator = user, vsol: number | undefined, vtok: number | undefined;
  if (r.left >= 32) creator = r.pubkey();
  if (r.left >= 8) r.i64();                                   // timestamp
  if (r.left >= 16) { vtok = Number(r.u64()) / TOKEN_UNITS; vsol = Number(r.u64()) / LAMPORTS; }
  return { name, symbol, uri, mint, bondingCurve, user, creator, vsol, vtok };
}

export function decodeTradeEvent(data: Buffer) {
  const r = new Reader(data.subarray(8));
  const mint = r.pubkey();
  const sol = Number(r.u64()) / LAMPORTS, tokens = Number(r.u64()) / TOKEN_UNITS;
  const isBuy = r.bool(), user = r.pubkey();
  r.i64();
  const vsol = Number(r.u64()) / LAMPORTS, vtok = Number(r.u64()) / TOKEN_UNITS;
  return { mint, sol, tokens, isBuy, user, vsol, vtok };
}

const INVOKE = /^Program (\w+) invoke \[(\d+)\]$/;

export function decodePumpLogs(signature: string, slot: number, logs: string[], receivedAt = Date.now()) {
  const creates: LaunchEvent[] = [], trades: TradeEvent[] = [];
  let top = -1, eventIndex = 0;
  for (const line of logs) {
    const m = INVOKE.exec(line);
    if (m) { if (m[2] === "1") top++; continue; }
    if (!line.startsWith("Program data: ")) continue;
    let buf: Buffer;
    try { buf = Buffer.from(line.slice(14), "base64"); } catch { continue; }
    if (buf.length < 8) continue;
    const disc = buf.subarray(0, 8);
    try {
      if (disc.equals(CREATE_DISC)) {
        const e = decodeCreateEvent(buf);
        creates.push({ signature, instructionIndex: Math.max(0, top), slot, mint: e.mint, deployer: e.user, creator: e.creator,
          bondingCurve: e.bondingCurve, name: e.name, symbol: e.symbol, uri: e.uri, vsol: e.vsol, vtok: e.vtok,
          receivedAt, source: "rpc" });
      } else if (disc.equals(TRADE_DISC)) {
        const e = decodeTradeEvent(buf);
        trades.push({ signature, eventIndex: eventIndex++, slot, mint: e.mint, wallet: e.user, side: e.isBuy ? "buy" : "sell",
          sol: e.sol, tokens: e.tokens, vsol: e.vsol, vtok: e.vtok, receivedAt, source: "rpc" });
      }
    } catch { /* truncated or foreign event — skip */ }
  }
  return { creates, trades };
}
