// PM2 — gerencia o proxy e o tunnel como serviços automáticos
// Inicia com o Windows, reinicia se travar, logs salvos automaticamente
module.exports = {
  apps: [
    {
      name: 'claudio-proxy',
      script: 'server.js',
      interpreter: 'node',
      cwd: __dirname,
      env: {
        PORT: 3001,
        // CLAUDIO_PROXY_TOKEN e REPO_PATH são lidos do .env (vide setup.ps1)
      },
      env_file: '.env',
      watch: false,
      autorestart: true,
      max_restarts: 10,
      restart_delay: 3000,
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      out_file: 'logs/proxy.log',
      error_file: 'logs/proxy-error.log',
    },
    {
      name: 'claudio-tunnel',
      script: 'tunnel.js',
      interpreter: 'node',
      cwd: __dirname,
      env_file: '.env',
      watch: false,
      autorestart: true,
      max_restarts: 20,
      restart_delay: 5000,
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      out_file: 'logs/tunnel.log',
      error_file: 'logs/tunnel-error.log',
    },
  ],
};
