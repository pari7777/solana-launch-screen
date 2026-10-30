/** Local bot wallet (keypair mode). The key never leaves this laptop. */
import fs from "node:fs";
import bs58 from "bs58";
import { Keypair } from "@solana/web3.js";
import { config } from "../config";

export function loadKeypair(): Keypair {
  if (config.botPrivateKey) return Keypair.fromSecretKey(bs58.decode(config.botPrivateKey));
  if (fs.existsSync(config.keypairPath)) {
    const arr = JSON.parse(fs.readFileSync(config.keypairPath, "utf8"));
    return Keypair.fromSecretKey(Uint8Array.from(arr));
  }
  throw new Error(`No bot wallet: run "npm run wallet:new" (creates ${config.keypairPath}) or set BOT_PRIVATE_KEY in .env`);
}

export function createKeypairFile(path = config.keypairPath) {
  if (fs.existsSync(path)) throw new Error(`${path} already exists — not overwriting it`);
  const kp = Keypair.generate();
  fs.writeFileSync(path, JSON.stringify(Array.from(kp.secretKey)), { mode: 0o600 });
  return kp.publicKey.toBase58();
}
