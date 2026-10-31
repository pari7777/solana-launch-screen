#!/usr/bin/env bash
# Pull new code from GitHub and redeploy — but never while the market is open (09:00–15:40 IST, Mon–Fri),
# because a restart during the session would interrupt position management. Run with FORCE=1 to override.
set -euo pipefail
DIR=/opt/angel-quant
APP=$DIR/angel-quant-ai
cd "$DIR"
git fetch -q origin main
LOCAL=$(git rev-parse HEAD); REMOTE=$(git rev-parse origin/main)
[ "$LOCAL" = "$REMOTE" ] && exit 0
if ! git diff --quiet "$LOCAL" "$REMOTE" -- angel-quant-ai; then CHANGED=1; else CHANGED=0; fi
DOW=$(TZ=Asia/Kolkata date +%u); HM=$(TZ=Asia/Kolkata date +%H%M)
if [ "${FORCE:-0}" != 1 ] && [ "$CHANGED" = 1 ] && [ "$DOW" -le 5 ] && [ "$HM" -ge 0900 ] && [ "$HM" -le 1540 ]; then
  echo "update waiting: market hours"; exit 0
fi
git merge -q --ff-only origin/main
if [ "$CHANGED" = 1 ]; then
  cd "$APP" && docker compose up -d --build
  logger -t aq-update "deployed $(git -C "$DIR" rev-parse --short HEAD)"
fi
