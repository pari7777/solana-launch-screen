#!/bin/sh
# Owner's on/off switch: BOT_STOPPED=1 in Railway variables keeps the bot OFF (only a tiny "stopped" page answers /health).
if [ "$BOT_STOPPED" = "1" ]; then
  echo "Bot is switched OFF (BOT_STOPPED=1). Set BOT_STOPPED=0 in Railway to start it again."
  exec node -e "require('http').createServer((q,s)=>s.end('Bot stopped by owner')).listen(process.env.PORT||8080)"
fi
exec npm start
