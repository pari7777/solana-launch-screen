/** npm run wallet:new — creates a NEW, separate bot wallet file for keypair mode. */
import { config } from "../src/config";
import { createKeypairFile } from "../src/trade/wallet";

try {
  const pub = createKeypairFile();
  console.log(`\n✅ New bot wallet created: ${config.keypairPath}`);
  console.log(`   Address: ${pub}\n`);
  console.log("   1. Send it only what you can afford to lose (e.g. 0.3 SOL) from Phantom / an exchange.");
  console.log("   2. In .env set MODE=keypair and CONFIRM_LIVE=YES when you are ready to trade for real.");
  console.log(`   3. Back up ${config.keypairPath} somewhere safe and NEVER share or upload it.\n`);
} catch (e) {
  console.error(`\n✗ ${(e as Error).message}\n`); process.exit(1);
}
