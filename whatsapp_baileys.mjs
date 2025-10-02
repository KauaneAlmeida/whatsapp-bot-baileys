// whatsapp_baileys.mjs
import express from "express";
import fs from "fs";
import path from "path";
import axios from "axios";
import qrcode from "qrcode-terminal";
import QRCode from "qrcode";

// Variáveis globais para módulos
let makeWASocket, DisconnectReason, useMultiFileAuthState, Boom;
let firebaseAdmin = null;

const loadModules = async () => {
    try {
        const baileys = await import("@whiskeysockets/baileys");
        const boom = await import("@hapi/boom");

        // algumas versões exportam default, outras não
        makeWASocket = baileys.default || baileys.makeWASocket;
        DisconnectReason = baileys.DisconnectReason;
        useMultiFileAuthState = baileys.useMultiFileAuthState;
        Boom = boom.Boom;

        if (typeof makeWASocket !== "function") {
            console.error("❌ ERRO: makeWASocket não encontrado.");
            return false;
        }

        if (process.env.FIREBASE_KEY) {
            firebaseAdmin = await import("firebase-admin");
        }

        console.log("✅ Módulos carregados com sucesso");
        return true;
    } catch (error) {
        console.error("❌ Erro ao carregar módulos:", error);
        return false;
    }
};

// Firebase Storage
let firebaseStorage = null;
let storageBucket = null;
let isFirebaseConnected = false;

const initializeFirebaseStorage = async () => {
    try {
        if (!process.env.FIREBASE_KEY) {
            console.log("⚠️ Firebase Storage não configurado");
            return;
        }

        if (!firebaseAdmin) {
            console.error("❌ Firebase Admin não foi carregado");
            return;
        }

        const firebaseKey = JSON.parse(process.env.FIREBASE_KEY);
        const credential = firebaseAdmin.default.credential.cert(firebaseKey);

        if (!firebaseAdmin.default.apps.length) {
            firebaseAdmin.default.initializeApp({
                credential,
                storageBucket: process.env.FIREBASE_STORAGE_BUCKET,
            });
        }

        firebaseStorage = firebaseAdmin.default.storage();
        storageBucket = firebaseStorage.bucket();
        isFirebaseConnected = true;

        console.log("✅ Firebase Storage conectado");
    } catch (error) {
        console.error("❌ Erro Firebase Storage:", error.message);
        isFirebaseConnected = false;
    }
};

class CloudSessionManager {
    constructor() {
        this.sessionPath = "./whatsapp_session";
        this.cloudPath = "whatsapp-sessions/baileys-session";
        this.backupInterval = 5 * 60 * 1000;
        this.lastBackup = 0;
    }

    clearLocalSession() {
        if (fs.existsSync(this.sessionPath)) {
            fs.rmSync(this.sessionPath, { recursive: true, force: true });
            console.log("🧹 Sessão local removida");
        }
    }

    async downloadSession() {
        try {
            if (!storageBucket) return false;

            console.log("⬇️ Baixando sessão do bucket...");
            // apaga local e recria
            this.clearLocalSession();
            fs.mkdirSync(this.sessionPath, { recursive: true });

            const [files] = await storageBucket.getFiles({ prefix: this.cloudPath });

            if (!files || files.length === 0) {
                console.log("⚠️ Nenhuma sessão encontrada no bucket");
                return false;
            }

            let downloaded = 0;
            for (const file of files) {
                const fileName = file.name.replace(`${this.cloudPath}/`, "");
                if (!fileName) continue;
                const localPath = path.join(this.sessionPath, fileName);
                await file.download({ destination: localPath });
                console.log(`✔️ Sessão restaurada: ${fileName}`);
                downloaded++;
            }

            if (downloaded === 0) {
                console.log("⚠️ Nenhum arquivo de sessão baixado.");
                return false;
            }

            return true;
        } catch (error) {
            console.error("❌ Erro ao restaurar sessão:", error.message);
            return false;
        }
    }

