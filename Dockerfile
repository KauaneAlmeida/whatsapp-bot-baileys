FROM node:18-slim

WORKDIR /app

# Instalar dependências do sistema
RUN apt-get update && apt-get install -y curl git \
    && apt-get clean && rm -rf /var/lib/apt/lists/*

# Copiar package files da RAIZ (não da pasta whatsapp-bot)
COPY package.json ./
COPY package-lock.json ./

# Instalar dependências Node.js
RUN npm install --production --no-audit --no-fund \
    && npm cache clean --force

# Copiar código JavaScript da pasta whatsapp-bot
COPY whatsapp-bot/whatsapp_baileys.js ./

# Criar usuário não-root
RUN addgroup --system appuser && \
    adduser --system --ingroup appuser appuser && \
    mkdir -p /app/whatsapp_session && \
    chown -R appuser:appuser /app

USER appuser

EXPOSE 8081

HEALTHCHECK --interval=30s --timeout=10s --start-period=60s --retries=3 \
    CMD curl -f http://localhost:8081/health || exit 1

CMD ["node", "whatsapp_baileys.js"]