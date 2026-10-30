/** Contract, token-permission, program-identity and metadata evaluators. */
import { EXT, SAFE_EXTENSIONS, TOKEN_2022, TOKEN_PROGRAM } from "../data/accounts";
import { bondingCurvePda, DECIMALS, TOTAL_SUPPLY } from "../decoders/bonding-curve";
import { PUMP_PROGRAM } from "../decoders/pump-launch";
import { type Evaluator, type Evidence, missing, pass, trig } from "./helpers";

const BIG_TOKENS = new Set(["sol", "wsol", "usdc", "usdt", "btc", "wbtc", "eth", "weth", "bonk", "wif", "jup", "pyth", "ray", "jto",
  "trump", "melania", "popcat", "pengu", "fartcoin", "pump", "render", "bnb", "xrp", "doge", "shib", "pepe", "msol", "jitosol",
  "bome", "mew", "goat", "pnut", "ai16z", "griffain", "zerebro", "moodeng"]);
const BRANDS = ["solana", "binance", "coinbase", "tether", "circle", "phantom", "jupiter", "raydium", "pump.fun", "pumpfun",
  "openai", "tesla", "spacex", "elon musk", "official"];

const SELL_BLOCKING = new Set<number>([EXT.NonTransferable, EXT.TransferHook, EXT.Pausable, EXT.DefaultAccountState]);
const KNOWN = new Set<number>([1, 3, 4, 6, 9, 10, 12, 14, 16, 18, 19, 20, 21, 22, 23, 24, 25, 26]);

const needContract = (ev: Evidence) => (ev.contract ? null : missing(["contract_accounts"], `token accounts not readable (${ev.contractError ?? "pending"})`));
const tokenProgram = (ev: Evidence) => ev.contract!.mint.owner === TOKEN_2022 ? "Token-2022" : ev.contract!.mint.owner === TOKEN_PROGRAM ? "SPL Token" : ev.contract!.mint.owner;
const ext = (ev: Evidence, types: number[]) => (ev.activeExtensions ?? []).filter((e) => types.includes(e.type));

function extRule(types: number[], what: string): Evaluator {
  return { requires: ["token_extensions"], fn: (ev) => {
    const m = needContract(ev); if (m) return m;
    const hit = ext(ev, types);
    return hit.length ? trig(`Token-2022 ${what}: ${hit.map((h) => h.name + (h.detail ? ` (${h.detail})` : "")).join(", ")}`,
                             { token_extensions: hit, token_program: tokenProgram(ev) })
                      : pass(`no ${what}`, { token_program: tokenProgram(ev) });
  } };
}

export const sellRestrictions = (ev: Evidence) => {
  const out: string[] = [];
  if (ev.contract?.mint.freezeAuthority) out.push("freeze authority");
  for (const e of ev.activeExtensions ?? []) if (SELL_BLOCKING.has(e.type) || e.type === EXT.PermanentDelegate) out.push(e.name);
  return out;
};

const unobservable = (label: string, why: string): Evaluator =>
  ({ requires: [label], fn: () => missing([label], why) });

