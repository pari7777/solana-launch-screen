/** Repository: every read/write the engine does against the Postgres schema. */
import type { Sql } from "./db";
import type { DecisionOutput, LaunchEvent, RuleResult, WalletTrace } from "../types";
import { config } from "../config";

const CHAIN = "SOLANA";
const iso = (ms: number) => new Date(ms).toISOString();

export class Store {
  private flags = new Map<string, Map<string, Record<string, unknown>>>();
  constructor(readonly sql: Sql) {}

  async init() {
    for (const r of await this.sql.query("SELECT wallet, flag, evidence FROM wallet_flags WHERE chain=$1", [CHAIN]))
      this.cacheFlag(r.wallet, r.flag, r.evidence);
  }

  // ── launches ──
  async insertLaunch(l: LaunchEvent) {
    await this.sql.query(
      `INSERT INTO launches(chain, signature, instruction_index, mint, creator, slot, received_at, name, symbol)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT DO NOTHING`,
      [CHAIN, l.signature, l.instructionIndex, l.mint, l.deployer, l.slot, iso(l.receivedAt),
       l.name.trim().toLowerCase(), l.symbol.trim().toLowerCase()]);
  }

  async setLaunchSlot(l: LaunchEvent) {
    await this.sql.query("UPDATE launches SET slot=$4 WHERE chain=$1 AND signature=$2 AND instruction_index=$3",
      [CHAIN, l.signature, l.instructionIndex, l.slot]);
  }

  async recordDecision(l: LaunchEvent, out: DecisionOutput, results: RuleResult[]) {
    const now = new Date().toISOString();
    await this.sql.query(
      "UPDATE launches SET decision=$4, score=$5, data_completeness=$6 WHERE chain=$1 AND signature=$2 AND instruction_index=$3",
      [CHAIN, l.signature, l.instructionIndex, out.decision, out.risk_score, out.data_completeness]);
    const keep = results.filter((r) => config.ruleResultsStore === "all" ? true
      : config.ruleResultsStore === "triggered" ? r.status === "TRIGGERED" : r.status !== "PASS");
    if (keep.length) {
      const vals: unknown[] = [];
      const rows = keep.map((r, i) => {
        vals.push(CHAIN, l.signature, l.instructionIndex, r.rule.rule_id, r.status, r.rule.severity,
          JSON.stringify({ text: r.text, ...r.evidence }), now);
        const b = i * 8;
        return `($${b + 1},$${b + 2},$${b + 3},$${b + 4},$${b + 5},$${b + 6},$${b + 7}::jsonb,$${b + 8})`;
      });
      await this.sql.query(
        `INSERT INTO rule_results(chain, signature, instruction_index, rule_id, status, severity, evidence, evaluated_at)
         VALUES ${rows.join(",")}
         ON CONFLICT (chain, signature, instruction_index, rule_id)
         DO UPDATE SET status=EXCLUDED.status, severity=EXCLUDED.severity, evidence=EXCLUDED.evidence, evaluated_at=EXCLUDED.evaluated_at`, vals);
    }
    await this.sql.query(
      "INSERT INTO decision_history(chain, mint, decision, score, reasons, created_at, output) VALUES($1,$2,$3,$4,$5::jsonb,$6,$7::json)",
      [CHAIN, l.mint, out.decision, out.risk_score, JSON.stringify(out.top_rejection_reasons), now, JSON.stringify(out)]);
  }

  async priorLaunches(deployer: string, mint: string, hours: number) {
    return this.sql.query<{ mint: string; decision: string }>(
      `SELECT mint, decision FROM launches WHERE chain=$1 AND creator=$2 AND mint<>$3 AND received_at > now() - ($4 || ' hours')::interval
       ORDER BY received_at DESC LIMIT 10`, [CHAIN, deployer, mint, String(hours)]);
  }

  async copycat(mint: string, name: string, symbol: string, hours: number) {
    const r = await this.sql.query(
      `SELECT 1 FROM launches WHERE chain=$1 AND mint<>$2 AND received_at > now() - ($5 || ' hours')::interval
       AND (symbol=$3 OR name=$4) LIMIT 1`, [CHAIN, mint, symbol.trim().toLowerCase(), name.trim().toLowerCase(), String(hours)]);
    return r.length > 0;
  }

