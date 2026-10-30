/**
 * The 120-rule screening library, one declarative rule per spec item, plus custom rules (X…).
 * Edit thresholds without touching code: put { "R051": { "params": { "max_pct": 40 } } } in
 * config/rules-overrides.json. You can also override enabled, severity, on_trigger, on_missing_evidence.
 *
 * applies_to: pump_bonding_curve (new launches) · pumpswap (after migration) · generic_amm (other AMMs —
 * LP locks, vesting, audits) · signing (checked by the signing guard when a transaction is built, not at screening)
 */
import type { Factor, RuleDef, Severity, Venue } from "../types";

type Row = [id: string, category: string, severity: Severity, condition: string, on_trigger: RuleDef["on_trigger"],
            on_missing: RuleDef["on_missing_evidence"], factor: Factor, title: string,
            params?: Record<string, number>, applies?: Venue[], evidence?: string[]];

const PUMP: Venue[] = ["pump_bonding_curve", "pumpswap"];
const AMM_ONLY: Venue[] = ["generic_amm"];
const SIGNING: Venue[] = ["signing"];

const A = "contract_permissions", B = "liquidity_exit", Cw = "creator_wallets", D = "early_buyers", E = "distribution",
      F = "launch_behavior", G = "market_integrity", H = "execution", I = "launch_dynamics", J = "metadata_identity";