    async uploadSession() {
        try {
            if (!storageBucket) return false;

            const now = Date.now();
            if (now - this.lastBackup < this.backupInterval) return false;

            if (!fs.existsSync(this.sessionPath)) return false;

            const files = fs.readdirSync(this.sessionPath);
            let uploaded = 0;

            for (const fileName of files) {
                const localPath = path.join(this.sessionPath, fileName);
                const cloudPath = `${this.cloudPath}/${fileName}`;
                await storageBucket.upload(localPath, { destination: cloudPath });
                uploaded++;
            }

            this.lastBackup = now;
            console.log(`⬆️ Backup da sessão: ${uploaded} arquivos enviados`);
            return true;
        } catch (error) {
            console.error("❌ Erro ao enviar sessão:", error.message);
            return false;
        }
    }

    startAutoBackup() {
        setInterval(async () => {
            if (isFirebaseConnected) {
                await this.uploadSession();
            }
        }, this.backupInterval);
    }
}

const CONFIG = {
    sessionPath: "./whatsapp_session",
    expressPort: process.env.PORT || 8081,
    backendUrl:
        process.env.BACKEND_URL ||
        "https://law-firm-backend-936902782519-936902782519.us-central1.run.app/api/v1/whatsapp/webhook",
};

const app = express();
app.use(express.json());
let qrCodeBase64 = null;

/**
 * Fila + Circuit Breaker
 */
class BackendQueue {
    constructor(concurrency = 5, retryDelay = 15000) {
        this.queue = [];
        this.running = 0;
        this.concurrency = concurrency;
        this.retryDelay = retryDelay;
        this.backendDownUntil = 0;
    }

    async push(task) {
        this.queue.push(task);
        this.run();
    }

    async run() {
        if (this.running >= this.concurrency) return;
        if (this.queue.length === 0) return;

        if (Date.now() < this.backendDownUntil) return;

        const task = this.queue.shift();
        this.running++;

        try {
            const response = await axios.post(task.url, task.payload, {
                timeout: 30000,
                headers: { "Content-Type": "application/json" },
            });

            if (response.data && response.data.response) {
                await task.replyFn(response.data.response);
                console.log("✅ Resposta enviada (fila)");
            } else {
                console.log("⚠️ Backend não retornou resposta (fila)");
            }
        } catch (err) {
            console.error("❌ Erro backend (fila):", err.message || err);
            // se backend der erro, pausa envios por retryDelay e re-enfileira
            this.backendDownUntil = Date.now() + this.retryDelay;
            // requeue com atraso (backoff simples)
            setTimeout(() => {
                this.queue.push(task);
                this.run();
            }, this.retryDelay);
        } finally {
            this.running--;
            // tenta continuar com próximos
            setTimeout(() => this.run(), 200);
        }
    }
}
const backendQueue = new BackendQueue(5, 15000);

class BaileysWhatsAppBot {
    constructor() {
        this.sock = null;
        this.isConnected = false;
        this.isConnecting = false;
        this.authState = null;
        this.saveCreds = null;
        this.server = null;
        this.sessionManager = new CloudSessionManager();
        this.qrAttempts = 0;
        this.maxQRAttempts = 3;
        this.baileysLoaded = false;
        this.modulesLoaded = false;

        // mapa de mensagens vistas { msgId => timestampMs }
        this.seenMessages = new Map();
        this.seenMessagesTTL = 1000 * 60 * 5; // 5 min
        setInterval(() => this.cleanupSeenMessages(), 60 * 1000);

        this.MAX_MESSAGE_AGE = 30; // segundos
        this.initialSyncDone = false;

        this.setupExpressServer();
    }

    cleanupSeenMessages() {
        const now = Date.now();
        for (const [id, ts] of this.seenMessages.entries()) {
            if (now - ts > this.seenMessagesTTL) this.seenMessages.delete(id);
        }
    }

