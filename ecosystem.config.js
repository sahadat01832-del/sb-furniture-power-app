// ============================================================
// PM2 process supervisor for SB Furniture & SB POWER.
// It restarts the app process; host, power, network, and tunnel uptime are separate.
// ============================================================

const path = require('path');
const root = __dirname;

function processConfig(name, script, logName) {
  return {
    name,
    script,
    cwd: root,
    instances: 1,
    exec_mode: 'fork',
    autorestart: true,
    watch: false,
    exp_backoff_restart_delay: 1000,
    max_memory_restart: '350M',
    kill_timeout: 30000,
    env: {
      NODE_ENV: 'production',
      PORT: 3000,
      PATH: process.env.PATH && process.env.PATH.includes('/data/data/com.termux/files/usr/bin')
        ? process.env.PATH
        : `/data/data/com.termux/files/usr/bin:${process.env.PATH || '/usr/bin:/bin'}`
    },
    error_file: path.join(root, 'logs', `${logName}-err.log`),
    out_file: path.join(root, 'logs', `${logName}-out.log`),
    log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
    merge_logs: true
  };
}

module.exports = {
  apps: [
    processConfig('sb-power-app', 'src/server.js', 'app'),
    processConfig('sb-power-tunnel-watchdog', 'scripts/tunnel-watchdog.js', 'tunnel')
  ]
};