export const contractEvaluators: Record<string, Evaluator> = {
  sell_blocking_restriction: { requires: ["token_permissions"], fn: (ev) => {
    const m = needContract(ev); if (m) return m;
    const r = sellRestrictions(ev).filter((x) => x !== "PermanentDelegate");
    return r.length ? trig(`selling can be blocked: ${r.join(", ")}`, { token_permissions: r }) : pass("no sell-blocking permission");
  } },
  permanent_delegate: extRule([EXT.PermanentDelegate], "permanent delegate (can take tokens from any holder)"),
  transfer_fee_extension: extRule([EXT.TransferFeeConfig, EXT.ConfidentialTransferFeeConfig], "transfer fee"),
  transfer_hook_extension: extRule([EXT.TransferHook], "transfer hook (custom code runs on every transfer)"),
  pausable_or_paused: extRule([EXT.Pausable], "pausable transfers"),
  hidden_transfer_restriction: extRule([EXT.NonTransferable, EXT.TransferHook, EXT.DefaultAccountState, EXT.Pausable,
                                        EXT.ConfidentialTransferMint, EXT.ConfidentialMintBurn], "transfer restriction"),
  mint_authority_active: { requires: ["mint_authority"], fn: (ev) => {
    const m = needContract(ev); if (m) return m;
    return ev.contract!.mint.mintAuthority ? trig("mint authority still active — more tokens can be printed", { mint_authority: true })
                                           : pass("mint authority revoked");
  } },
  freeze_or_blacklist_capability: { requires: ["freeze_authority"], fn: (ev) => {
    const m = needContract(ev); if (m) return m;
    const frozen = ext(ev, [EXT.DefaultAccountState]).length > 0;
    return ev.contract!.mint.freezeAuthority || frozen
      ? trig(ev.contract!.mint.freezeAuthority ? "freeze authority active — holders can be frozen" : "new holder accounts start frozen",
             { freeze_authority: ev.contract!.mint.freezeAuthority, default_frozen: frozen })
      : pass("freeze authority revoked");
  } },
  mint_or_freeze_authority: { requires: ["mint_authority", "freeze_authority"], fn: (ev) => {
    const m = needContract(ev); if (m) return m;
    const { mintAuthority, freezeAuthority } = ev.contract!.mint;
    return mintAuthority || freezeAuthority
      ? trig(`privileged authority retained: ${[mintAuthority && "mint", freezeAuthority && "freeze"].filter(Boolean).join(" + ")}`,
             { mint_authority: mintAuthority, freeze_authority: freezeAuthority })
      : pass("mint and freeze authorities revoked");
  } },
  nonstandard_launch_program: { requires: ["mint_owner", "curve_owner"], fn: (ev) => {
    const m = needContract(ev); if (m) return m;
    const { mint, curve } = ev.contract!;
    const okMint = mint.owner === TOKEN_PROGRAM || mint.owner === TOKEN_2022, okCurve = curve.owner === PUMP_PROGRAM;
    return okMint && okCurve
      ? pass("standard pump.fun curve program and SPL token program (no owner functions, no LP withdrawal, fixed logic)",
             { mint_owner: mint.owner, curve_owner: curve.owner })
      : trig(`non-standard program: ${!okMint ? `mint owned by ${mint.owner}` : ""} ${!okCurve ? `curve owned by ${curve.owner}` : ""}`.trim(),
             { mint_owner: mint.owner, curve_owner: curve.owner });
  } },
  program_identity_unverified: { requires: ["mint_owner", "curve_address"], fn: (ev) => {
    const m = needContract(ev); if (m) return m;
    const derived = bondingCurvePda(ev.launch.mint);
    if (ev.launch.bondingCurve && ev.launch.bondingCurve !== derived)
      return trig(`launch event curve ${ev.launch.bondingCurve} ≠ derived curve ${derived}`, { mint_owner: ev.contract!.mint.owner, curve_address: derived });
    return pass("mint and curve addresses reconcile with the launch event", { mint_owner: ev.contract!.mint.owner, curve_address: derived });
  } },
  unknown_token_extension: { requires: ["token_extensions"], fn: (ev) => {
    const m = needContract(ev); if (m) return m;
    const unknown = ev.contract!.mint.extensions.filter((e) => !KNOWN.has(e.type));
    return unknown.length ? trig(`unrecognised Token-2022 extension type(s) ${unknown.map((u) => u.type).join(", ")}`, { token_extensions: unknown.map((u) => u.type) })
                          : pass(`all extensions decoded (${ev.contract!.mint.extensions.filter((e) => !SAFE_EXTENSIONS.has(e.type)).length} non-metadata)`);
  } },
  supply_mismatch: { requires: ["onchain_supply"], fn: (ev) => {
    const m = needContract(ev); if (m) return m;
    const { supplyRaw, decimals } = ev.contract!.mint;
    const supply = Number(supplyRaw) / 10 ** decimals;
    return supply !== TOTAL_SUPPLY || decimals !== DECIMALS
      ? trig(`on-chain supply ${supply.toLocaleString()} (decimals ${decimals}) ≠ standard 1,000,000,000`, { onchain_supply: supply, decimals })
      : pass("standard 1,000,000,000 supply, 6 decimals", { onchain_supply: supply });
  } },
  quote_asset_not_sol: { requires: ["curve_owner"], fn: (ev) => {
    const m = needContract(ev); if (m) return m;
    return ev.contract!.curve.owner === PUMP_PROGRAM ? pass("priced in SOL on the pump.fun curve", { curve_owner: PUMP_PROGRAM })
                                                     : trig("curve not owned by pump.fun — quote asset unknown", { curve_owner: ev.contract!.curve.owner });
  } },
  impersonation: { requires: ["symbol"], fn: (ev) => {
    const s = ev.launch.symbol.trim().toLowerCase().replace(/^\$/, "");
    return BIG_TOKENS.has(s) ? trig(`symbol $${ev.launch.symbol} imitates an established token`, { symbol: ev.launch.symbol })
                             : pass("symbol not an established token");
  } },
  impersonation_brand: { requires: ["name"], fn: (ev) => {
    const n = ev.launch.name.toLowerCase(); const b = BRANDS.find((x) => n.includes(x));
    return b ? trig(`name "${ev.launch.name}" claims a brand/official identity ("${b}")`, { name: ev.launch.name, brand: b })
             : pass("no brand or 'official' claim in name");
  } },
  relaunch_copycat: { requires: ["matching_launch"], fn: (ev) =>
    ev.history.copycat ? trig("same name or symbol launched recently (copy / relaunch)", { matching_launch: true }) : pass("first coin with this name and symbol") },
  metadata_unavailable: { requires: ["token_metadata"], fn: (ev) => {
    if (!ev.metadata.checked || ev.metadata.ok === null) return missing(["token_metadata"], "metadata not checked (CHECK_METADATA=false) or not loaded");
    return ev.metadata.ok ? pass("metadata loaded with socials") : trig("metadata unavailable or has no website / X / Telegram", { token_metadata: false });
  } },
  offchain_identity_claims: unobservable("offchain_identity", "identity claims need off-chain verification"),
  metadata_malicious_address: unobservable("metadata_links", "metadata address screening not available within 6 s"),
  drainer_link: unobservable("metadata_links", "link screening needs an external phishing feed"),
  fabricated_audit: unobservable("audit_reports", "audits do not exist for pump.fun launches"),
  audit_claims: unobservable("audit_reports", "audit verification needs external reports"),
  lock_vesting_claims: unobservable("vesting_schedule", "vesting claims need external verification"),
};