    setupExpressServer() {
        app.get("/health", (req, res) => {
            res.status(200).json({
                status: "healthy",
                connected: this.isConnected,
                connecting: this.isConnecting,
                firebase_connected: isFirebaseConnected,
                baileys_loaded: this.baileysLoaded,
                modules_loaded: this.modulesLoaded,
                qr_attempts: this.qrAttempts,
                uptime: process.uptime(),
                timestamp: new Date().toISOString(),
            });
        });

        app.get("/qr", async (req, res) => {
            const htmlContent = `<!DOCTYPE html><html><head><title>WhatsApp QR</title><meta http-equiv="refresh" content="15"></head><body>
            <h1>WhatsApp Bot</h1>
            <p>Status: ${this.isConnected ? "Conectado" : this.isConnecting ? "Conectando..." : "Desconectado"}</p>
            ${this.isConnected ? "<p>✅ Conectado com sucesso!</p>" : qrCodeBase64 ? `<img src="${qrCodeBase64}" alt="QR Code" style="max-width:300px;">` : "<p>⏳ Carregando QR... (ver terminal)</p>"}
            <p><small>Refresh automático a cada 15s</small></p>
            </body></html>`;
            res.send(htmlContent);
        });

        app.post("/reset-session", async (req, res) => {
            try {
                console.log("🔄 Resetando sessão...");
                this.sessionManager.clearLocalSession();
                this.qrAttempts = 0;
                this.isConnecting = false;
                qrCodeBase64 = null;

                if (this.sock) {
                    try { this.sock.end(); } catch(e) {}
                    this.sock = null;
                }

                setTimeout(() => this.initializeBailey(), 2000);

                res.json({ success: true, message: "Sessão resetada" });
            } catch (error) {
                console.error("❌ Reset session error:", error);
                res.status(500).json({ success: false, error: error.message });
            }
        });

        app.post("/send-message", async (req, res) => {
            try {
                const { phone_number, message } = req.body;

                if (!phone_number || !message) {
                    return res.status(400).json({ success: false, error: "phone_number e message são obrigatórios" });
                }

                if (!this.isConnected) {
                    return res.status(503).json({ success: false, error: "WhatsApp não conectado" });
                }

                const whatsappJid = phone_number.includes("@") ? phone_number : `${phone_number}@s.whatsapp.net`;
                const messageId = await this.sendMessage(whatsappJid, message);
                res.json({ success: true, message_id: messageId, phone_number });
            } catch (error) {
                res.status(500).json({ success: false, error: error.message });
            }
        });

        this.server = app.listen(CONFIG.expressPort, "0.0.0.0", () => {
            console.log(`🚀 Server rodando na porta ${CONFIG.expressPort}`);
            this.initializeServices();
        });
    }

    async initializeServices() {
        console.log("⚙️ Inicializando serviços...");
        this.modulesLoaded = await loadModules();
        this.baileysLoaded = this.modulesLoaded;
        if (!this.modulesLoaded) {
            console.error("❌ Falha ao carregar módulos - abortando inicialização");
            return;
        }

        await initializeFirebaseStorage();
        if (isFirebaseConnected) {
            await this.sessionManager.downloadSession();
            this.sessionManager.startAutoBackup();
        }

        // start after a short delay
        setTimeout(async () => {
            await this.initializeBailey();
        }, 1000);
    }