  // ── funding graph ──
  async addFundingEdge(t: WalletTrace) {
    if (!t.funder || !t.fundingSignature) return;
    await this.sql.query(
      `INSERT INTO wallet_edges(chain, source_wallet, destination_wallet, edge_type, signature, slot, amount_lamports, evidence)
       VALUES($1,$2,$3,'FUNDING',$4,$5,$6,$7::jsonb) ON CONFLICT DO NOTHING`,
      [CHAIN, t.funder, t.wallet, t.fundingSignature, t.fundingSlot ?? 0, t.fundingLamports,
       JSON.stringify({ funder_is_service: t.funderIsService, wallet_tx_count: t.txCount })]);
  }

  async funderOf(wallet: string): Promise<{ funder: string; service: boolean } | null> {
    const r = await this.sql.query<{ source_wallet: string; svc: string | null }>(
      `SELECT source_wallet, evidence->>'funder_is_service' AS svc FROM wallet_edges
       WHERE chain=$1 AND destination_wallet=$2 AND edge_type='FUNDING' LIMIT 1`, [CHAIN, wallet]);
    return r[0] ? { funder: r[0].source_wallet, service: r[0].svc === "true" } : null;
  }

  /** How many OTHER launch deployers this funder has funded recently. */
  async funderLaunchCount(funder: string, exceptDeployer: string, hours: number) {
    const r = await this.sql.query<{ n: string }>(
      `SELECT COUNT(DISTINCT l.creator) AS n FROM wallet_edges e JOIN launches l ON l.creator = e.destination_wallet
       WHERE e.chain=$1 AND e.source_wallet=$2 AND e.edge_type='FUNDING' AND l.creator<>$3
       AND l.received_at > now() - ($4 || ' hours')::interval`, [CHAIN, funder, exceptDeployer, String(hours)]);
    return Number(r[0]?.n ?? 0);
  }

  // ── learned flags ──
  private cacheFlag(wallet: string, flag: string, ev: Record<string, unknown>) {
    if (!this.flags.has(wallet)) this.flags.set(wallet, new Map());
    this.flags.get(wallet)!.set(flag, ev);
  }
  flagsOf(wallet: string | null | undefined) { return wallet ? this.flags.get(wallet) : undefined; }
  flagCount(flag: string) { let n = 0; for (const m of this.flags.values()) if (m.has(flag)) n++; return n; }
  recentFlags(limit = 8) {
    const out: { wallet: string; flag: string; evidence: any }[] = [];
    for (const [w, m] of this.flags) for (const [f, e] of m) out.push({ wallet: w, flag: f, evidence: e });
    return out.sort((a, b) => String(b.evidence.at ?? "").localeCompare(String(a.evidence.at ?? ""))).slice(0, limit);
  }
  async flagWallet(wallet: string, flag: "RUGGER" | "RUG_FUNDER", evidence: Record<string, unknown>) {
    const ev = { ...evidence, at: new Date().toISOString() };
    this.cacheFlag(wallet, flag, ev);
    await this.sql.query(
      `INSERT INTO wallet_flags(chain, wallet, flag, evidence, created_at) VALUES($1,$2,$3,$4::jsonb,now())
       ON CONFLICT (chain, wallet, flag) DO UPDATE SET evidence=EXCLUDED.evidence`, [CHAIN, wallet, flag, JSON.stringify(ev)]);
  }

  // ── provider health ──
  async health(provider: string, ok: boolean, slot?: number | null, status?: string) {
    await this.sql.query(
      `INSERT INTO provider_health(provider, last_success_at, last_slot, consecutive_failures, status)
       VALUES($1, CASE WHEN $2 THEN now() END, $3, CASE WHEN $2 THEN 0 ELSE 1 END, $4)
       ON CONFLICT (provider) DO UPDATE SET
         last_success_at = CASE WHEN $2 THEN now() ELSE provider_health.last_success_at END,
         last_slot = COALESCE($3, provider_health.last_slot),
         consecutive_failures = CASE WHEN $2 THEN 0 ELSE provider_health.consecutive_failures + 1 END,
         status = $4`, [provider, ok, slot ?? null, status ?? (ok ? "OK" : "DEGRADED")]);
  }
  async healthAll() { return this.sql.query("SELECT * FROM provider_health ORDER BY provider"); }

