export type Venue = "pump_bonding_curve" | "pumpswap" | "generic_amm" | "signing";
export type Decision = "REJECT" | "WAIT" | "MONITOR" | "SELECT_FOR_REVIEW";
export type Severity = "CRITICAL" | "HIGH" | "MEDIUM" | "LOW";
export type RuleStatus = "TRIGGERED" | "PASS" | "MISSING" | "NOT_APPLICABLE";
export type Factor = "contract" | "liquidity" | "creator" | "holders" | "buyers" | "execution";

export interface LaunchEvent {
  signature: string;
  instructionIndex: number;
  slot: number;
  mint: string;
  deployer: string;          // signer that created the coin (and usually made the first buy)
  creator: string;           // creator recorded by pump.fun (fee recipient) — usually the same wallet
  bondingCurve: string;
  name: string;
  symbol: string;
  uri: string;
  vsol?: number;             // virtual reserves after creation (SOL / tokens)
  vtok?: number;
  receivedAt: number;        // ms epoch when this process saw it
  source: "rpc" | "pumpportal" | "replay";
}

export interface TradeEvent {
  signature: string;
  eventIndex: number;
  slot: number;
  mint: string;
  wallet: string;
  side: "buy" | "sell";
  sol: number;
  tokens: number;
  vsol: number;
  vtok: number;
  receivedAt: number;
  source: "rpc" | "pumpportal" | "replay";
}

export interface MintInfo {
  owner: string;
  mintAuthority: boolean;
  freezeAuthority: boolean;
  supplyRaw: bigint;
  decimals: number;
  extensions: { type: number; data: Uint8Array }[];
}

export interface CurveInfo {
  owner: string;
  vtok: number; vsol: number; rtok: number; rsol: number; supply: number; complete: boolean;
}

export interface ContractInfo { mint: MintInfo; curve: CurveInfo; curveKey: string; fetchedAt: number }

export interface WalletTrace {
  wallet: string;
  txCount: number;           // capped at 1000
  ageHours: number;
  old: boolean;              // ≥1000 signatures — long history
  funder: string | null;
  funderIsService: boolean | null;  // exchange / bot hot wallet → funding links ignored
  fundingSignature: string | null;
  fundingSlot: number | null;
  fundingLamports: number | null;
}

export interface Quote {
  spot: number; tokens: number;
  buyImpactPct: number; sellImpactPct: number; roundTripPct: number; dumpStressLossPct: number;
  clusterDumpLossPct: number;
}

export interface RuleDef {
  rule_id: string;
  version: number;
  category: string;
  severity: Severity;
  applies_to: Venue[];
  condition: string;
  evidence_required: string[];
  on_trigger: "REJECT" | "WAIT" | "MONITOR" | "WARN";
  on_missing_evidence: "WAIT" | "IGNORE";
  enabled: boolean;
  // additions used by this engine (optional in overrides)
  title: string;
  factor: Factor;
  params?: Record<string, number>;
  penalty?: number;
}

export interface RuleOutcome {
  status: "TRIGGERED" | "PASS" | "MISSING";
  text: string;
  evidence: Record<string, unknown>;
  missing?: string[];
}

export interface RuleResult extends Omit<RuleOutcome, "status"> {
  rule: RuleDef;
  status: RuleStatus;
}

export interface DecisionOutput {
  chain: "SOLANA";
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
    deployer: string;
    funding_source: string;
    initial_liquidity_provider: string;
    creator_token_share_pct: number | null;
    linked_wallet_clusters: { type: string; funder: string; wallets: string[]; share_pct: number }[];
    previous_launches: Record<string, unknown>[];
    privileged_authorities: string[];
  };
  market: {
    liquidity_usd: number | null;
    buy_price_impact_pct: number | null;
    sell_price_impact_pct: number | null;
    estimated_round_trip_cost_pct: number | null;
    sell_simulation: "MODELED_PASS" | "FAILED" | "NOT_VERIFIED";
  };
  risk_rules_checked: number;
  risk_rules_triggered: string[];
  missing_data: string[];
  auto_buy_allowed: boolean;
}
