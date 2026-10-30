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
    const j: any = await r.json();
    if (j.error) throw new Error(String(j.error.message ?? JSON.stringify(j.error)).slice(0, 160));
    return j.result;
  } catch (e: any) {
    if (e?.name === "AbortError") throw new Error(`RPC ${method} timed out after ${timeoutMs}ms`);
    throw e;
  } finally { clearTimeout(t); }
};

export class Rpc {
  calls = 0; errors = 0;
  private lat: number[] = [];
  private sem: Semaphore;
  onHealth?: (ok: boolean) => void;
  constructor(private transport: Transport = httpTransport(config.rpcUrl), concurrency = config.rpcConcurrency) {
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
  stats() {
    const s = [...this.lat].sort((a, b) => a - b);
    return { calls: this.calls, errors: this.errors, p50_ms: s.length ? Math.round(s[Math.floor(s.length / 2)]) : null };
  }
}
