/**
 * Local dashboard + JSON API on http://127.0.0.1:PORT (only this laptop can reach it).
 *   GET  /api/status                       live state for the page
 *   GET  /api/decisions?limit=&decision=   recent decision JSON (spec format)
 *   GET  /api/decision/:mint               latest decision JSON for a coin
 *   GET  /api/rule-results/:mint           stored rule_results rows for a coin
 *   GET  /api/rules                        the rule library and coverage
 *   POST /api/wallet/hello                 browser wallet heartbeat {pubkey}
 *   POST /api/approvals/:mint/prepare      guard-checked unsigned tx for your wallet {pubkey}
 *   POST /api/approvals/:mint/submitted    {pubkey, signature} after your wallet sent it
 *   POST /api/approvals/:mint/reject
 */
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import crypto from "node:crypto";
import { config } from "../config";

const PAGE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../public/dashboard.html");

export interface DashboardApi {
  status: () => Promise<unknown>;
  rules: () => unknown;
  decision: (mint: string) => Promise<unknown>;
  decisions: (limit: number, decision?: string) => Promise<unknown>;
  ruleResults: (mint: string) => Promise<unknown>;
  walletHello: (pubkey: string) => void;
  prepare: (mint: string, pubkey: string) => Promise<string>;
  submitted: (mint: string, pubkey: string, signature: string) => Promise<void>;
  reject: (mint: string) => void;
}

const json = (res: http.ServerResponse, code: number, body: unknown) => {
  res.writeHead(code, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
};

async function body(req: http.IncomingMessage): Promise<any> {
  let s = ""; for await (const c of req) { s += c; if (s.length > 1e5) throw new Error("body too large"); }
  return s ? JSON.parse(s) : {};
}

const B58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const SIG = /^[1-9A-HJ-NP-Za-km-z]{64,90}$/;

/** Password for the dashboard. Required whenever it is reachable from outside this machine. */
export function dashboardPassword(): string | null {
  if (config.dashboardPassword) return config.dashboardPassword;
  if (config.host === "127.0.0.1" || config.host === "localhost") return null;
  const gen = crypto.randomBytes(9).toString("base64url");
  console.log(`\n  ⚠️  DASHBOARD_PASSWORD is not set — using a temporary one for this run: ${gen}\n     Set DASHBOARD_PASSWORD in your variables to keep it fixed.\n`);
  return gen;
}

const same = (a: string, b: string) => {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};

export function startDashboard(api: DashboardApi) {
  const password = dashboardPassword();
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
      const p = url.pathname;
      if (p === "/health") { res.writeHead(200, { "content-type": "text/plain" }); return res.end("ok"); }
      if (password) {                                       // HTTP basic auth: any username + the password
        const h = String(req.headers.authorization ?? "");
        let ok = false;
        if (h.startsWith("Basic ")) { const d = Buffer.from(h.slice(6), "base64").toString(); ok = same(d.slice(d.indexOf(":") + 1), password); }
        if (!ok) { res.writeHead(401, { "www-authenticate": 'Basic realm="launch-screen"', "content-type": "text/plain" }); return res.end("login required"); }
      }
      if (req.method === "POST") {                         // only same-origin pages may act
        const origin = req.headers.origin;
        if (origin && new URL(origin).host !== req.headers.host) return json(res, 403, { error: "cross-origin request refused" });
        if (!String(req.headers["content-type"]).includes("application/json")) return json(res, 415, { error: "json only" });
      }
      if (req.method === "GET" && (p === "/" || p === "/index.html")) {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" }); return res.end(fs.readFileSync(PAGE));
      }
      if (req.method === "GET" && p === "/api/status") return json(res, 200, await api.status());
      if (req.method === "GET" && p === "/api/rules") return json(res, 200, api.rules());
      if (req.method === "GET" && p === "/api/decisions")
        return json(res, 200, await api.decisions(Math.min(500, Number(url.searchParams.get("limit") ?? 50) || 50), url.searchParams.get("decision")?.toUpperCase() || undefined));
      let m = /^\/api\/decision\/([1-9A-HJ-NP-Za-km-z]{32,44})$/.exec(p);
      if (req.method === "GET" && m) { const d = await api.decision(m[1]); return d ? json(res, 200, d) : json(res, 404, { error: "unknown token" }); }
      m = /^\/api\/rule-results\/([1-9A-HJ-NP-Za-km-z]{32,44})$/.exec(p);
      if (req.method === "GET" && m) return json(res, 200, await api.ruleResults(m[1]));
      if (req.method === "POST" && p === "/api/wallet/hello") {
        const b = await body(req); if (!B58.test(b.pubkey ?? "")) return json(res, 400, { error: "bad pubkey" });
        api.walletHello(b.pubkey); return json(res, 200, { ok: true });
      }
      m = /^\/api\/approvals\/([1-9A-HJ-NP-Za-km-z]{32,44})\/(prepare|submitted|reject)$/.exec(p);
      if (req.method === "POST" && m) {
        const b = await body(req);
        if (m[2] === "reject") { api.reject(m[1]); return json(res, 200, { ok: true }); }
        if (!B58.test(b.pubkey ?? "")) return json(res, 400, { error: "bad pubkey" });
        if (m[2] === "prepare") return json(res, 200, { tx: await api.prepare(m[1], b.pubkey) });
        if (!SIG.test(b.signature ?? "")) return json(res, 400, { error: "bad signature" });
        await api.submitted(m[1], b.pubkey, b.signature); return json(res, 200, { ok: true });
      }
      json(res, 404, { error: "not found" });
    } catch (e) {
      json(res, 500, { error: (e as Error).message });
    }
  });
  server.listen(config.port, config.host);
  return server;
}
