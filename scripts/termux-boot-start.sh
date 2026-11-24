#!/data/data/com.termux/files/usr/bin/sh
set -eu

APP_DIR="$HOME/sb-power-app"
LOG_DIR="$HOME/.local/share/sb-power"
BOOT_LOG="$LOG_DIR/termux-boot.log"
mkdir -p "$LOG_DIR" "$HOME/.termux/boot"
exec >> "$BOOT_LOG" 2>&1

echo "$(date -Is) Termux boot start requested."
if command -v termux-wake-lock >/dev/null 2>&1; then
  termux-wake-lock >/dev/null 2>&1 || true
fi

if ! command -v proot-distro >/dev/null 2>&1; then
  echo 'proot-distro is not installed; PM2 was not started.'
  exit 1
fi

network_attempt=0
while [ "$network_attempt" -lt 60 ]; do
  if command -v curl >/dev/null 2>&1 && curl -fsS --max-time 5 https://www.google.com/generate_204 >/dev/null 2>&1; then
    echo 'Internet connection is available.'
    break
  fi
  network_attempt=$((network_attempt + 1))
  sleep 5
done

if [ "$network_attempt" -ge 60 ]; then
  echo 'Network did not become reachable in five minutes; starting PM2 so it can retry when connectivity returns.'
fi

proot-distro login --shared-home debian -- bash -lc '
  cd /root/sb-power-app
  mkdir -p logs
  if ! ./node_modules/.bin/pm2 resurrect; then
    ./node_modules/.bin/pm2 start ecosystem.config.js --update-env
  fi
  ./node_modules/.bin/pm2 save
'
echo "$(date -Is) PM2 boot recovery finished."
