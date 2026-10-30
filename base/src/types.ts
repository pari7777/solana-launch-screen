export type Venue = "clanker_v4" | "generic_amm" | "signing";
export type Decision = "REJECT" | "WAIT" | "MONITOR" | "SELECT_FOR_REVIEW";
export type Severity = "CRITICAL" | "HIGH" | "MEDIUM" | "LOW";
export type RuleStatus = "TRIGGERED" | "PASS" | "MISSING" | "NOT_APPLICABLE";
export type Factor = "contract" | "liquidity" | "creator" | "holders" | "buyers" | "execution";
export type Hex = `0x${string}`;

export interface PoolKey { currency0: Hex; currency1: Hex; fee: number; tickSpacing: number; hooks: Hex }

export interface LaunchEvent {
  signature: string;          // transaction hash
  instructionIndex: number;   // log index
  slot: number;               // block number
  token: Hex;
  creator: Hex;               // tokenAdmin — the person behind the coin
  sender: Hex;                // msgSender — often a platform deployer (Clanker bot, frontends)
  name: string; symbol: string; image: string; metadata: string; context: string;
  startingTick: number;
  hook: Hex; poolId: Hex; pairedToken: Hex; locker: Hex; mevModule: Hex;
  extensionsSupply: bigint; extensions: Hex[];
  receivedAt: number;
  blockTime: number;          // seconds
}

export interface TokenTransfer { tx: string; logIndex: number; block: number; from: string; to: string; amount: bigint; at: number }
export interface PoolSwap { tx: string; logIndex: number; block: number; sqrtPriceX96: bigint; amount0: bigint; amount1: bigint; at: number }

export interface Trade {
  tx: string; block: number; wallet: string; side: "buy" | "sell"; tokens: number; eth: number; priceEth: number | null; at: number;
}

export interface WalletTrace {
  wallet: string;
  txCount: number;            // nonce (transactions sent)
  ageHours: number | null;    // since first transaction (explorer)
  isContract: boolean;
  funder: string | null;
  funderIsService: boolean | null;
  fundingTx: string | null;
}

export interface Quote {
  spotEthPerToken: number;
  tokensForBuy: number;
  buyImpactPct: number; sellImpactPct: number; roundTripPct: number;
  dumpStressLossPct: number; clusterDumpLossPct: number;
  feeNow: number | null;      // effective pool fee implied by a tiny round trip (%), includes the sniper fee
  at: number;
}

export interface RuleDef {
  rule_id: string; version: number; category: string; severity: Severity; applies_to: Venue[]; condition: string;
  evidence_required: string[]; on_trigger: "REJECT" | "WAIT" | "MONITOR" | "WARN"; on_missing_evidence: "WAIT" | "IGNORE";
  enabled: boolean; title: string; factor: Factor; params?: Record<string, number>; penalty?: number;
}
export interface RuleOutcome { status: "TRIGGERED" | "PASS" | "MISSING"; text: string; evidence: Record<string, unknown>; missing?: string[] }
export interface RuleResult extends Omit<RuleOutcome, "status"> { rule: RuleDef; status: RuleStatus }

export interface DecisionOutput {
  chain: "BASE";
  token_address: string;
  launch_timestamp: string;
  decision_deadline_seconds: number;
  decision: Decision;
  risk_score: number | null;
  confidence: "HIGH" | "MEDIUM" | "LOW";
  data_completeness: number;
  top_selection_reasons: { factor_id: number; factor: string; score: number; evidence: string }[];
  top_rejection_reasons: { rule_id: string; reason: string; severity: Severity; evidence: string }[];
  launch_wallet: {
    deployer: string; funding_source: string; initial_liquidity_provider: string; creator_token_share_pct: number | null;
    linked_wallet_clusters: { type: string; funder: string; wallets: string[]; share_pct: number }[];
    previous_launches: Record<string, unknown>[]; privileged_authorities: string[];
  };
  market: { liquidity_usd: number | null; buy_price_impact_pct: number | null; sell_price_impact_pct: number | null;
            estimated_round_trip_cost_pct: number | null; sell_simulation: "MODELED_PASS" | "FAILED" | "NOT_VERIFIED" };
  risk_rules_checked: number; risk_rules_triggered: string[]; missing_data: string[]; auto_buy_allowed: boolean;
}
