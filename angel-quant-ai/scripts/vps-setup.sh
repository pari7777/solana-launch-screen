#!/usr/bin/env bash
# One-time setup on a fresh Ubuntu 22.04/24.04 server (AWS Lightsail Mumbai, DigitalOcean Bangalore, …).
#   curl -fsSL https://raw.githubusercontent.com/pari7777/solana-launch-screen/main/angel-quant-ai/scripts/vps-setup.sh | sudo bash
# It installs Docker, downloads the bot, asks for your secrets (typed here, stored only on this server, never in GitHub),
# starts the bot with HTTPS, and installs the auto-updater (pulls new code from GitHub OUTSIDE market hours only).
set -euo pipefail
REPO=${REPO:-https://github.com/pari7777/solana-launch-screen.git}
DIR=/opt/angel-quant
APP=$DIR/angel-quant-ai
[ "$(id -u)" = 0 ] || { echo "run with sudo"; exit 1; }

echo "== 1/5 installing Docker and git"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq && apt-get install -y -qq git curl ca-certificates >/dev/null
command -v docker >/dev/null || curl -fsSL https://get.docker.com | sh >/dev/null
timedatectl set-timezone Asia/Kolkata || true

echo "== 2/5 downloading the bot"
if [ -d "$DIR/.git" ]; then git -C "$DIR" pull -q; else git clone -q --depth 50 "$REPO" "$DIR"; fi

IP=$(curl -fsS --max-time 5 https://checkip.amazonaws.com || curl -fsS --max-time 5 https://api.ipify.org)
echo "   this server's public IP: $IP   ← register THIS IP in your SmartAPI app"

echo "== 3/5 secrets (typing is hidden; press Enter to keep an existing value)"
ENV=$APP/.env
touch "$ENV"; chmod 600 "$ENV"
setv() { local k=$1 v=$2; grep -v "^$k=" "$ENV" > "$ENV.tmp" || true; echo "$k=$v" >> "$ENV.tmp"; mv "$ENV.tmp" "$ENV"; chmod 600 "$ENV"; }
ask() {  # ask KEY "prompt" secret?
  local cur; cur=$(grep "^$1=" "$ENV" | cut -d= -f2- || true)
  local v
  if [ "${3:-}" = secret ]; then read -r -s -p "   $2${cur:+ [saved]}: " v </dev/tty; echo; else read -r -p "   $2${cur:+ [$cur]}: " v </dev/tty; fi
  [ -n "$v" ] && setv "$1" "$v" || true
}
ask ANGEL_API_KEY "Angel One SmartAPI API key" secret
ask ANGEL_CLIENT_CODE "Angel One client ID"
ask ANGEL_MPIN "Angel One MPIN" secret
ask ANGEL_TOTP_SECRET "TOTP secret (text key under the QR code)" secret
ask ANTHROPIC_API_KEY "Anthropic API key for Claude (optional, Enter to skip)" secret
grep -q "^DASHBOARD_PASSWORD=" "$ENV" || setv DASHBOARD_PASSWORD "$(tr -dc 'A-HJ-NP-Za-km-z2-9' </dev/urandom | head -c 14)"
grep -q "^TRADING_MODE=" "$ENV" || { setv TRADING_MODE paper; setv LIVE_TRADING_CONFIRM NO; setv STATIC_IP_REGISTERED false; }
setv CLIENT_PUBLIC_IP "$IP"
setv DOMAIN "$(echo "$IP" | tr . -).sslip.io"

echo "== 4/5 starting (first build takes 2–4 minutes)"
cd "$APP" && docker compose up -d --build

echo "== 5/5 auto-updater"
install -m 755 "$APP/scripts/vps-update.sh" /usr/local/bin/aq-update
cat > /etc/systemd/system/aq-update.service <<UNIT
[Unit]
Description=Angel Quant AI — pull and redeploy new code (outside market hours only)
[Service]
Type=oneshot
ExecStart=/usr/local/bin/aq-update
UNIT
cat > /etc/systemd/system/aq-update.timer <<UNIT
[Unit]
Description=Check GitHub for Angel Quant AI updates every 5 minutes
[Timer]
OnBootSec=2min
OnUnitActiveSec=5min
[Install]
WantedBy=timers.target
UNIT
systemctl daemon-reload && systemctl enable --now aq-update.timer >/dev/null

PW=$(grep "^DASHBOARD_PASSWORD=" "$ENV" | cut -d= -f2-)
echo
echo "Done. Dashboard: https://$(echo "$IP" | tr . -).sslip.io   (username: anything, password: $PW)"
echo "Register this static IP in your SmartAPI app: $IP"
echo "Logs: cd $APP && docker compose logs -f bot"
