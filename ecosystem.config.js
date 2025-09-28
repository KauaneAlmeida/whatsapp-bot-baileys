export default {
  apps: [
    {
      name: 'whatsapp-bot',
      script: 'whatsapp_baileys.mjs',
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: '1G',
      interpreter: 'node',
      node_args: '--es-module-specifier-resolution=node',
      env: {
        NODE_ENV: 'production',
        PORT: 8081
      },
      error_file: '/dev/stderr',
      out_file: '/dev/stdout',
      log_file: '/dev/stdout',
      time: true,
      merge_logs: true
    }
  ]
};
