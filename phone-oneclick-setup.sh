#!/usr/bin/env bash
# ============================================================
# SB Furniture & SB POWER - Phone Server One-Click Installer
# Designed for Termux on Android
# ============================================================

set -euo pipefail

echo "=========================================="
echo " SB Furniture & Power - Phone Server Setup "
echo "=========================================="

# 1. Ensure required Termux packages
echo "[1/6] Installing system packages..."
pkg update -y
pkg install -y nodejs-lts python make clang curl termux-api

# 2. Check or install cloudflared
echo "[2/6] Checking cloudflared..."
if ! command -v cloudflared >/dev/null 2>&1; then
  echo "Installing cloudflared via pkg..."
  pkg install -y cloudflared || {
    echo "Downloading cloudflared binary..."
    ARCH="$(uname -m)"
    case "$ARCH" in
      aarch64|arm64) CF_ARCH="arm64" ;;
      armv7l|armv8l) CF_ARCH="arm" ;;
      x86_64|amd64) CF_ARCH="amd64" ;;
      *) echo "Unsupported architecture: $ARCH" >&2; exit 1 ;;
    esac
    curl -fsSL "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-${CF_ARCH}" -o "$PREFIX/bin/cloudflared"
    chmod +x "$PREFIX/bin/cloudflared"
  }
fi

# 3. Check or install PM2 globally
echo "[3/6] Checking PM2..."
if ! command -v pm2 >/dev/null 2>&1; then
  echo "Installing PM2 globally..."
  npm install -g pm2
fi

# 4. App Directory & Config
echo "[4/6] Setting up project environment..."
APP_DIR="$HOME/sb-power-app"
mkdir -p "$APP_DIR/data" "$APP_DIR/logs" "$HOME/.config/sb-power" "$HOME/.termux/boot"

cd "$APP_DIR"

if [ ! -f "package.json" ]; then
  echo "Error: $APP_DIR/package.json not found." >&2
  echo "Please transfer sb-power-phone-server.tar.gz and extract to $APP_DIR first." >&2
  exit 1
fi

echo "Installing Node.js dependencies..."
npm install --omit=dev

# 5. Termux Boot Script
echo "[5/6] Setting up auto-boot script..."
cat << 'BOOT_EOF' > "$HOME/.termux/boot/sb-power-boot.sh"
#!/data/data/com.termux/files/usr/bin/sh
set -eu
APP_DIR="$HOME/sb-power-app"
LOG_DIR="$HOME/.local/share/sb-power"
mkdir -p "$LOG_DIR"
exec >> "$LOG_DIR/termux-boot.log" 2>&1

echo "$(date -Is) Auto-boot triggered."
command -v termux-wake-lock >/dev/null 2>&1 && termux-wake-lock || true

cd "$APP_DIR"
pm2 resurrect || npm run pm2:start
pm2 save
BOOT_EOF
chmod 700 "$HOME/.termux/boot/sb-power-boot.sh"

# 6. PM2 Start & Logrotate
echo "[6/6] Starting server and watchdog with PM2..."
pm2 install pm2-logrotate || true
pm2 set pm2-logrotate:max_size 10M || true
pm2 set pm2-logrotate:retain 5 || true
pm2 set pm2-logrotate:compress true || true

npm run pm2:start
pm2 save

echo ""
echo "=========================================="
echo " Setup complete! Server is running in PM2."
echo " Check status with: pm2 status"
echo " View logs with:    pm2 logs"
echo "=========================================="
