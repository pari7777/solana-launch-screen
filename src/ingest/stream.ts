/**
 * Launch & trade stream.
 *  rpc        – Solana logsSubscribe on the pump.fun program (needs RPC_WSS_URL, e.g. Helius). Exact slot,
 *               signature and instruction index; every pump.fun trade arrives, so nothing extra to subscribe.
 *  pumpportal – PumpPortal's public feed (no key). Slot is filled in afterwards; per-coin trade subscriptions.
 *  auto       – rpc when RPC_WSS_URL is set, otherwise pumpportal.
 */
import { config } from "../config";
import type { LaunchEvent, TradeEvent } from "../types";
import { decodePumpLogs, PUMP_PROGRAM } from "../decoders/pump-launch";
import { Dedupe } from "./deduplicate";
import { ReconnectingSocket } from "./reconnect";

export interface StreamHandlers {
  onLaunch: (e: LaunchEvent) => void;
  onTrade: (e: TradeEvent) => void;
  onState?: (provider: string, state: string, ok: boolean, slot?: number) => void;
}

export class LaunchStream {
  readonly provider: "rpc" | "pumpportal";
  private sock: ReconnectingSocket;
  private dedupe = new Dedupe();
  private watchedMints = new Set<string>();
  private watchedWallets = new Set<string>();
  lastSlot: number | null = null;

  constructor(private h: StreamHandlers) {
    this.provider = config.stream === "rpc" || (config.stream === "auto" && config.rpcWssUrl) ? "rpc" : "pumpportal";
    if (this.provider === "rpc" && !config.rpcWssUrl) throw new Error("STREAM=rpc needs RPC_WSS_URL in .env");
    this.sock = this.provider === "rpc" ? this.rpcSocket() : this.pumpPortalSocket();
  }

  start() { this.sock.start(); }
  stop() { this.sock.stop(); }
  get state() { return this.sock.state; }

  /** PumpPortal only streams trades for coins/wallets you subscribe to; the RPC stream sees everything. */
  watchMint(mint: string) {
    if (this.provider !== "pumpportal" || this.watchedMints.has(mint)) return;
    this.watchedMints.add(mint); this.sock.send({ method: "subscribeTokenTrade", keys: [mint] });
  }
  unwatchMint(mint: string) {
    if (this.provider !== "pumpportal" || !this.watchedMints.delete(mint)) return;
    this.sock.send({ method: "unsubscribeTokenTrade", keys: [mint] });
  }
  watchWallet(w: string) {
    if (this.provider !== "pumpportal" || this.watchedWallets.has(w)) return;
    this.watchedWallets.add(w); this.sock.send({ method: "subscribeAccountTrade", keys: [w] });
  }
  unwatchWallets(ws: string[]) {
    if (this.provider !== "pumpportal") return;
    const k = ws.filter((w) => this.watchedWallets.delete(w));
    for (let i = 0; i < k.length; i += 100) this.sock.send({ method: "unsubscribeAccountTrade", keys: k.slice(i, i + 100) });
  }

  // ─────────── Solana RPC logs ───────────
  private rpcSocket() {
    return new ReconnectingSocket(config.rpcWssUrl, {
      onOpen: (send) => send({ jsonrpc: "2.0", id: 1, method: "logsSubscribe",
                               params: [{ mentions: [PUMP_PROGRAM] }, { commitment: "processed" }] }),
      onMessage: (m) => {
        if (m.method !== "logsNotification") return;
        const slot = m.params?.result?.context?.slot ?? 0;
        const v = m.params?.result?.value;
        if (!v || v.err || !Array.isArray(v.logs)) return;
        this.lastSlot = slot;
        const { creates, trades } = decodePumpLogs(v.signature, slot, v.logs);
        for (const c of creates) if (this.dedupe.first(`c:${c.signature}:${c.instructionIndex}`)) this.h.onLaunch(c);
        for (const t of trades) if (this.dedupe.first(`t:${t.signature}:${t.eventIndex}`)) this.h.onTrade(t);
      },
      onState: (s, ok) => this.h.onState?.("stream_rpc", s, ok, this.lastSlot ?? undefined),
    }, "rpc-logs");
  }

  // ─────────── PumpPortal ───────────
  private pumpPortalSocket() {
    return new ReconnectingSocket(config.pumpPortalWs, {
      onOpen: (send) => {
        send({ method: "subscribeNewToken" });
        const mints = [...this.watchedMints], wallets = [...this.watchedWallets];
        for (let i = 0; i < mints.length; i += 100) send({ method: "subscribeTokenTrade", keys: mints.slice(i, i + 100) });
        for (let i = 0; i < wallets.length; i += 100) send({ method: "subscribeAccountTrade", keys: wallets.slice(i, i + 100) });
      },
      onMessage: (m) => {
        const now = Date.now();
        if (m.txType === "create" && m.mint && this.dedupe.first(`c:${m.signature}:0`)) {
          this.h.onLaunch({ signature: m.signature, instructionIndex: 0, slot: 0, mint: m.mint, deployer: m.traderPublicKey ?? "",
            creator: m.traderPublicKey ?? "", bondingCurve: m.bondingCurveKey ?? "", name: m.name ?? "", symbol: m.symbol ?? "",
            uri: m.uri ?? "", vsol: undefined, vtok: undefined, receivedAt: now, source: "pumpportal" });   // reserves come from chain
          // PumpPortal reports the creator's first buy inside the create message
          if (Number(m.initialBuy) > 0 && this.dedupe.first(`t:${m.signature}:dev`))
            this.h.onTrade({ signature: m.signature, eventIndex: 0, slot: 0, mint: m.mint, wallet: m.traderPublicKey, side: "buy",
              sol: num(m.solAmount) ?? 0, tokens: Number(m.initialBuy), vsol: num(m.vSolInBondingCurve) ?? 0,
              vtok: num(m.vTokensInBondingCurve) ?? 0, receivedAt: now, source: "pumpportal", fromCreate: true });
        } else if ((m.txType === "buy" || m.txType === "sell") && m.mint) {
          const key = `t:${m.signature}:${m.mint}:${m.traderPublicKey}:${m.tokenAmount}`;
          if (!this.dedupe.first(key)) return;
          this.h.onTrade({ signature: m.signature, eventIndex: 0, slot: 0, mint: m.mint, wallet: m.traderPublicKey, side: m.txType,
            sol: num(m.solAmount) ?? 0, tokens: num(m.tokenAmount) ?? 0, vsol: num(m.vSolInBondingCurve) ?? 0,
            vtok: num(m.vTokensInBondingCurve) ?? 0, receivedAt: now, source: "pumpportal" });
        }
      },
      onState: (s, ok) => this.h.onState?.("stream_pumpportal", s, ok),
    }, "pumpportal");
  }
}

const num = (x: unknown) => (x === undefined || x === null || x === "" ? undefined : Number(x));
