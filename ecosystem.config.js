// ============================================================
// PM2 Ecosystem Configuration for SB Furniture & SB POWER
// Ensures 24/7 background running independent of Antigravity session
// ============================================================

module.exports = {
  apps: [
    {
      name: 'sb-power-app',
      script: 'src/server.js',
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: '300M',
      env: {
        NODE_ENV: 'production',
        PORT: 3000
      },
      error_file: './logs/err.log',
      out_file: './logs/out.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
      merge_logs: true
    }
  ]
};
