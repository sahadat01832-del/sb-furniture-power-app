#!/usr/bin/env bash
set -euo pipefail

APP_PORT="${PORT:-3000}"
MODE="${TAILSCALE_MODE:-auto}"
STATE_DIR="${TAILSCALE_STATE_DIR:-$HOME/.local/share/sb-power/tailscale}"
SOCKET_PATH="${TAILSCALE_SOCKET:-$STATE_DIR/tailscaled.sock}"
STATE_FILE="$STATE_DIR/tailscaled.state"
LOG_FILE="${TAILSCALE_LOG_FILE:-$STATE_DIR/tailscaled.log}"

if ! command -v tailscale >/dev/null 2>&1; then
  echo 'tailscale CLI was not found. Install Tailscale for this Linux environment first.' >&2
  exit 1
fi

if ! command -v tailscaled >/dev/null 2>&1; then
  echo 'tailscaled was not found. Install the matching Tailscale daemon first.' >&2
  exit 1
fi

if [[ "$MODE" == "auto" ]]; then
  if [[ "${PREFIX:-}" == *com.termux* ]]; then
    MODE='userspace'
  elif [[ -c /dev/net/tun && "$(id -u)" -eq 0 ]]; then
    MODE='kernel'
  else
    MODE='userspace'
  fi
fi

if [[ "$MODE" != 'userspace' && "$MODE" != 'kernel' ]]; then
  echo 'TAILSCALE_MODE must be auto, userspace, or kernel.' >&2
  exit 1
fi

mkdir -p "$STATE_DIR"
chmod 700 "$STATE_DIR"

if tailscale status >/dev/null 2>&1; then
  TS=(tailscale)
else
  if [[ "$MODE" == 'kernel' && "$(id -u)" -ne 0 ]]; then
    echo 'Kernel networking requires root and /dev/net/tun; set TAILSCALE_MODE=userspace or run as root.' >&2
    exit 1
  fi

  if [[ "$MODE" == 'userspace' ]]; then
    nohup tailscaled --tun=userspace-networking --state="$STATE_FILE" --socket="$SOCKET_PATH" \
      >> "$LOG_FILE" 2>&1 &
  else
    nohup tailscaled --state="$STATE_FILE" --socket="$SOCKET_PATH" \
      >> "$LOG_FILE" 2>&1 &
  fi
  TS=(tailscale --socket="$SOCKET_PATH")

  ready=0
  for ((attempt = 0; attempt < 30; attempt += 1)); do
    if "${TS[@]}" status >/dev/null 2>&1; then ready=1; break; fi
    sleep 1
  done
  if [[ "$ready" -ne 1 ]]; then
    echo "tailscaled did not become ready; check $LOG_FILE." >&2
    exit 1
  fi
fi

TAILSCALE_STATE=$("${TS[@]}" status --json 2>/dev/null | node -e '
  let input = "";
  process.stdin.on("data", (chunk) => { input += chunk; });
  process.stdin.on("end", () => {
    try { process.stdout.write(JSON.parse(input).BackendState || "Unknown"); }
    catch { process.exit(1); }
  });
')
if [[ "$TAILSCALE_STATE" != 'Running' ]]; then
  echo 'Tailscale login is required. Follow the URL printed below, then rerun this script.'
  "${TS[@]}" up --accept-dns=false
fi

"${TS[@]}" funnel --bg "$APP_PORT"
"${TS[@]}" funnel status