    async initializeBailey() {
        if (this.isConnecting) {
            console.log("⚠️ Já está conectando, ignorando nova tentativa");
            return;
        }

        if (!this.baileysLoaded) {
            console.error("❌ Baileys não foi carregado - não é possível inicializar");
            return;
        }

        this.isConnecting = true;
        console.log("🔗 Inicializando conexão com Baileys...");

        try {
            // garante diretório de sessão local
            if (!fs.existsSync(this.sessionManager.sessionPath)) {
                fs.mkdirSync(this.sessionManager.sessionPath, { recursive: true });
            }

            // pega estado auth
            const { state, saveCreds } = await useMultiFileAuthState(this.sessionManager.sessionPath);
            this.authState = state;
            this.saveCreds = saveCreds;

            // instancia socket
            this.sock = makeWASocket({
                auth: this.authState,
                printQRInTerminal: false,
                browser: ["Bot", "Chrome", "110.0.0"],
                qrTimeout: 40_000,
                connectTimeoutMs: 60_000,
                defaultQueryTimeoutMs: 60_000,
                retryRequestDelayMs: 250,
                maxMsgRetryCount: 5,
                markOnlineOnConnect: true,
                syncFullHistory: false,
            });

            // cred update
            this.sock.ev.on("creds.update", this.saveCreds);

            this.sock.ev.on("connection.update", async (update) => {
                try {
                    const { connection, lastDisconnect, qr } = update;

                    if (qr) {
                        this.qrAttempts++;
                        console.log(`📱 QR Code gerado ${this.qrAttempts}/${this.maxQRAttempts}`);
                        qrcode.generate(qr, { small: true });
                        qrCodeBase64 = await QRCode.toDataURL(qr);
                        console.log("📲 QR Code pronto - escaneie via WhatsApp (ver /qr também)");
                        // se muitas tentativas, limpa
                        if (this.qrAttempts > this.maxQRAttempts) {
                            console.log("❌ Muitas tentativas de QR - preciso resetar sessão local");
                            qrCodeBase64 = null;
                            this.sessionManager.clearLocalSession();
                        }
                    }

                    if (connection === "open") {
                        console.log("✅ WhatsApp conectado com sucesso!");
                        this.isConnected = true;
                        this.isConnecting = false;
                        this.qrAttempts = 0;
                        qrCodeBase64 = null;

                        // dá um tempinho pra sync estabilizar e evita tratar flood de histórico
                        setTimeout(() => {
                            this.initialSyncDone = true;
                            console.log("ℹ️ initialSyncDone = true");
                        }, 2000);

                        // envia upload da sessão
                        try { await this.sessionManager.uploadSession(); } catch(e) { console.warn("⚠️ uploadSession falhou:", e.message || e); }
                    }

                    if (connection === "close") {
                        console.log("⚠️ Conexão fechada:", lastDisconnect?.error?.message || lastDisconnect);
                        this.isConnected = false;
                        this.isConnecting = false;
                        this.initialSyncDone = false;

                        // decide reconectar
                        const shouldReconnect =
                            lastDisconnect?.error instanceof Boom
                                ? lastDisconnect.error.output.statusCode !== DisconnectReason.loggedOut
                                : true;

                        if (shouldReconnect && this.qrAttempts < this.maxQRAttempts) {
                            console.log("🔄 Tentando reconectar em 10s...");
                            setTimeout(() => this.initializeBailey(), 10_000);
                        } else {
                            console.log("❌ Não reconectando - limpando sessão local");
                            this.sessionManager.clearLocalSession();
                            this.qrAttempts = 0;
                        }
                    }
                } catch (e) {
                    console.error("❌ Erro em connection.update:", e);
                }
            });

            // listener de mensagens
            this.sock.ev.on("messages.upsert", async (m) => {
                try {
                    const msgs = m.messages || [];
                    const msg = msgs[0];
                    if (!msg) return;

                    // ignorar mensagens que não são do tipo 'notify'
                    if (m.type !== "notify") return;

                    // ignora mensagens do próprio bot
                    if (!msg.message || msg.key.fromMe) return;

                    // ignora status broadcast
                    if (msg.key && msg.key.remoteJid === "status@broadcast") return;

                    // id
                    const msgId = msg.key && msg.key.id ? msg.key.id : null;
                    if (!msgId) return;

                    // extrai timestamp confiável
                    let msgTimestamp = null;
                    if (msg.messageTimestamp) msgTimestamp = Number(msg.messageTimestamp);
                    else if (msg.key && msg.key.t) msgTimestamp = Number(msg.key.t);
                    else if (msg.message?.timestamp) msgTimestamp = Number(msg.message.timestamp);

                    if (!msgTimestamp || isNaN(msgTimestamp) || msgTimestamp === 0) {
                        console.log(`⛔ Ignorada (sem timestamp válido): ${msgId}`);
                        return;
                    }

                    const nowSecs = Math.floor(Date.now() / 1000);
                    const messageAge = nowSecs - msgTimestamp;

                    if (messageAge > this.MAX_MESSAGE_AGE) {
                        console.log(`⏩ Ignorada mensagem antiga (${messageAge}s): ${msgId}`);
                        return;
                    }

                    if (this.seenMessages.has(msgId)) {
                        console.log(`🔁 Ignorada duplicada: ${msgId}`);
                        return;
                    }
                    this.seenMessages.set(msgId, Date.now());

                    // extrai texto
                    const messageText =
                        (msg.message?.conversation && msg.message.conversation) ||
                        (msg.message?.extendedTextMessage?.text && msg.message.extendedTextMessage.text) ||
                        (msg.message?.imageMessage?.caption && msg.message.imageMessage.caption) ||
                        (msg.message?.videoMessage?.caption && msg.message.videoMessage.caption) ||
                        null;

                    if (!messageText || messageText.trim() === "") {
                        console.log(`⚠️ Mensagem sem texto relevante: ${msgId}`);
                        return;
                    }

                    const remoteJid = msg.key.remoteJid;
                    console.log(`📩 Nova mensagem (${remoteJid}):`, messageText.substring(0, 200));

                    // tenta marcar como lida
                    try { await this.sock.readMessages([msg.key]); } catch (e) { console.warn("⚠️ Falha ao marcar como lida:", e.message || e); }

                    // encaminha para backend via fila
                    await this.forwardToBackend(remoteJid, messageText, msgId);
                } catch (err) {
                    console.error("❌ Erro ao processar messages.upsert:", err);
                }
            });
        } catch (err) {
            console.error("❌ Erro Baileys inicialização:", err);
            this.isConnecting = false;
            setTimeout(() => this.initializeBailey(), 15_000);
        }
    }

