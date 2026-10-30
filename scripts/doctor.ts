/** npm run doctor — checks everything the bot needs on this laptop and says how to fix what is missing. */
import fs from "node:fs";
import WebSocket from "ws";
import { config, isLiveKeypair } from "../src/config";
import { openDb } from "../src/data/db";
import { Rpc } from "../src/data/rpc";
import { loadRules } from "../src/rules/registry";
import { loadKeypair } from "../src/trade/wallet";
import { PUMP_PROGRAM } from "../src/decoders/pump-launch";

const ok = (m: string) => console.log(`  \x1b[32m✓\x1b[0m ${m}`);
const bad = (m: string, fix: string) => { console.log(`  \x1b[31m✗\x1b[0m ${m}\n      → ${fix}`); problems++; };
const warn = (m: string) => console.log(`  \x1b[33m!\x1b[0m ${m}`);
let problems = 0;

console.log("\nsolana-launch-screen · doctor\n");
const major = Number(process.versions.node.split(".")[0]);
major >= 20 ? ok(`Node.js ${process.versions.node}`) : bad(`Node.js ${process.versions.node} is too old`, "install Node.js 20 LTS or newer from nodejs.org");
fs.existsSync(".env") ? ok(".env found") : bad(".env missing", "copy .env.example to .env (Windows: copy .env.example .env · Mac: cp .env.example .env)");

try { const r = loadRules(); ok(`${r.length} rules loaded and validated (${r.filter((x) => x.enabled).length} enabled)`); }
catch (e) { bad(`rule library: ${(e as Error).message}`, "check config/rules-overrides.json"); }

try { const db = await openDb(); ok(`database ready (${db.kind === "embedded" ? `embedded Postgres in ${config.dataDir}/pg` : "your Postgres"})`); await db.close(); }
catch (e) { bad(`database: ${(e as Error).message}`, config.databaseUrl ? "check DATABASE_URL" : "delete the data folder and retry"); }

const rpc = new Rpc();
if (config.rpcUrl.includes("api.mainnet-beta.solana.com")) warn("RPC_URL is the public Solana RPC — it rate-limits; get a free key at helius.dev");
try {
  const t = Date.now(); const slot = await rpc.call<number>("getSlot", []);
  ok(`RPC answers (slot ${slot}, ${Date.now() - t} ms)`);
  await rpc.call("getSignaturesForAddress", [PUMP_PROGRAM, { limit: 5 }]); ok("RPC history queries work (wallet tracing)");
} catch (e) { bad(`RPC: ${(e as Error).message}`, "set RPC_URL in .env to your Helius (or other) mainnet RPC URL"); }

async function probe(url: string, sub: unknown, isMsg: (m: any) => boolean) {
  return new Promise<string>((res) => {
    const ws = new WebSocket(url, { handshakeTimeout: 8000 });
    const t = setTimeout(() => { ws.terminate(); res("no events within 15 s"); }, 15_000);
    ws.on("open", () => ws.send(JSON.stringify(sub)));
    ws.on("message", (raw) => { try { if (isMsg(JSON.parse(raw.toString()))) { clearTimeout(t); ws.close(); res("ok"); } } catch {} });
    ws.on("error", (e) => { clearTimeout(t); res(e.message); });
  });
}
if (config.rpcWssUrl) {
  const r = await probe(config.rpcWssUrl, { jsonrpc: "2.0", id: 1, method: "logsSubscribe", params: [{ mentions: [PUMP_PROGRAM] }, { commitment: "processed" }] },
                        (m) => m.method === "logsNotification");
  r === "ok" ? ok("RPC websocket streams pump.fun events (exact slot + instruction index)") : bad(`RPC websocket: ${r}`, "check RPC_WSS_URL (wss://…) or remove it to use PumpPortal");
} else {
  const r = await probe(config.pumpPortalWs, { method: "subscribeNewToken" }, (m) => m.txType === "create");
  r === "ok" ? ok("PumpPortal stream delivers new launches") : bad(`PumpPortal stream: ${r}`, "check your internet connection, or set RPC_WSS_URL");
  warn("RPC_WSS_URL not set — using PumpPortal; set it (Helius wss URL) for exact slots and every trade");
}

if (config.mode === "keypair") {
  try {
    const kp = loadKeypair(); const bal = (await rpc.call<any>("getBalance", [kp.publicKey.toBase58()])).value / 1e9;
    ok(`bot wallet ${kp.publicKey.toBase58()} · ${bal.toFixed(4)} SOL`);
    if (bal < config.buySol + 0.01) warn(`balance is below one buy (${config.buySol} SOL) plus fees`);
    isLiveKeypair() ? warn("CONFIRM_LIVE=YES — REAL trades are enabled") : ok("CONFIRM_LIVE is not YES — keypair mode trades on paper");
  } catch (e) { bad((e as Error).message, 'run "npm run wallet:new" and fund the new address'); }
} else if (config.mode === "browser") {
  ok("browser-wallet mode: open the dashboard in Chrome/Brave/Edge with Phantom or Solflare and click Connect wallet");
} else ok("paper mode: no wallet needed");

console.log(problems ? `\n${problems} problem(s) to fix, then run "npm run doctor" again.\n` : `\nAll good. Start with "npm start" and open http://localhost:${config.port}\n`);
process.exit(problems ? 1 : 0);
