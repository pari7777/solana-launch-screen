import type { FundingGraph, Risk } from "../graph/risk";
import type { Route } from "../chain/pool";
import type { LaunchEvent, Platform, PoolKey, Quote, RuleOutcome, Venue, WalletTrace } from "../types";

export interface Evidence {
  venue: Venue; stage: number; final: boolean; now: number; ageSec: number;
  launch: LaunchEvent;
  platform: Platform;
  poolKey: PoolKey | null;
  route: Route | null; routeError: string | null;     // launch pool → backing pools → ETH
  onchain: { totalSupply: number | null; decimals: number | null; isContract: boolean } | null;
  onchainError: string | null;
  quote: Quote | null; quoteError: string | null;
  sellReverted: boolean;                // the Quoter could not price a sell at all
  risk: Risk; graph: FundingGraph;
  creatorTrace: WalletTrace | null; creatorTraceError: string | null;
  senderIsPlatform: boolean;            // msgSender is a busy service (Clanker bot / frontend), not the creator
  creatorIsPlatform: boolean;           // the only known "creator" is a platform deployer (e.g. Bankr via Doppler): real creator not on-chain
  buyerTracesNeeded: number; buyerTracesDone: number;
  history: { rugger: string | null; prior: { mint: string; decision: string }[]; copycat: boolean; funderFlag: string | null; funderLaunches: number };
  poolEth: number;                      // ETH that traders put into the pool (net buys − sells)
  market: { ethUsd: number | null; streamOk: boolean; headLagBlocks: number | null };
}

export type Params = Record<string, number>;
export interface Evaluator { requires: string[]; fn: (ev: Evidence, p: Params) => RuleOutcome }
export const trig = (text: string, evidence: Record<string, unknown>): RuleOutcome => ({ status: "TRIGGERED", text, evidence });
export const pass = (text: string, evidence: Record<string, unknown> = {}): RuleOutcome => ({ status: "PASS", text, evidence });
export const missing = (what: string[], text = "required evidence not available yet"): RuleOutcome => ({ status: "MISSING", text, evidence: {}, missing: what });
