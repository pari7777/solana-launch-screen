/** JSON-RPC client with a concurrency limit, per-call timeout, latency stats and health reporting. */
import { config } from "../config";

export type Transport = (method: string, params: unknown[], timeoutMs: number) => Promise<unknown>;

class Semaphore {
  private q: (() => void)[] = [];
  constructor(private n: number) {}
  async acquire() { if (this.n > 0) { this.n--; return; } await new Promise<void>((r) => this.q.push(r)); }
  release() { const next = this.q.shift(); if (next) next(); else this.n++; }
}

export const httpTransport = (url: string): Transport => async (method, params, timeoutMs) => {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, signal: ctl.signal,
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
    if (r.status === 429) throw new Error("RPC rate-limited (429)");
    if (!r.ok) throw new Error(`RPC HTTP ${r.status}`);
    const j: any = await r.json();
    if (j.error) throw new Error(String(j.error.message ?? JSON.stringify(j.error)).slice(0, 160));
    return j.result;
  } catch (e: any) {
    if (e?.name === "AbortError") throw new Error(`RPC ${method} timed out after ${timeoutMs}ms`);
    throw e;
  } finally { clearTimeout(t); }
};

/** Several endpoints: round-robin, and an endpoint that rate-limits or fails is rested with exponential backoff. */
export function multiTransport(urls: string[]): Transport & { status: () => { url: string; ok: number; fail: number; restingFor: number }[] } {
  const eps = urls.map((url) => ({ url, t: httpTransport(url), ok: 0, fail: 0, restUntil: 0, backoff: 2000 }));
  let next = 0;
  const pick = () => {
    const now = Date.now();
    for (let i = 0; i < eps.length; i++) {
      const e = eps[(next + i) % eps.length];
      if (e.restUntil <= now) { next = (next + i + 1) % eps.length; return e; }
    }
    return eps.reduce((a, b) => (a.restUntil < b.restUntil ? a : b));      // all resting: use the one free soonest
  };
  const fn = (async (method: string, params: unknown[], timeoutMs: number) => {
    let last: unknown;
    for (let attempt = 0; attempt < Math.min(3, eps.length + 1); attempt++) {
      const e = pick();
      try {
        const r = await e.t(method, params, timeoutMs);
        e.ok++; e.backoff = 2000;
        return r;
      } catch (err: any) {
        last = err; e.fail++;
        const msg = String(err?.message ?? err);
        const transient = /429|rate|timed out|fetch failed|ECONN|HTTP \d|Too many|overload|Service unavailable/i.test(msg);
        if (!transient) throw err;                          // a real RPC error (e.g. bad params): don't hide it
        e.restUntil = Date.now() + e.backoff; e.backoff = Math.min(e.backoff * 2, 60_000);
      }
    }
    throw last;
  }) as Transport & { status: () => any[] };
  fn.status = () => eps.map((e) => ({ url: e.url.replace(/api-key=[^&]+/, "api-key=***"), ok: e.ok, fail: e.fail,
                                      restingFor: Math.max(0, Math.round((e.restUntil - Date.now()) / 1000)) }));
  return fn;
}

const URLS = config.rpcUrl.split(",").map((u) => u.trim()).filter(Boolean);
export const defaultTransport = URLS.length > 1 ? multiTransport(URLS) : httpTransport(URLS[0]);

export class Rpc {
  calls = 0; errors = 0;
  private lat: number[] = [];
  private sem: Semaphore;
  onHealth?: (ok: boolean) => void;
  constructor(private transport: Transport = defaultTransport, concurrency = config.rpcConcurrency) {
    this.sem = new Semaphore(concurrency);
  }
  async call<T = any>(method: string, params: unknown[], timeoutMs = 4000): Promise<T> {
    await this.sem.acquire();
    const t0 = performance.now(); this.calls++;
    try {
      const r = (await this.transport(method, params, timeoutMs)) as T;
      this.onHealth?.(true);
      return r;
    } catch (e) {
      this.errors++; this.onHealth?.(false); throw e;
    } finally {
      this.lat.push(performance.now() - t0); if (this.lat.length > 300) this.lat.shift();
      this.sem.release();
    }
  }
  endpoints() { return (this.transport as any).status?.() ?? [{ url: URLS[0]?.replace(/api-key=[^&]+/, "api-key=***"), ok: this.calls - this.errors, fail: this.errors, restingFor: 0 }]; }
  stats() {
    const s = [...this.lat].sort((a, b) => a - b);
    return { calls: this.calls, errors: this.errors, p50_ms: s.length ? Math.round(s[Math.floor(s.length / 2)]) : null, endpoints: this.endpoints() };
  }
}