    async forwardToBackend(remoteJid, messageText, messageId) {
        const payload = {
            phone_number: remoteJid.split("@")[0],
            message: messageText,
            message_id: messageId,
        };

        backendQueue.push({
            url: CONFIG.backendUrl,
            payload,
            replyFn: async (reply) => {
                try {
                    // reply é texto vindo do backend; tenta simular digitando e enviar
                    // formato to: remoteJid já vem com @s.whatsapp.net quando necessário
                    await this.sendMessage(remoteJid, reply);
                } catch (e) {
                    console.error("❌ Falha ao enviar reply do backend:", e.message || e);
                }
            },
        });
    }

    async sendMessage(to, message) {
        if (!this.isConnected || !this.sock) {
            throw new Error("WhatsApp not connected");
        }

        try {
            // presence/typing simulation se disponível
            try {
                if (typeof this.sock.sendPresenceUpdate === "function") {
                    await this.sock.sendPresenceUpdate("composing", to);
                    await new Promise(res => setTimeout(res, 1000));
                    await this.sock.sendPresenceUpdate("paused", to);
                }
            } catch (presErr) {
                console.warn("⚠️ Falha ao enviar presence:", presErr.message || presErr);
                // segue sem presence
            }

            const result = await this.sock.sendMessage(to, { text: message });
            return result.key.id;
        } catch (error) {
            console.error("❌ Erro enviar mensagem:", error);
            throw error;
        }
    }
}

console.log("🚀 Iniciando WhatsApp Bot...");
new BaileysWhatsAppBot();
