/** All settings come from .env (copy .env.example → .env). No code edits needed. */
import "dotenv/config";

const env = (k: string, d: string) => (process.env[k] ?? d).trim();
const num = (k: string, d: number) => {
  const v = Number(env(k, String(d)));
  return Number.isFinite(v) ? v : d;
};
const bool = (k: string, d: boolean) => ["1", "true", "yes", "on"].includes(env(k, String(d)).toLowerCase());
const list = (k: string, d: string) => env(k, d).split(",").map((s) => s.trim()).filter(Boolean);

export type TradeMode = "paper" | "browser" | "keypair";

const mode = env("MODE", "paper").toLowerCase() as TradeMode;
const PUBLIC_HOSTS = ["api.mainnet-beta.solana.com", "solana-rpc.publicnode.com"];
const PUBLIC_ONLY = (process.env.RPC_URL ?? "").trim() === "" ||
  (process.env.RPC_URL ?? "").split(",").every((u) => PUBLIC_HOSTS.some((h) => u.includes(h)));

export const config = {
  chain: "SOLANA",
  // ── trading mode ──
  mode: (["paper", "browser", "keypair"].includes(mode) ? mode : "paper") as TradeMode,
  confirmLive: env("CONFIRM_LIVE", "NO").toUpperCase() === "YES",
  autoBuy: bool("AUTO_BUY", true),
  paused: bool("PAUSED", false),
  keypairPath: env("KEYPAIR_PATH", "./bot-wallet.json"),
  botPrivateKey: env("BOT_PRIVATE_KEY", ""),

  // ── data sources ──
  stream: env("STREAM", "auto").toLowerCase() as "auto" | "rpc" | "pumpportal",
  // One URL, or several separated by commas: the bot rotates between them and rests any that rate-limit.
  // Default: free public endpoints that need no account.
  rpcUrl: env("RPC_URL", "https://api.mainnet-beta.solana.com,https://solana-rpc.publicnode.com"),
  rpcWssUrl: env("RPC_WSS_URL", ""),
  pumpPortalWs: env("PUMPPORTAL_WS", "wss://pumpportal.fun/api/data"),
  tradeUrl: env("TRADE_URL", "https://pumpportal.fun/api/trade-local"),
  pumpfunApi: env("PUMPFUN_API", "https://frontend-api-v3.pump.fun"),
  rpcConcurrency: num("RPC_CONCURRENCY", PUBLIC_ONLY ? 4 : 8),
  databaseUrl: env("DATABASE_URL", ""),
  dataDir: env("DATA_DIR", "./data"),

  // ── stage 1 / stage 2 ──
  decisionSeconds: num("DECISION_SECONDS", 6),
  observeSeconds: num("OBSERVE_SECONDS", 3),
  recheckAt: list("RECHECK_AT", "15,30").map(Number).filter((x) => x > 0),
  stage2BudgetSeconds: num("STAGE2_BUDGET_SECONDS", 3),
  selectScore: num("SELECT_SCORE", 80),
  monitorScore: num("MONITOR_SCORE", 60),
  minCompleteness: num("MIN_DATA_COMPLETENESS", 0.6),
  checkPumpfunApi: bool("CHECK_PUMPFUN_API", true),
  checkMetadata: bool("CHECK_METADATA", false),
  traceBuyers: num("TRACE_BUYERS", PUBLIC_ONLY ? 2 : 4),
  minTraceSol: num("MIN_TRACE_SOL", 0.05),
  trackCreatorsMinutes: num("TRACK_CREATORS_MINUTES", 30),
  devDumpPct: num("DEV_DUMP_PCT", 70),
  serviceSpanMinutes: num("SERVICE_SPAN_MINUTES", 60),
  rulesOverridePath: env("RULES_OVERRIDE_PATH", "./config/rules-overrides.json"),
  ruleResultsStore: env("RULE_RESULTS_STORE", "nonpass") as "all" | "nonpass" | "triggered",
  retentionDays: num("RETENTION_DAYS", 14),

  // ── trading ──
  buySol: num("BUY_SOL", 0.05),
  slippagePct: num("SLIPPAGE_PCT", 15),
  priorityFeeSol: num("PRIORITY_FEE", 0.0005),
  pumpFeePct: num("FEE_PCT", 1.25),
  pumpswapFeePct: num("PUMPSWAP_FEE_PCT", 0.3),
  platformFeePct: num("PLATFORM_FEE_PCT", 0.5),
  paperSlippagePct: num("PAPER_SLIPPAGE_PCT", 5),
  paperStartSol: num("PAPER_START_SOL", 2),
  extraPrograms: list("ALLOWED_EXTRA_PROGRAMS", ""),

  // ── positions & risk ──
  trailingDrawdown: num("TRAILING_DRAWDOWN", 0.35),
  takeProfitPct: num("TAKE_PROFIT_PCT", 0),
  stopLossPct: num("STOP_LOSS_PCT", 0),
  maxHoldMinutes: num("MAX_HOLD_MINUTES", 10),
  whaleExitPct: num("WHALE_EXIT_PCT", 50),
  maxOpen: num("MAX_OPEN_POSITIONS", 3),
  maxBuysPerHour: num("MAX_BUYS_PER_HOUR", 6),
  dailyLossSol: num("DAILY_LOSS_LIMIT_SOL", 0.5),
  browserAutoPromptExits: bool("BROWSER_AUTO_PROMPT_EXITS", true),

  // ── outputs ──
  port: num("PORT", 8787),
  // on Railway (or any cloud host) listen on all interfaces; on a laptop only on this machine
  host: env("HOST", process.env.RAILWAY_ENVIRONMENT || process.env.RAILWAY_PROJECT_ID ? "0.0.0.0" : "127.0.0.1"),
  dashboardPassword: env("DASHBOARD_PASSWORD", ""),
  onRailway: Boolean(process.env.RAILWAY_ENVIRONMENT || process.env.RAILWAY_PROJECT_ID),
  telegramToken: env("TELEGRAM_BOT_TOKEN", ""),
  telegramChat: env("TELEGRAM_CHAT_ID", ""),
  webhookUrl: env("OUTPUT_WEBHOOK_URL", ""),
  webhookDecisions: list("WEBHOOK_DECISIONS", "SELECT_FOR_REVIEW").map((s) => s.toUpperCase()),
  logJson: bool("LOG_JSON", false),
  terminalShow: list("TERMINAL_SHOW", "ALL").map((s) => s.toUpperCase()),
};

/** Real money moves only in keypair mode with CONFIRM_LIVE=YES, or when you approve in your browser wallet. */
export const isLiveKeypair = () => config.mode === "keypair" && config.confirmLive;
export const isPaper = () => config.mode === "paper" || (config.mode === "keypair" && !config.confirmLive);
export type Config = typeof config;
