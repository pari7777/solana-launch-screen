/** viem client over several free Base RPC endpoints, with automatic failover and call statistics. */
import { createPublicClient, fallback, http, type PublicClient } from "viem";
import { base } from "viem/chains";
import { config } from "../config";

export const stats = { calls: 0, errors: 0, lat: [] as number[], last: "" };

export function makeClient(urls = config.rpcUrls): PublicClient {
  const transports = urls.map((u) => http(u, {
    timeout: 6000, retryCount: 1, retryDelay: 400,
    onFetchRequest: () => { stats.calls++; },
    onFetchResponse: (r) => { if (!r.ok) { stats.errors++; stats.last = `${new URL(u).host} HTTP ${r.status}`; } },
  }));
  return createPublicClient({ chain: base, transport: transports.length > 1 ? fallback(transports, { rank: false, retryCount: 2 }) : transports[0],
                              batch: { multicall: true } }) as PublicClient;
}

export async function timed<T>(f: () => Promise<T>): Promise<T> {
  const t0 = performance.now();
  try { return await f(); }
  catch (e: any) { stats.errors++; stats.last = String(e?.shortMessage ?? e?.message ?? e).split("\n")[0].slice(0, 90); throw e; }
  finally { stats.lat.push(performance.now() - t0); if (stats.lat.length > 300) stats.lat.shift(); }
}

export function rpcStats() {
  const s = [...stats.lat].sort((a, b) => a - b);
  return { calls: stats.calls, errors: stats.errors, last_error: stats.last || null, p50_ms: s.length ? Math.round(s[Math.floor(s.length / 2)]) : null };
}
