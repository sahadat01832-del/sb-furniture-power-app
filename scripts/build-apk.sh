#!/usr/bin/env bash
# ============================================================
# SB Furniture & SB POWER - APK Build Proxy
# Forwards to scripts/build-apks.sh with support for client, admin, or all
# ============================================================

set -e

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
bash "$DIR/build-apks.sh" "$@"
