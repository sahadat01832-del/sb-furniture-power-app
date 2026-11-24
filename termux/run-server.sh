#!/usr/bin/env bash
set -euo pipefail

cd /root/sb-power-app
mkdir -p logs
./node_modules/.bin/pm2 startOrRestart ecosystem.config.js --update-env
./node_modules/.bin/pm2 save
./node_modules/.bin/pm2 status