  // ── outputs for the API ──
  async latestOutput(mint: string) {
    const r = await this.sql.query("SELECT output FROM decision_history WHERE chain=$1 AND mint=$2 ORDER BY id DESC LIMIT 1", [CHAIN, mint]);
    return r[0]?.output ?? null;
  }
  async latestOutputs(limit: number, decision?: string) {
    return (await this.sql.query(
      `SELECT output FROM decision_history WHERE chain=$1 ${decision ? "AND decision=$3" : ""} ORDER BY id DESC LIMIT $2`,
      decision ? [CHAIN, limit, decision] : [CHAIN, limit])).map((r) => r.output);
  }
  async ruleResults(mint: string) {
    return this.sql.query(
      `SELECT r.rule_id, r.status, r.severity, r.evidence, r.evaluated_at FROM rule_results r
       JOIN launches l ON l.chain=r.chain AND l.signature=r.signature AND l.instruction_index=r.instruction_index
       WHERE l.mint=$1 ORDER BY r.rule_id`, [mint]);
  }

  // ── positions ──
  async savePosition(p: any) {
    await this.sql.query(
      `INSERT INTO positions(chain, mint, mode, wallet, symbol, status, venue, tokens, cost_sol, net_liquidation_value,
         high_water_value, proceeds_sol, pnl_sol, exit_reason, buy_signature, sell_signature, score, meta, opened_at, updated_at, closed_at)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18::jsonb,$19,now(),$20)
       ON CONFLICT (chain, mint, opened_at) DO UPDATE SET status=EXCLUDED.status, venue=EXCLUDED.venue, tokens=EXCLUDED.tokens,
         net_liquidation_value=EXCLUDED.net_liquidation_value, high_water_value=EXCLUDED.high_water_value,
         proceeds_sol=EXCLUDED.proceeds_sol, pnl_sol=EXCLUDED.pnl_sol, exit_reason=EXCLUDED.exit_reason,
         sell_signature=EXCLUDED.sell_signature, meta=EXCLUDED.meta, updated_at=now(), closed_at=EXCLUDED.closed_at`,
      [CHAIN, p.mint, p.mode, p.wallet, p.symbol, p.status, p.venue, p.tokens, p.costSol, p.netLiquidationValue,
       p.highWaterValue, p.proceedsSol ?? null, p.pnlSol ?? null, p.exitReason ?? null, p.buySignature ?? null,
       p.sellSignature ?? null, p.score ?? null, JSON.stringify(p.meta ?? {}), iso(p.openedAt), p.closedAt ? iso(p.closedAt) : null]);
  }
  async openPositions() {
    return this.sql.query("SELECT * FROM positions WHERE chain=$1 AND status <> 'CLOSED' ORDER BY opened_at", [CHAIN]);
  }
  async closedPositions(limit = 50) {
    return this.sql.query("SELECT * FROM positions WHERE chain=$1 AND status='CLOSED' ORDER BY closed_at DESC LIMIT $2", [CHAIN, limit]);
  }
  async pnlSummary() {
    const r = await this.sql.query(
      `SELECT COUNT(*) AS n, COALESCE(SUM(pnl_sol),0) AS pnl, COALESCE(SUM(CASE WHEN pnl_sol>0 THEN 1 ELSE 0 END),0) AS wins,
              COALESCE(SUM(CASE WHEN closed_at >= date_trunc('day', now()) THEN pnl_sol ELSE 0 END),0) AS today
       FROM positions WHERE chain=$1 AND status='CLOSED'`, [CHAIN]);
    return { trades: Number(r[0].n), pnl: Number(r[0].pnl), wins: Number(r[0].wins), today: Number(r[0].today) };
  }

  // ── kv & housekeeping ──
  async get<T>(k: string, d: T): Promise<T> {
    const r = await this.sql.query("SELECT v FROM kv WHERE k=$1", [k]); return r.length ? (r[0].v as T) : d;
  }
  async put(k: string, v: unknown) {
    await this.sql.query("INSERT INTO kv(k, v) VALUES($1,$2::jsonb) ON CONFLICT (k) DO UPDATE SET v=EXCLUDED.v", [k, JSON.stringify(v)]);
  }
  async prune(days: number) {
    const i = `${days} days`;
    await this.sql.query("DELETE FROM rule_results WHERE evaluated_at < now() - $1::interval", [i]);
    await this.sql.query("DELETE FROM decision_history WHERE created_at < now() - $1::interval", [i]);
    await this.sql.query("DELETE FROM launches WHERE received_at < now() - $1::interval", [i]);
    // wallet_edges has no timestamp: keep the newest 150k edges for this chain
    await this.sql.query(
      `DELETE FROM wallet_edges WHERE chain = $1 AND ctid IN (SELECT ctid FROM wallet_edges WHERE chain = $1 ORDER BY slot ASC
         LIMIT GREATEST(0, (SELECT COUNT(*) FROM wallet_edges WHERE chain = $1) - 150000))`, [CHAIN]);
  }
}