const rows: Row[] = [
  // ── A. Contract and token permissions ──
  ["R001", A, "CRITICAL", "sell_blocking_restriction", "REJECT", "WAIT", "contract", "Honeypot behavior prevents selling"],
  ["R002", A, "CRITICAL", "permanent_delegate", "REJECT", "WAIT", "contract", "Creator can confiscate holder balances"],
  ["R003", A, "CRITICAL", "mint_authority_active", "REJECT", "WAIT", "contract", "Malicious minting can dilute supply"],
  ["R004", A, "CRITICAL", "freeze_or_blacklist_capability", "REJECT", "WAIT", "contract", "Privileged account can block or freeze holders"],
  ["R005", A, "CRITICAL", "hidden_transfer_restriction", "REJECT", "WAIT", "contract", "Hidden transfer restriction impairs exits"],
  ["R006", A, "CRITICAL", "nonstandard_launch_program", "REJECT", "WAIT", "contract", "Exploit path can drain pool or holders"],
  ["R007", A, "CRITICAL", "transfer_fee_extension", "REJECT", "WAIT", "contract", "Sell tax can become confiscatory"],
  ["R008", A, "CRITICAL", "nonstandard_launch_program", "REJECT", "WAIT", "contract", "Upgrade can replace trading logic"],
  ["R009", A, "CRITICAL", "transfer_hook_extension", "REJECT", "WAIT", "contract", "Selling requires special permission"],
  ["R010", A, "CRITICAL", "transfer_hook_extension", "REJECT", "WAIT", "contract", "External call can move user funds"],
  ["R011", A, "HIGH", "program_identity_unverified", "WAIT", "WAIT", "contract", "Token program identity unverified"],
  ["R012", A, "HIGH", "unknown_token_extension", "WAIT", "WAIT", "contract", "Token-2022 extensions not fully decoded"],
  // ── B. Liquidity and exit feasibility ──
  ["R013", B, "CRITICAL", "no_live_curve", "REJECT", "WAIT", "liquidity", "No real trading pool or launch mechanism"],
  ["R014", B, "CRITICAL", "exit_liquidity_zero", "REJECT", "WAIT", "liquidity", "Executable sell liquidity effectively zero"],
  ["R015", B, "CRITICAL", "sell_simulation_failed_due_to_restriction", "REJECT", "WAIT", "liquidity", "Sell simulation fails due to a restriction",
    undefined, ["pump_bonding_curve", "pumpswap"], ["simulation_result", "transaction_context", "curve_or_pool_state"]],
  ["R016", B, "CRITICAL", "nonstandard_launch_program", "REJECT", "WAIT", "liquidity", "Creator can withdraw liquidity"],
  ["R017", B, "CRITICAL", "nonstandard_launch_program", "REJECT", "WAIT", "liquidity", "Liquidity sits in a withdrawal trap"],
  ["R018", B, "HIGH", "exit_slippage_above_limit", "REJECT", "WAIT", "liquidity", "Exit exceeds slippage / impact limits", { max_pct: 5 }],
  ["R019", B, "HIGH", "reserves_disagree", "REJECT", "WAIT", "liquidity", "Pool reserves lower than quoted", { max_diff_pct: 50 }],
  ["R020", B, "HIGH", "price_source_invalid", "REJECT", "WAIT", "liquidity", "Price derived from an unusable pool"],
  ["R021", B, "HIGH", "quote_asset_not_sol", "REJECT", "WAIT", "liquidity", "Pair asset cannot be reliably valued"],
  ["R022", B, "HIGH", "round_trip_uneconomic", "REJECT", "WAIT", "liquidity", "Fees and taxes make the exit uneconomic", { max_pct: 8 }],
  ["R023", B, "HIGH", "liquidity_lock_unverified", "WAIT", "WAIT", "liquidity", "Liquidity lock status unverified", undefined, AMM_ONLY],
  ["R024", B, "HIGH", "pool_state_incomplete", "WAIT", "WAIT", "liquidity", "Pool or reserves too new / incomplete"],
  // ── C. Creator, deployer and funding wallets ──
  ["R025", Cw, "HIGH", "deployer_linked_to_operator", "REJECT", "IGNORE", "creator", "Deployer linked to a serial launch operator",
    { max_past_launches: 0, funder_max_deployers: 2, lookback_hours: 72 }],
  ["R026", Cw, "CRITICAL", "creator_rug_history", "REJECT", "IGNORE", "creator", "Creator has a rug-pull pattern"],
  ["R027", Cw, "CRITICAL", "nonstandard_launch_program", "REJECT", "WAIT", "creator", "Creator wallet preparing a liquidity drain"],
  ["R028", Cw, "CRITICAL", "funding_wallet_flagged", "REJECT", "IGNORE", "creator", "Deployer linked to a malicious operation"],
  ["R029", Cw, "HIGH", "creator_funded_buyers", "REJECT", "IGNORE", "holders", "Allocation secretly sent to controlled wallets", { max_pct: 2 }],
  ["R030", Cw, "CRITICAL", "creator_selling_early", "REJECT", "IGNORE", "creator", "Deployer dumping while buys are faked"],
  ["R031", Cw, "CRITICAL", "funding_wallet_flagged", "REJECT", "IGNORE", "creator", "Funding wallet is a known bad actor"],
  ["R032", Cw, "MEDIUM", "creator_share_warning", "WARN", "IGNORE", "creator", "Large privileged creator allocation", { warn_pct: 4, penalty_per_pct: 5 }],
  ["R033", Cw, "MEDIUM", "funding_source_unknown", "WARN", "IGNORE", "creator", "Funding source unknown", undefined, undefined, undefined],
  ["R034", Cw, "HIGH", "creator_history_too_short", "WAIT", "WAIT", "creator", "Creator wallet has too little history", { min_age_hours: 24, min_txs: 10 }],
  ["R035", Cw, "MEDIUM", "wallet_graph_ambiguous", "WAIT", "IGNORE", "holders", "Wallet clustering still ambiguous"],
  ["R036", Cw, "LOW", "offchain_identity_claims", "WAIT", "IGNORE", "creator", "Creator identity claims unverified"],
  // ── D. Early buyers, snipers and clusters ──
  ["R037", D, "HIGH", "linked_buyers_share", "REJECT", "IGNORE", "holders", "Insider wallets hold a prohibited share", { max_pct: 3 }],
  ["R038", D, "HIGH", "cluster_dump_stress", "REJECT", "WAIT", "liquidity", "Linked wallets can overwhelm the exit", { max_loss_pct: 70 }],
  ["R039", D, "CRITICAL", "linked_wallets_selling", "REJECT", "IGNORE", "holders", "Insider cluster coordinating a sell-off"],
  ["R040", D, "CRITICAL", "early_pump_and_dump", "REJECT", "IGNORE", "holders", "Early wallets running a pump-and-dump"],
  ["R041", D, "HIGH", "shared_funder_cluster_share", "REJECT", "IGNORE", "holders", "Tokens spread across wallets to evade checks", { max_pct: 10 }],
  ["R042", D, "HIGH", "linked_wash", "REJECT", "IGNORE", "buyers", "Linked wallets manufacture buying pressure"],
  ["R043", D, "HIGH", "launch_block_snipers_share", "REJECT", "IGNORE", "holders", "Coordinated dominant opening allocation", { max_pct: 15, bundle_ms: 600 }],
  ["R044", D, "HIGH", "wash_trading", "REJECT", "IGNORE", "buyers", "Wash trading fabricates demand", { min_wallets: 2, min_share: 0.4 }],
  ["R045", D, "CRITICAL", "cluster_rug_history", "REJECT", "IGNORE", "holders", "Cluster has a history of trapping buyers"],
  ["R046", D, "HIGH", "holder_distribution_unavailable", "WAIT", "WAIT", "holders", "Holder distribution incomplete"],
  ["R047", D, "HIGH", "funding_graph_unresolved", "WAIT", "WAIT", "creator", "Early-wallet funding graph unresolved"],
  ["R048", D, "MEDIUM", "buyer_independence_uncertain", "WARN", "IGNORE", "buyers", "Buyer independence uncertain", { fresh_frac: 0.5, penalty: 25 }],
  // ── E. Distribution and concentration ──
  ["R049", E, "HIGH", "creator_share_above_limit", "REJECT", "IGNORE", "holders", "Creator allocation above limit", { max_pct: 8 }],
  ["R050", E, "HIGH", "single_holder_above_limit", "REJECT", "IGNORE", "holders", "One holder can destabilise the market", { max_pct: 10 }],
  ["R051", E, "HIGH", "top10_above_limit", "REJECT", "IGNORE", "holders", "Few holders dominate supply", { max_pct: 35 }],
  ["R052", E, "HIGH", "insider_share_above_limit", "REJECT", "IGNORE", "holders", "Insider allocation creates exit risk", { max_pct: 15 }],
  ["R053", E, "MEDIUM", "token_transfer_distribution", "REJECT", "IGNORE", "holders", "Large wallet distributing to a cluster"],
  ["R054", E, "CRITICAL", "supply_mismatch", "REJECT", "WAIT", "contract", "Circulating supply misrepresented"],
  ["R055", E, "CRITICAL", "supply_mismatch", "REJECT", "WAIT", "contract", "Advertised and on-chain supply differ"],
  ["R056", E, "HIGH", "combined_insider_cluster_share", "REJECT", "IGNORE", "holders", "Allocations hide insider concentration", { max_pct: 40 }],
  ["R057", E, "MEDIUM", "balance_classification", "WAIT", "WAIT", "holders", "Pool / burn balances not classified", undefined, AMM_ONLY],
  ["R058", E, "MEDIUM", "holder_data_stale", "WAIT", "IGNORE", "holders", "Holder data stale"],
  ["R059", E, "HIGH", "supply_mismatch", "WAIT", "WAIT", "contract", "Supply changes pending"],
  ["R060", E, "LOW", "holder_aggregation_by_wallet", "WAIT", "IGNORE", "holders", "Concentration double-counts accounts"],
  // ── F. Launch transaction and contract behaviour ──
  ["R061", F, "CRITICAL", "nonstandard_launch_program", "REJECT", "WAIT", "contract", "Malicious instruction in launch transaction"],
  ["R062", F, "CRITICAL", "mint_or_freeze_authority", "REJECT", "WAIT", "contract", "Authority change enables confiscation"],
  ["R063", F, "CRITICAL", "pausable_or_paused", "REJECT", "WAIT", "contract", "Token can be paused"],
  ["R064", F, "CRITICAL", "transfer_fee_extension", "REJECT", "WAIT", "contract", "Hidden transfer fee"],
  ["R065", F, "CRITICAL", "mint_authority_active", "REJECT", "WAIT", "contract", "Creator can alter balances"],
  ["R066", F, "CRITICAL", "permanent_delegate", "REJECT", "WAIT", "contract", "Malicious delegate over holdings"],
  ["R067", F, "CRITICAL", "nonstandard_launch_program", "REJECT", "WAIT", "contract", "Sale proceeds can be redirected"],
  ["R068", F, "HIGH", "nonstandard_launch_program", "REJECT", "WAIT", "contract", "Trading logic differs from what buyers expect"],
  ["R069", F, "CRITICAL", "nonstandard_launch_program", "REJECT", "WAIT", "contract", "Critical vulnerability in execution path"],
  ["R070", F, "CRITICAL", "transfer_hook_extension", "REJECT", "WAIT", "contract", "Callback / hook can block sells"],
  ["R071", F, "HIGH", "program_identity_unverified", "WAIT", "WAIT", "contract", "Program identity cannot be reconciled"],
  ["R072", F, "HIGH", "unknown_token_extension", "WAIT", "WAIT", "contract", "Simulation may omit extensions or hooks"],
  // ── G. Trading quality and market integrity ──
  ["R073", G, "HIGH", "sells_failing", "REJECT", "IGNORE", "liquidity", "Sells consistently fail"],
  ["R074", G, "HIGH", "effective_sell_tax_above_limit", "REJECT", "WAIT", "liquidity", "Effective sell tax above maximum", { max_pct: 8 }],
  ["R075", G, "HIGH", "price_impact_above_limit", "REJECT", "WAIT", "liquidity", "Entry price impact above limit", { max_pct: 5 }],
  ["R076", G, "HIGH", "round_trip_uneconomic", "REJECT", "WAIT", "liquidity", "Round-trip cost unacceptable", { max_pct: 8 }],
  ["R077", G, "MEDIUM", "volume_unreconciled", "REJECT", "IGNORE", "buyers", "Reported volume fabricated"],
  ["R078", G, "HIGH", "wash_trading", "REJECT", "IGNORE", "buyers", "Coordinated wash trading dominates", { min_wallets: 2, min_share: 0.4 }],
  ["R079", G, "HIGH", "cluster_controls_liquidity", "REJECT", "WAIT", "liquidity", "One cluster controls executable liquidity", { max_ratio: 0.8 }],
  ["R080", G, "HIGH", "quote_stale", "REJECT", "WAIT", "liquidity", "Quoted price stale and unrefreshable", { stale_ms: 15000 }],
  ["R081", G, "HIGH", "dump_stress_exit_loss", "REJECT", "WAIT", "liquidity", "Order breaches the loss budget", { max_loss_pct: 60 }],
  ["R082", G, "HIGH", "migration_complete", "REJECT", "WAIT", "liquidity", "Launch mechanism restricts the exit"],
  ["R083", G, "HIGH", "sell_model_unavailable", "WAIT", "WAIT", "liquidity", "Buy/sell simulation missing or stale"],
  ["R084", G, "MEDIUM", "too_few_trades", "MONITOR", "IGNORE", "buyers", "Too few executed trades", { min_trades: 3 }],
  // ── H. Fees, execution and MEV ──
  ["R085", H, "HIGH", "max_tx_cost_above_limit", "REJECT", "IGNORE", "execution", "Max transaction cost breaches hard limit", { max_cost_sol: 0.25 }],
  ["R086", H, "HIGH", "priority_fee_uneconomic", "REJECT", "IGNORE", "execution", "Priority fees make the trade uneconomic", { max_pct: 4 }],
  ["R087", H, "CRITICAL", "tx_guard_at_signing", "REJECT", "WAIT", "execution", "Untrusted router or intermediary", undefined, SIGNING],
  ["R088", H, "CRITICAL", "tx_guard_at_signing", "REJECT", "WAIT", "execution", "Unlimited / unnecessary approval", undefined, SIGNING],
  ["R089", H, "CRITICAL", "tx_guard_at_signing", "REJECT", "WAIT", "execution", "Payload differs from the validated swap", undefined, SIGNING],
  ["R090", H, "HIGH", "round_trip_uneconomic", "REJECT", "WAIT", "execution", "Net exit value below minimum", { max_pct: 8 }],
  ["R091", H, "HIGH", "tx_guard_at_signing", "WAIT", "WAIT", "execution", "Simulation expired", undefined, SIGNING],
  ["R092", H, "HIGH", "tx_guard_at_signing", "WAIT", "WAIT", "execution", "Invalid accounts / blockhash", undefined, SIGNING],
  ["R093", H, "MEDIUM", "network_congestion", "WAIT", "IGNORE", "execution", "Congestion makes timing unpredictable", { max_micro_lamports: 2000000 }],
  ["R094", H, "HIGH", "rpc_lagging", "WAIT", "IGNORE", "execution", "RPC lagging behind the chain", { max_lag_slots: 30 }],
  ["R095", H, "MEDIUM", "price_impact_above_limit", "WAIT", "WAIT", "execution", "Competing transactions moved the quote", { max_pct: 5 }],
  ["R096", H, "HIGH", "fee_slippage_unestimable", "WAIT", "WAIT", "execution", "Fees / worst-case slippage not estimable"],
  // ── I. Market behaviour and launch dynamics ──
  ["R097", I, "CRITICAL", "known_manipulation_link", "REJECT", "IGNORE", "creator", "Linked to a market-manipulation scheme"],
  ["R098", I, "CRITICAL", "creator_cluster_selling", "REJECT", "IGNORE", "holders", "Creator cluster sells into demand"],
  ["R099", I, "HIGH", "early_price_crash", "REJECT", "IGNORE", "liquidity", "Opening pump followed by distribution", { max_drop_pct: 20 }],
  ["R100", I, "HIGH", "price_source_invalid", "REJECT", "WAIT", "liquidity", "Price depends on a manipulated pool"],
  ["R101", I, "HIGH", "insider_unlock", "REJECT", "IGNORE", "holders", "Insider unlock / supply shock", undefined, AMM_ONLY],
  ["R102", I, "CRITICAL", "active_exploit", "REJECT", "IGNORE", "execution", "Active exploit draining the market"],
  ["R103", I, "MEDIUM", "price_swing_high", "WAIT", "IGNORE", "execution", "Price moving too fast for bounded entry", { max_swing_pct: 100 }],
  ["R104", I, "MEDIUM", "too_few_independent_buyers", "MONITOR", "IGNORE", "buyers", "Too few independent buyers", { min_buyers: 3 }],
  ["R105", I, "MEDIUM", "bot_buyers_majority", "WAIT", "IGNORE", "buyers", "First buyers mostly bots / fresh wallets", { fresh_frac: 0.75, dust_frac: 0.6, min_traced: 3 }],
  ["R106", I, "MEDIUM", "price_swing_high", "WAIT", "IGNORE", "execution", "Volatility above entry limit", { max_swing_pct: 100 }],
  ["R107", I, "HIGH", "migration_near", "WAIT", "WAIT", "liquidity", "Pool migrating — venue not final", { real_sol: 70 }],
  ["R108", I, "HIGH", "reserves_disagree", "WAIT", "WAIT", "liquidity", "Sources disagree on reserves / price", { max_diff_pct: 25 }],
  // ── J. Metadata, identity and project integrity ──
  ["R109", J, "CRITICAL", "impersonation", "REJECT", "IGNORE", "contract", "Impersonates an established project"],
  ["R110", J, "HIGH", "impersonation_brand", "REJECT", "IGNORE", "contract", "False identity to induce buyers"],
  ["R111", J, "HIGH", "metadata_malicious_address", "REJECT", "IGNORE", "contract", "Metadata contains a malicious address"],
  ["R112", J, "HIGH", "drainer_link", "REJECT", "IGNORE", "contract", "Official link is a wallet drainer"],
  ["R113", J, "HIGH", "fabricated_audit", "REJECT", "IGNORE", "contract", "Fabricated audit hides a risk"],
  ["R114", J, "CRITICAL", "known_manipulation_link", "REJECT", "IGNORE", "creator", "Linked to verified fraud"],
  ["R115", J, "HIGH", "program_identity_unverified", "WAIT", "WAIT", "contract", "Address not reconciled across sources"],
  ["R116", J, "MEDIUM", "metadata_unavailable", "WAIT", "IGNORE", "contract", "Metadata still changing / unavailable"],
  ["R117", J, "MEDIUM", "audit_claims", "WAIT", "WAIT", "contract", "Audit claims unverifiable", undefined, AMM_ONLY],
  ["R118", J, "MEDIUM", "lock_vesting_claims", "WAIT", "WAIT", "contract", "Lock / vesting claims unverifiable", undefined, AMM_ONLY],
  ["R119", J, "HIGH", "reserves_disagree", "WAIT", "WAIT", "liquidity", "Risk data providers contradict", { max_diff_pct: 25 }],
  ["R120", J, "HIGH", "insufficient_evidence", "WAIT", "WAIT", "execution", "Insufficient evidence for a decision", { min_core: 0.75 }],
  // ── Custom rules (your original brief) ──
  ["X001", J, "HIGH", "relaunch_copycat", "REJECT", "IGNORE", "creator", "Copy or relaunch of a recent coin", { hours: 72 }],
];

export const RULE_DEFS: RuleDef[] = rows.map(([rule_id, category, severity, condition, on_trigger, on_missing, factor, title,
                                               params, applies, evidence]) => ({
  rule_id, version: 1, category, severity, applies_to: applies ?? PUMP, condition,
  evidence_required: evidence ?? [], on_trigger, on_missing_evidence: on_missing, enabled: true, title, factor,
  ...(params ? { params } : {}),
}));
