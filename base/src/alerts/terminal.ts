/** Colour terminal output: one line per decision, position events, and a status line every 30 s. */
import { config } from "../config";
import type { Record_ } from "../engine/screener";

const C = { r: "\x1b[31m", g: "\x1b[32m", y: "\x1b[33m", b: "\x1b[34m", m: "\x1b[35m", c: "\x1b[36m", d: "\x1b[2m", B: "\x1b[1m", x: "\x1b[0m" };
const COLOR: Record<string, string> = { REJECT: C.r, WAIT: C.y, MONITOR: C.b, SELECT_FOR_REVIEW: C.g };
const LABEL: Record<string, string> = { REJECT: "REJECT ", WAIT: "WAIT   ", MONITOR: "MONITOR", SELECT_FOR_REVIEW: "SELECT " };

export function printDecision(r: Record_) {
  const o = r.output;
    const score = o.risk_score === null ? "  —" : String(o.risk_score).padStart(3);
  const reason = o.top_rejection_reasons[0];
  const why = reason ? `${C.B}${reason.rule_id}${C.x} ${reason.evidence}` : `${C.g}all gates passed${C.x}`;
  const sym = `$${r.meta.symbol}`.slice(0, 11).padEnd(11);
  console.log(`${C.d}${r.meta.time}${C.x} ${COLOR[o.decision]}${C.B}${LABEL[o.decision]}${C.x} ${sym} ${r.meta.gated ? `${C.r}⛔${C.x}` : score}` +
    ` ${C.d}${o.confidence.padEnd(6)} ${(r.meta.elapsed_ms / 1000).toFixed(1)}s s${r.meta.stage}${C.x} │ ${why} ${C.d}→ ${r.meta.action}${C.x}`);
  if (config.logJson) console.log(JSON.stringify(o));
}

export const printEvent = (msg: string) => console.log(`${C.c}${new Date().toISOString().slice(11, 19)}${C.x} ${C.B}${msg}${C.x}`);

export function printStatus(s: { scanned: number; byPlatform?: Record<string, number>; overflow?: number; final: Record<string, number>; stream: string; rpc: any; open: number; pnl: number; mode: string; url: string }) {
  const f = s.final;
  console.log(`${C.m}── ${s.mode.toUpperCase()} · stream ${s.stream} · scanned ${s.scanned} · ` +
    `select ${f.SELECT_FOR_REVIEW ?? 0} / reject ${f.REJECT ?? 0} · open ${s.open} · P&L ${s.pnl >= 0 ? "+" : ""}${s.pnl.toFixed(5)} ETH · ` +
    `RPC p50 ${s.rpc.p50_ms ?? "—"}ms, ${s.rpc.errors} errors · ${s.url} ──${C.x}`);
  const bp = Object.entries(s.byPlatform ?? {}).map(([k, v]) => `${k} ${v}`).join(", ");
  console.log(`${C.d}   by platform: ${bp || "—"}${s.overflow ? ` · ${s.overflow} not screened (busy)` : ""}${s.rpc.last_error ? ` · last rpc error: ${s.rpc.last_error}` : ""}${C.x}`);
  const eps = s.rpc.endpoints ?? [];
  if (eps.length > 1) void 0; if (false) console.log(`${C.d}   rpc endpoints: ${eps.map((e: any) => `${new URL(e.url).host} ok ${e.ok} / fail ${e.fail}${e.restingFor ? ` (resting ${e.restingFor}s)` : ""}`).join(" · ")}${C.x}`);
}

export function banner(lines: string[]) {
  console.log(`\n${C.B}${C.c}  ███ base-launch-screen ███${C.x}`);
  for (const l of lines) console.log(`  ${l}`);
  console.log("");
}
