import { parseAbi, parseAbiItem } from "viem";

/** Clanker v4 factory event (from clanker-devco/v4-contracts IClanker.sol). */
export const TOKEN_CREATED = parseAbiItem(
  "event TokenCreated(address msgSender, address indexed tokenAddress, address indexed tokenAdmin, string tokenImage, string tokenName, string tokenSymbol, string tokenMetadata, string tokenContext, int24 startingTick, address poolHook, bytes32 poolId, address pairedToken, address locker, address mevModule, uint256 extensionsSupply, address[] extensions)");

export const TRANSFER = parseAbiItem("event Transfer(address indexed from, address indexed to, uint256 value)");

/** Uniswap v4 PoolManager swap event. */
export const SWAP = parseAbiItem(
  "event Swap(bytes32 indexed id, address indexed sender, int128 amount0, int128 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick, uint24 fee)");

export const QUOTER_ABI = [{
  type: "function", name: "quoteExactInputSingle", stateMutability: "nonpayable",
  inputs: [{ name: "params", type: "tuple", components: [
    { name: "poolKey", type: "tuple", components: [
      { name: "currency0", type: "address" }, { name: "currency1", type: "address" }, { name: "fee", type: "uint24" },
      { name: "tickSpacing", type: "int24" }, { name: "hooks", type: "address" }] },
    { name: "zeroForOne", type: "bool" }, { name: "exactAmount", type: "uint128" }, { name: "hookData", type: "bytes" }] }],
  outputs: [{ name: "amountOut", type: "uint256" }, { name: "gasEstimate", type: "uint256" }],
}] as const;

export const ERC20_ABI = parseAbi([
  "function totalSupply() view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function balanceOf(address) view returns (uint256)",
  "function admin() view returns (address)",
]);

/** Uniswap v4 PoolManager pool creation — gives the full pool key for Flaunch and Doppler launches. */
export const INITIALIZE = parseAbiItem(
  "event Initialize(bytes32 indexed id, address indexed currency0, address indexed currency1, uint24 fee, int24 tickSpacing, address hooks, uint160 sqrtPriceX96, int24 tick)");

const POOL_KEY_T = "(address currency0, address currency1, uint24 fee, int24 tickSpacing, address hooks)";
/** Zora coin factory (docs.zora.co/coins/contracts/factory). */
export const ZORA_COIN_CREATED = parseAbiItem(
  `event CoinCreatedV4(address indexed caller, address indexed payoutRecipient, address indexed platformReferrer, address currency, string uri, string name, string symbol, address coin, ${POOL_KEY_T} poolKey, bytes32 poolKeyHash, string version)`);
export const ZORA_CREATOR_COIN_CREATED = parseAbiItem(
  `event CreatorCoinCreated(address indexed caller, address indexed payoutRecipient, address indexed platformReferrer, address currency, string uri, string name, string symbol, address coin, ${POOL_KEY_T} poolKey, bytes32 poolKeyHash, string version)`);
export const ZORA_COIN_ABI = parseAbi([`function getPoolKey() view returns ${POOL_KEY_T}`, "function currency() view returns (address)"]);

/** Flaunch PositionManager launch event (@flaunch/sdk FlaunchPositionManager ABI). */
export const FLAUNCH_POOL_CREATED = parseAbiItem(
  "event PoolCreated(bytes32 indexed _poolId, address _memecoin, address _memecoinTreasury, uint256 _tokenId, bool _currencyFlipped, uint256 _flaunchFee, (string name, string symbol, string tokenUri, uint256 initialTokenFairLaunch, uint256 premineAmount, address creator, uint24 creatorFeeAllocation, uint256 flaunchAt, bytes initialPriceParams, bytes feeCalculatorParams) _params)");

/** Doppler Airlock (@whetstone-research/doppler-sdk Airlock ABI). Used by Bankr and other launchpads. */
export const DOPPLER_CREATE = parseAbiItem("event Create(address asset, address indexed numeraire, address initializer, address poolOrHook)");

export const ERC20_META = parseAbi(["function name() view returns (string)", "function symbol() view returns (string)"]);

/** Uniswap v3 QuoterV2 — used only to price a backing token (e.g. ZORA) in ETH. */
export const V3_QUOTER_ABI = [{
  type: "function", name: "quoteExactInputSingle", stateMutability: "nonpayable",
  inputs: [{ name: "params", type: "tuple", components: [
    { name: "tokenIn", type: "address" }, { name: "tokenOut", type: "address" }, { name: "amountIn", type: "uint256" },
    { name: "fee", type: "uint24" }, { name: "sqrtPriceLimitX96", type: "uint160" }] }],
  outputs: [{ name: "amountOut", type: "uint256" }, { name: "sqrtPriceX96After", type: "uint160" },
            { name: "initializedTicksCrossed", type: "uint32" }, { name: "gasEstimate", type: "uint256" }],
}] as const;
