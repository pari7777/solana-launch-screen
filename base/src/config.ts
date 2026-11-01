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
  // first endpoint takes the load; mainnet.base.org rate-limits hard (HTTP 429), so it is last
  rpcUrls: list("BASE_RPC_URL", "https://base-rpc.publicnode.com,https://base.drpc.org,https://mainnet.base.org"),
  explorerApi: env("EXPLORER_API", "https://base.blockscout.com/api"),
  pollMs: num("POLL_MS", 1500),
  maxBlockRange: num("MAX_BLOCK_RANGE", 2000),
  backfillHours: num("BACKFILL_HOURS", 72),
  databaseUrl: env("DATABASE_URL", ""),
  dataDir: env("DATA_DIR", "./data"),

  // ── launch platforms (comma list): clanker, zora, flaunch, doppler ──
  platforms: list("PLATFORMS", "clanker,zora,flaunch,doppler").map((x) => x.toLowerCase()),
  maxInReview: num("MAX_IN_REVIEW", 30),          // launches screened at once; extra ones are counted, not screened

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
  ruleResultsStore: env("RULE_RESULTS_STORE", "triggered") as "all" | "nonpass" | "triggered",
  retentionDays: num("RETENTION_DAYS", 3),        // the shared Railway Postgres volume is small (500 MB)

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
  quoter: "0x0d5e0f971ed27fbff6c2837bf31316121532048d",
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

/** Other Base launchpads. Sources: Zora docs (factory), @flaunch/sdk and @whetstone-research/doppler-sdk address books. */
export const PLATFORM_ADDR = {
  zoraFactory: "0x777777751622c0d3258f214F9DF38E35BF45baF3",
  zoraToken: "0x1111111111166b7FE7bd91427724B487980aFc69",
  flETH: "0x000000000D564D5be76f7f0d28fE52605afC7Cf8",
  // Flaunch hooks (every generation still serves its own pools); PoolCreated is emitted by these
  flaunchPositionManagers: ["0x51Bba15255406Cfe7099a42183302640ba7dAFDC", "0xf785bb58059fab6fb19bdda2cb9078d9e546efdc",
    "0x23321f11a6d44fd1ab790044fdfde5758c902fdc", "0x588c683ecc450f8b2aadb13d7f63792b840425dc",
    "0x8DC3b85e1dc1C846ebf3971179a751896842e5dC", "0x6ea0edee449a287504990df8d87951b9436825dc", "0xE753a351FB498051a09Dc130fcC29aEBc76525DC"],
  flaunchInfra: ["0x1B8065a099AdcD7aa7c5e241e3596B56ec98bA5a", "0xCc7A4A00072ccbeEEbd999edc812C0ce498Fb63B", "0x4dc442403e8c758425b93C59Dc737da522f32640",
    "0x66681f10BA90496241A25e33380004f30Dfd8aa8", "0x7f22353d1634223a802D1c1Ea5308Ddf5DD0ef9c", "0x0dae90b70f62ce3b1d5278f4763bd1f595d6a687",
    "0x2154c604df568A5285284D1c4918DC98C39240df", "0x9d58ca8011096ad711babf0d990c45b9d5bb047d", "0x72e6f7948b1B1A343B477F39aAbd2E35E6D27dde",
    "0x17fbf54d6d15ebff82eee77e616f701952d08bb4", "0x39112541720078c70164EA4Deb61F0A4811910F9", "0xf787d757674b21efd713fb636b16ed994bfa82a8",
    "0x68d967d25806fef4aa134db031cdcc55d3e20f92", "0xfE616a9c723f5fB35728C7ccCb84dB034A18cC86", "0x9E433F32bb5481a9CA7DFF5b3af74A7ed041a888"],
  dopplerAirlock: "0x660eAaEdEBc968f8f3694354FA8EC0b4c5Ba8D12",
  // Doppler initializers / hooks that create Uniswap v4 pools (multicurve, scheduled, decay, dynamic auction, hook initializers)
  dopplerV4: ["0xFDFD7D27089f306eEF279b5DA6BFe878250cB6bb", "0x65dE470Da664A5be139A5D812bE5FDa0d76CC951", "0xA36715dA46Ddf4A769f3290f49AF58bF8132ED8E",
    "0xD59cE43E53D69F190E15d9822Fb4540dCcc91178", "0xBDF938149ac6a781F94FAa0ed45E6A0e984c6544", "0xe2AEbc987592593b667ec29178D0A83929Db78b6"],
  dopplerInfra: ["0xf0B5141dD9096254B2ca624dff26024f46087229", "0x16F5ACB64F4FA17296E942C51d3395aDC318f9e1", "0xaA47D2977d622DBdFD33eeF6a8276727c52EB4e5",
    "0x5F3bA43D44375286296Cb85F1EA2EBfa25dde731", "0xd3B4cF7FD24381e90A4F012fC6c5976b87B9B3cE", "0xa1b06BE4f2fC347d194240D79EDa9F40CCAd9732",
    "0xD6FECFF347c6203A41874e8D77dE669B54e7A500", "0x0A00775D71a42cd33D62780003035e7F5b47bD3A"],
  v3Quoter: "0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a",     // Uniswap QuoterV2 on Base
};
export type PlatformId = "clanker" | "zora" | "flaunch" | "doppler";
export const PLATFORM_LABEL: Record<PlatformId, string> = { clanker: "Clanker", zora: "Zora", flaunch: "Flaunch", doppler: "Doppler / Bankr" };
/** Default supply when the token cannot be read (only used for % maths). */
export const DEFAULT_SUPPLY: Record<PlatformId, number> = { clanker: 100_000_000_000, zora: 1_000_000_000, flaunch: 100_000_000_000, doppler: 1_000_000_000 };

export const lc = (a: string) => a.toLowerCase();
export const ZERO = "0x0000000000000000000000000000000000000000";
/** Currencies worth exactly 1 ETH: native ETH (v4 address 0), WETH, Flaunch's flETH. */
export const ETH_LIKE = new Set([ZERO, ADDR.weth, PLATFORM_ADDR.flETH].map(lc));
export const INFRA = new Set([ADDR.poolManager, ADDR.universalRouter, ADDR.permit2, ADDR.clankerFactory, ...ADDR.clankerInfra,
                              PLATFORM_ADDR.zoraFactory, ...PLATFORM_ADDR.flaunchPositionManagers, ...PLATFORM_ADDR.flaunchInfra,
                              PLATFORM_ADDR.dopplerAirlock, ...PLATFORM_ADDR.dopplerV4, ...PLATFORM_ADDR.dopplerInfra,
                              ZERO, "0x000000000000000000000000000000000000dEaD"].map(lc));
