/**
 * Launch sources on Base. Each one turns its factory's launch log into a LaunchEvent.
 *   clanker  Clanker v4 factory TokenCreated            pool key rebuilt from the pool id
 *   zora     Zora factory CoinCreatedV4 / CreatorCoin   pool key is in the event
 *   flaunch  Flaunch PositionManager PoolCreated        pool key from PoolManager.Initialize (same tx)
 *   doppler  Doppler Airlock Create (Bankr and others)  pool key from PoolManager.Initialize (same tx); v3 launches are skipped
 */
import type { AbiEvent } from "viem";
import { ADDR, config, PLATFORM_ADDR, ZERO } from "../config";
import type { Hex, LaunchEvent, Platform } from "../types";
import { DOPPLER_CREATE, FLAUNCH_POOL_CREATED, TOKEN_CREATED, ZORA_COIN_CREATED, ZORA_CREATOR_COIN_CREATED } from "./abi";
import { poolId, recoverPoolKey } from "./pool";

const Z = ZERO as Hex;
export interface Source { platform: Platform; address: Hex | Hex[]; event: AbiEvent; decode: (log: any, at: number) => LaunchEvent | null }

const base = (platform: Platform, log: any, at: number) => ({
  platform, signature: log.transactionHash as string, instructionIndex: Number(log.logIndex), slot: Number(log.blockNumber),
  receivedAt: Date.now(), blockTime: Math.floor(at / 1000), image: "", metadata: "", context: "", startingTick: 0,
  locker: Z, mevModule: Z, extensionsSupply: 0n, extensions: [] as Hex[],
});

const clanker: Source = {
  platform: "clanker", address: ADDR.clankerFactory as Hex, event: TOKEN_CREATED as AbiEvent,
  decode: (log, at) => {
    const a = log.args; if (!a?.tokenAddress) return null;
    return { ...base("clanker", log, at),
      token: a.tokenAddress, creator: a.tokenAdmin, sender: a.msgSender, name: a.tokenName ?? "", symbol: a.tokenSymbol ?? "",
      image: a.tokenImage ?? "", metadata: a.tokenMetadata ?? "", context: a.tokenContext ?? "", startingTick: Number(a.startingTick),
      hook: a.poolHook, poolId: a.poolId, pairedToken: a.pairedToken, locker: a.locker, mevModule: a.mevModule,
      extensionsSupply: a.extensionsSupply ?? 0n, extensions: a.extensions ?? [],
      poolKey: recoverPoolKey(a.tokenAddress, a.pairedToken, a.poolHook, a.poolId) };
  },
};

const zoraDecode = (log: any, at: number): LaunchEvent | null => {
  const a = log.args; if (!a?.coin || !a.poolKey) return null;
  const key = { currency0: a.poolKey.currency0, currency1: a.poolKey.currency1, fee: Number(a.poolKey.fee), tickSpacing: Number(a.poolKey.tickSpacing), hooks: a.poolKey.hooks };
  return { ...base("zora", log, at),
    token: a.coin, creator: a.payoutRecipient, sender: a.caller, name: a.name ?? "", symbol: a.symbol ?? "", metadata: a.uri ?? "",
    context: log.eventName === "CreatorCoinCreated" ? "creator coin" : "content coin",
    hook: key.hooks, poolId: a.poolKeyHash ?? poolId(key), pairedToken: a.currency, poolKey: key };
};
const zora: Source = { platform: "zora", address: PLATFORM_ADDR.zoraFactory as Hex, event: ZORA_COIN_CREATED as AbiEvent, decode: zoraDecode };
const zoraCreator: Source = { platform: "zora", address: PLATFORM_ADDR.zoraFactory as Hex, event: ZORA_CREATOR_COIN_CREATED as AbiEvent, decode: zoraDecode };

const flaunch: Source = {
  platform: "flaunch", address: PLATFORM_ADDR.flaunchPositionManagers as Hex[], event: FLAUNCH_POOL_CREATED as AbiEvent,
  decode: (log, at) => {
    const a = log.args; if (!a?._memecoin) return null;
    const p = a._params ?? {};
    return { ...base("flaunch", log, at),
      token: a._memecoin, creator: p.creator ?? Z, sender: p.creator ?? Z, name: p.name ?? "", symbol: p.symbol ?? "", metadata: p.tokenUri ?? "",
      context: Number(p.flaunchAt ?? 0) * 1000 > Date.now() ? "scheduled launch" : "",
      hook: log.address, poolId: a._poolId, pairedToken: PLATFORM_ADDR.flETH as Hex, locker: log.address, poolKey: null,
      extensionsSupply: BigInt(p.premineAmount ?? 0n) };          // premine = tokens the creator bought at launch
  },
};

const doppler: Source = {
  platform: "doppler", address: PLATFORM_ADDR.dopplerAirlock as Hex, event: DOPPLER_CREATE as AbiEvent,
  decode: (log, at) => {
    const a = log.args; if (!a?.asset) return null;
    return { ...base("doppler", log, at),
      token: a.asset, creator: Z, sender: Z, name: "", symbol: "",              // filled in by the watcher (tx sender, token metadata)
      context: a.initializer, hook: a.poolOrHook, platformHook: a.poolOrHook, poolId: Z as Hex, pairedToken: a.numeraire, locker: a.initializer, poolKey: null };
  },
};

const ALL: Record<Platform, Source[]> = { clanker: [clanker], zora: [zora, zoraCreator], flaunch: [flaunch], doppler: [doppler] };
export const SOURCES: Source[] = (Object.keys(ALL) as Platform[]).filter((p) => config.platforms.includes(p)).flatMap((p) => ALL[p]);
