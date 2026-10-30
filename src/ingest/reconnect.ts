/** WebSocket that reconnects with exponential backoff, keeps itself alive, and reports its state. */
import WebSocket from "ws";

export interface SocketHandlers {
  onOpen: (send: (msg: unknown) => void) => void;
  onMessage: (data: any) => void;
  onState?: (state: string, ok: boolean) => void;
}

export class ReconnectingSocket {
  private ws: WebSocket | null = null;
  private delay = 1000;
  private stopped = false;
  private ping: NodeJS.Timeout | null = null;
  private lastMsg = Date.now();
  state = "connecting";
  constructor(private url: string, private h: SocketHandlers, private name = "stream") {}

  start() { this.stopped = false; this.connect(); }
  stop() { this.stopped = true; this.ws?.close(); if (this.ping) clearInterval(this.ping); }
  send(msg: unknown) { if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg)); }

  private set(state: string, ok: boolean) { this.state = state; this.h.onState?.(state, ok); }

  private connect() {
    const ws = new WebSocket(this.url, { handshakeTimeout: 10_000 });
    this.ws = ws;
    ws.on("open", () => {
      this.delay = 1000; this.lastMsg = Date.now(); this.set("connected", true);
      this.h.onOpen((m) => ws.send(JSON.stringify(m)));
      if (this.ping) clearInterval(this.ping);
      this.ping = setInterval(() => {
        if (Date.now() - this.lastMsg > 60_000) { ws.terminate(); return; }   // silent for 60 s → reconnect
        try { ws.ping(); } catch { /* closed */ }
      }, 20_000);
    });
    ws.on("message", (raw) => {
      this.lastMsg = Date.now();
      let data: any; try { data = JSON.parse(raw.toString()); } catch { return; }
      try { this.h.onMessage(data); } catch (e) { console.error(`[${this.name}] handler error`, e); }
    });
    ws.on("pong", () => { this.lastMsg = Date.now(); });
    ws.on("error", (e) => this.set(`error: ${String(e.message).slice(0, 60)}`, false));
    ws.on("close", () => {
      if (this.ping) clearInterval(this.ping);
      if (this.stopped) return;
      this.set(`reconnecting in ${Math.round(this.delay / 1000)}s`, false);
      setTimeout(() => this.connect(), this.delay);
      this.delay = Math.min(this.delay * 2, 30_000);
    });
  }
}
