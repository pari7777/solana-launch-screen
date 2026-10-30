/**
 * Postgres access. Uses your Postgres when DATABASE_URL is set; otherwise an embedded Postgres (PGlite)
 * stored in ./data/pg — real Postgres SQL (JSONB, TIMESTAMPTZ, BIGSERIAL) with nothing to install.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "../config";

export interface Sql {
  query<T = any>(sql: string, params?: unknown[]): Promise<T[]>;
  exec(sql: string): Promise<void>;
  close(): Promise<void>;
  kind: "postgres" | "embedded";
}

const MIGRATIONS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../migrations");

export async function openDb(opts: { url?: string; dir?: string | null } = {}): Promise<Sql> {
  const url = opts.url ?? config.databaseUrl;
  let sql: Sql;
  if (url) {
    const pg = (await import("pg")).default;
    const pool = new pg.Pool({ connectionString: url, max: 5 });
    sql = {
      kind: "postgres",
      query: async (q, p) => (await pool.query(q, p as any[])).rows,
      exec: async (q) => { await pool.query(q); },
      close: async () => { await pool.end(); },
    };
  } else {
    const { PGlite } = await import("@electric-sql/pglite");
    const dir = opts.dir === null ? undefined : (opts.dir ?? path.join(config.dataDir, "pg"));
    if (dir) fs.mkdirSync(dir, { recursive: true });
    const db = dir ? new PGlite(dir) : new PGlite();
    await db.waitReady;
    sql = {
      kind: "embedded",
      query: async (q, p) => (await db.query(q, p as any[])).rows as any[],
      exec: async (q) => { await db.exec(q); },
      close: async () => { await db.close(); },
    };
  }
  await migrate(sql);
  return sql;
}

async function migrate(sql: Sql) {
  await sql.exec("CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL)");
  const done = new Set((await sql.query<{ name: string }>("SELECT name FROM schema_migrations")).map((r) => r.name));
  for (const f of fs.readdirSync(MIGRATIONS).filter((f) => f.endsWith(".sql")).sort()) {
    if (done.has(f)) continue;
    await sql.exec(fs.readFileSync(path.join(MIGRATIONS, f), "utf8"));
    await sql.query("INSERT INTO schema_migrations(name, applied_at) VALUES($1, now())", [f]);
  }
}
