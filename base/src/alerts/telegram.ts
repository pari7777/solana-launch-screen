/** Telegram alerts (optional): set TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID in .env. */
import { config } from "../config";

export async function telegram(text: string) {
  if (!config.telegramToken || !config.telegramChat) return;
  try {
    await fetch(`https://api.telegram.org/bot${config.telegramToken}/sendMessage`, {
      method: "POST", headers: { "content-type": "application/json" }, signal: AbortSignal.timeout(8000),
      body: JSON.stringify({ chat_id: config.telegramChat, text, disable_web_page_preview: true }),
    });
  } catch (e) { console.error("telegram:", (e as Error).message); }
}

export async function webhook(payload: unknown) {
  if (!config.webhookUrl) return;
  try {
    const r = await fetch(config.webhookUrl, { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify(payload), signal: AbortSignal.timeout(8000) });
    if (!r.ok) console.error(`webhook returned ${r.status}`);
  } catch (e) { console.error("webhook:", (e as Error).message); }
}
