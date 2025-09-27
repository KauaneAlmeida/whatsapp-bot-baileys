module.exports = {
  apps: [
    {
      name: 'whatsapp-bot',
      script: 'index.js',           // <== trocado
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: '1G',
      env: {
        NODE_ENV: 'production',
        PORT: 8080
      },
      error_file: '/dev/stderr',
      out_file: '/dev/stdout',
      log_file: '/dev/stdout',
      time: true,
      merge_logs: true
    }
  ]
};
