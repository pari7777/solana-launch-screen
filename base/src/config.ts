/** Base launch screen settings — set them in Railway → Variables (or a local .env). */
import "dotenv/config";

const env = (k: string, d: string) => (process.env[k] ?? d).trim();
const num = (k: string, d: number) => { const v = Number(env(k, String(d))); return Number.isFinite(v) ? v : d; };
const bool = (k: string, d: boolean) => ["1", "true", "yes", "on"].includes(env(k, String(d)).toLowerCase());
const list = (k: string, d: string) => env(k, d).split(",").map((s) => s.trim()).filter(Boolean);

export const config = {
  chain: "BASE" as const,
  mode: "paper" as const,                       // v1: paper trading only on Base
  autoBuy: bool("AUTO_BUY", true),
  paused: bool("PAUSED", false),

  // ── data sources (free, no account) ──
  rpcUrls: list("BASE_RPC_URL", "https://mainnet.base.org,https://base-rpc.publicnode.com"),
  explorerApi: env("EXPLORER_API", "https://base.blockscout.com/api"),
  pollMs: num("POLL_MS", 1500),
  maxBlockRange: num("MAX_BLOCK_RANGE", 2000),
  backfillHours: num("BACKFILL_HOURS", 72),
  databaseUrl: env("DATABASE_URL", ""),
  dataDir: env("DATA_DIR", "./data"),

  // ── screening timeline ──
  decisionSeconds: num("DECISION_SECONDS", 6),
  observeSeconds: num("OBSERVE_SECONDS", 3),
  // Clanker charges a falling "sniper fee" right after launch, so Base re-checks run longer than Solana's
  recheckAt: list("RECHECK_AT", "20,45,90,150").map(Number).filter((x) => x > 0),
  selectScore: num("SELECT_SCORE", 80),
  monitorScore: num("MONITOR_SCORE", 60),
  traceBuyers: num("TRACE_BUYERS", 3),
  minTraceEth: num("MIN_TRACE_ETH", 0.01),
  trackCreatorsMinutes: num("TRACK_CREATORS_MINUTES", 60),
  devDumpPct: num("DEV_DUMP_PCT", 70),
  serviceNonce: num("SERVICE_NONCE", 5000),      // a funder with this many sent txs is an exchange / bot
  rulesOverridePath: env("RULES_OVERRIDE_PATH", "./rules-overrides.json"),
  ruleResultsStore: env("RULE_RESULTS_STORE", "nonpass") as "all" | "nonpass" | "triggered",
  retentionDays: num("RETENTION_DAYS", 14),

  // ── trading (paper) ──
  buyEth: num("BUY_ETH", 0.01),
  paperStartEth: num("PAPER_START_ETH", 0.5),
  paperSlippagePct: num("PAPER_SLIPPAGE_PCT", 3),
  gasEth: num("GAS_ETH", 0.00002),               // rough Base swap cost, charged per trade on paper

  // ── exits & limits ──
  trailingDrawdown: num("TRAILING_DRAWDOWN", 0.35),
  takeProfitPct: num("TAKE_PROFIT_PCT", 0),
  stopLossPct: num("STOP_LOSS_PCT", 0),
  maxHoldMinutes: num("MAX_HOLD_MINUTES", 30),
  whaleExitPct: num("WHALE_EXIT_PCT", 50),
  maxOpen: num("MAX_OPEN_POSITIONS", 3),
  maxBuysPerHour: num("MAX_BUYS_PER_HOUR", 6),
  dailyLossEth: num("DAILY_LOSS_LIMIT_ETH", 0.1),

  // ── outputs ──
  port: num("PORT", 8788),
  host: env("HOST", process.env.RAILWAY_ENVIRONMENT || process.env.RAILWAY_PROJECT_ID ? "0.0.0.0" : "127.0.0.1"),
  dashboardPassword: env("DASHBOARD_PASSWORD", ""),
  telegramToken: env("TELEGRAM_BOT_TOKEN", ""),
  telegramChat: env("TELEGRAM_CHAT_ID", ""),
  webhookUrl: env("OUTPUT_WEBHOOK_URL", ""),
  webhookDecisions: list("WEBHOOK_DECISIONS", "SELECT_FOR_REVIEW").map((s) => s.toUpperCase()),
  logJson: bool("LOG_JSON", false),
};

/** Contract addresses on Base mainnet (chain 8453). Sources: Clanker docs, Uniswap v4 deployments. */
export const ADDR = {
  clankerFactory: "0xE85A59c628F7d27878ACeB4bf3b35733630083a9",
  poolManager: "0x498581fF718922c3f8e6A244956aF099B2652b2b",
  quoter: "0xE1A6C5803e3c44368b171BD680c7D32dfc92CA47",
  stateView: "0xa3c0c9b65bad0b08107aa264b0f3db444b867a71",
  universalRouter: "0x6fF5693b99212Da76ad316178A184AB56D299b43",
  permit2: "0x000000000022D473030F116dDEE9F6B43aC78BA3",
  weth: "0x4200000000000000000000000000000000000006",
  // Clanker v4.0 / v4.1 infrastructure (never counted as holders)
  clankerInfra: [
    "0x34a45c6B61876d739400Bd71228CbcbD4F53E8cC", "0xDd5EeaFf7BD481AD55Db083062b13a3cdf0A68CC", "0xE143f9872A33c955F23cF442BB4B1EFB3A7402A2",
    "0x29d17C1A8D851d7d4cA97FAe97AcAdb398D9cCE0", "0x63D2DfEA64b3433F4071A98665bcD7Ca14d93496", "0x8E845EAd15737bF71904A30BdDD3aEE76d6ADF6C",
    "0x56Fa0Da89eD94822e46734e736d34Cab72dF344F", "0x1331f0788F9c08C8F38D52c7a1152250A9dE00be", "0xF3622742b1E446D92e45E22923Ef11C2fcD55D68",
    "0xFdc013ce003980889cFfd66b0c8329545ae1d1E8", "0x8806169969aE96bfaaDb3eFd4B10785BEEb321b3", "0xd60D6B218116cFd801E28F78d011a203D2b068Cc",
    "0xb429d62f8f3bFFb98CdB9569533eA23bF0Ba28CC", "0xebB25BB797D82CB78E1bc70406b13233c0854413", "0xC5AA2945d52a4096b946891ef8e01668f82eB74E",
    "0xf652B3610D75D81871bf96DB50825d9af28391E0", "0xaa12bb11E9876FCAFc7c46dBEB985d3fA23832c9",
  ],
  vaults: ["0x8E845EAd15737bF71904A30BdDD3aEE76d6ADF6C"],
  airdrops: ["0x56Fa0Da89eD94822e46734e736d34Cab72dF344F", "0xf652B3610D75D81871bf96DB50825d9af28391E0"],
  devBuy: ["0x1331f0788F9c08C8F38D52c7a1152250A9dE00be"],
  knownHooks: ["0x34a45c6B61876d739400Bd71228CbcbD4F53E8cC", "0xDd5EeaFf7BD481AD55Db083062b13a3cdf0A68CC",
               "0xd60D6B218116cFd801E28F78d011a203D2b068Cc", "0xb429d62f8f3bFFb98CdB9569533eA23bF0Ba28CC"],
};

export const lc = (a: string) => a.toLowerCase();
export const INFRA = new Set([ADDR.poolManager, ADDR.universalRouter, ADDR.permit2, ADDR.clankerFactory, ...ADDR.clankerInfra,
                              "0x0000000000000000000000000000000000000000", "0x000000000000000000000000000000000000dEaD"].map(lc));
