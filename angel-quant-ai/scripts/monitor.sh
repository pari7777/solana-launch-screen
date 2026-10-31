#!/usr/bin/env sh
# Health probe for a VPS deployment (cron every minute). Restarts the container if /health stops answering.
URL=${URL:-http://127.0.0.1:8000/health}
if ! curl -fsS --max-time 5 "$URL" >/dev/null; then
  echo "$(date) health check failed — restarting bot" >&2
  docker compose restart bot
fi
