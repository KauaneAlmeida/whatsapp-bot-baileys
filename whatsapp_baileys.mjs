import express from "express";
import fs from "fs";
import path from "path";
import axios from "axios";
import qrcode from "qrcode-terminal";
import QRCode from "qrcode";

let makeWASocket, DisconnectReason, useMultiFileAuthState, Boom;
let firebaseAdmin = null;

const loadModules = async () => {
    try {
        const baileys = await import("@whiskeysockets/baileys");
        const boom = await import("@hapi/boom");
        
        makeWASocket = baileys.default;
        DisconnectReason = baileys.DisconnectReason;
        useMultiFileAuthState = baileys.useMultiFileAuthState;
        Boom = boom.Boom;
        
        if (typeof makeWASocket !== 'function') {
            makeWASocket = baileys.makeWASocket;
        }
        
        if (typeof makeWASocket !== 'function') {
            console.error("ERRO: makeWASocket não encontrado");
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

let firebaseStorage = null;
let storageBucket = null;
let isFirebaseConnected = false;

const initializeFirebaseStorage = async () => {
    try {
        if (!process.env.FIREBASE_KEY) {
            console.log("Firebase Storage não configurado");
            return;
        }

        if (!firebaseAdmin) {
            console.error("Firebase Admin não foi carregado");
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
        console.error("Erro Firebase Storage:", error.message);
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

    async downloadSession() {
        try {
            if (!storageBucket) return false;

            console.log("⬇️ Baixando sessão do bucket...");

            if (!fs.existsSync(this.sessionPath)) {
                fs.mkdirSync(this.sessionPath, { recursive: true });
            }

            const [files] = await storageBucket.getFiles({ prefix: this.cloudPath });

            if (files.length === 0) {
                console.log("Nenhuma sessão encontrada no bucket");
                return false;
            }

            // 🔥 CRÍTICO: Baixar apenas arquivos de autenticação, NÃO histórico
            const authFiles = ['creds.json', 'app-state-sync-key', 'app-state-sync-version'];
            
            for (const file of files) {
                const fileName = file.name.replace(`${this.cloudPath}/`, "");
                
                // 🔥 PULAR arquivos de histórico de mensagens
                if (fileName.includes('session-') || 
                    fileName.includes('sender-key') || 
                    fileName.includes('message-')) {
                    console.log(`⏭️ Ignorando histórico: ${fileName}`);
                    continue;
                }
                
                const localPath = path.join(this.sessionPath, fileName);
                await file.download({ destination: localPath });
                console.log(`✔️ Sessão restaurada: ${fileName}`);
            }

            return true;
        } catch (error) {
            console.error("Erro ao restaurar sessão:", error.message);
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

            // 🔥 BACKUP: Apenas arquivos essenciais, não histórico
            const essentialFiles = ['creds.json', 'app-state-sync-key', 'app-state-sync-version'];

            for (const fileName of files) {
                // Ignorar histórico no backup também
                if (!essentialFiles.some(f => fileName.includes(f))) {
                    continue;
                }
                
                const localPath = path.join(this.sessionPath, fileName);
                const cloudPath = `${this.cloudPath}/${fileName}`;
                await storageBucket.upload(localPath, { destination: cloudPath });
                uploaded++;
            }

            this.lastBackup = now;
            console.log(`⬆️ Backup da sessão: ${uploaded} arquivos enviados`);
            return true;
        } catch (error) {
            console.error("Erro ao enviar sessão:", error.message);
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

    clearLocalSession() {
        if (fs.existsSync(this.sessionPath)) {
            fs.rmSync(this.sessionPath, { recursive: true, force: true });
            console.log("🧹 Sessão local removida");
        }
    }
    
    // 🔥 NOVO: Limpar histórico local após conexão
    clearMessageHistory() {
        try {
            if (!fs.existsSync(this.sessionPath)) return;
            
            const files = fs.readdirSync(this.sessionPath);
            let cleaned = 0;
            
            for (const file of files) {
                if (file.includes('session-') || 
                    file.includes('sender-key') || 
                    file.includes('message-')) {
                    const filePath = path.join(this.sessionPath, file);
                    fs.unlinkSync(filePath);
                    cleaned++;
                }
            }
            
            console.log(`🧹 Histórico limpo: ${cleaned} arquivos removidos`);
        } catch (error) {
            console.error("Erro ao limpar histórico:", error.message);
        }
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
        this.connectionTimestamp = null;
        this.STALE_MESSAGE_THRESHOLD = 3 * 60; // 3 minutos
        this.processedMessages = new Set(); // 🔥 Cache local
        this.MESSAGE_CACHE_LIMIT = 1000;

        this.setupExpressServer();
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
                processed_messages_cache: this.processedMessages.size
            });
        });

        app.get("/qr", async (req, res) => {
            const htmlContent = `
<!DOCTYPE html>
<html>
<head>
    <title>WhatsApp QR</title>
    <meta http-equiv="refresh" content="15">
</head>
<body>
    <h1>WhatsApp Bot</h1>
    <p>Status: ${this.isConnected ? 'Conectado' : this.isConnecting ? 'Conectando...' : 'Desconectado'}</p>
    <p>Baileys: ${this.baileysLoaded ? 'Carregado' : 'Não carregado'}</p>
    <p>Cache: ${this.processedMessages.size} msgs</p>
    ${
        this.isConnected
            ? "<p>✅ Conectado com sucesso!</p>"
            : qrCodeBase64
            ? `<img src="${qrCodeBase64}" alt="QR Code" style="max-width:300px;"><br><p>Escaneie RAPIDAMENTE</p>`
            : "<p>⏳ Carregando QR...</p>"
    }
    <button onclick="location.reload()">Refresh</button>
    ${this.qrAttempts >= this.maxQRAttempts ? '<br><button onclick="fetch(\'/reset-session\', {method:\'POST\'}).then(()=>location.reload())">Reset</button>' : ''}
</body>
</html>`;
            res.send(htmlContent);
        });

        app.post("/reset-session", async (req, res) => {
            try {
                console.log("🔄 Resetando sessão...");
                this.sessionManager.clearLocalSession();
                this.qrAttempts = 0;
                this.isConnecting = false;
                qrCodeBase64 = null;
                this.connectionTimestamp = null;
                this.processedMessages.clear(); // 🔥 Limpar cache
                
                if (this.sock) {
                    this.sock.end();
                    this.sock = null;
                }
                
                setTimeout(() => {
                    this.initializeBailey();
                }, 2000);
                
                res.json({ success: true, message: "Sessão resetada" });
            } catch (error) {
                console.error("Reset session error:", error);
                res.status(500).json({ success: false, error: error.message });
            }
        });

        app.post("/send-message", async (req, res) => {
            try {
                const { phone_number, message } = req.body;

                if (!phone_number || !message) {
                    return res.status(400).json({
                        success: false,
                        error: "phone_number e message são obrigatórios",
                    });
                }

                if (!this.isConnected) {
                    return res.status(503).json({
                        success: false,
                        error: "WhatsApp não conectado",
                    });
                }

                const whatsappJid = phone_number.includes("@")
                    ? phone_number
                    : `${phone_number}@s.whatsapp.net`;

                const messageId = await this.sendMessage(whatsappJid, message);

                res.json({
                    success: true,
                    message_id: messageId,
                    phone_number,
                });
            } catch (error) {
                res.status(500).json({
                    success: false,
                    error: error.message,
                });
            }
        });

        this.server = app.listen(CONFIG.expressPort, "0.0.0.0", () => {
            console.log(`🚀 Server rodando na porta ${CONFIG.expressPort}`);
            this.initializeServices();
        });
    }

    async initializeServices() {
        console.log("Inicializando serviços...");
        
        this.modulesLoaded = await loadModules();
        this.baileysLoaded = this.modulesLoaded;
        
        if (!this.modulesLoaded) {
            console.error("❌ Falha ao carregar módulos");
            return;
        }

        await initializeFirebaseStorage();

        if (isFirebaseConnected) {
            await this.sessionManager.downloadSession();
            this.sessionManager.startAutoBackup();
        }

        setTimeout(async () => {
            await this.initializeBailey();
        }, 2000);
    }

    async initializeBailey() {
        if (this.isConnecting) {
            console.log("⚠️ Já está conectando");
            return;
        }

        if (!this.baileysLoaded) {
            console.error("❌ Baileys não carregado");
            return;
        }

        this.isConnecting = true;
        console.log("🔗 Inicializando conexão WhatsApp...");
        
        try {
            if (!fs.existsSync(CONFIG.sessionPath)) {
                fs.mkdirSync(CONFIG.sessionPath, { recursive: true });
            }

            const { state, saveCreds } = await useMultiFileAuthState(CONFIG.sessionPath);
            this.authState = state;
            this.saveCreds = saveCreds;

            this.sock = makeWASocket({
                auth: this.authState,
                printQRInTerminal: false,
                browser: ["Bot", "Chrome", "110.0.0"],
                qrTimeout: 40000,
                connectTimeoutMs: 60000,
                defaultQueryTimeoutMs: 60000,
                retryRequestDelayMs: 250,
                maxMsgRetryCount: 5,
                markOnlineOnConnect: true,
                syncFullHistory: false, // 🔥 NÃO SINCRONIZA HISTÓRICO
                getMessage: async () => undefined // 🔥 NÃO PROCESSA ANTIGAS
            });

            this.sock.ev.on("connection.update", async (update) => {
                const { connection, lastDisconnect, qr } = update;
                
                if (qr) {
                    this.qrAttempts++;
                    console.log(`📱 QR ${this.qrAttempts}/${this.maxQRAttempts}`);
                    
                    if (this.qrAttempts <= this.maxQRAttempts) {
                        qrcode.generate(qr, { small: true });
                        qrCodeBase64 = await QRCode.toDataURL(qr);
                    } else {
                        console.log("❌ Muitas tentativas");
                        qrCodeBase64 = null;
                        this.sessionManager.clearLocalSession();
                    }
                }
                
                if (connection === "open") {
                    console.log("✅ WhatsApp conectado!");
                    this.isConnected = true;
                    this.isConnecting = false;
                    this.qrAttempts = 0;
                    qrCodeBase64 = null;

                    // 🔥 TIMESTAMP ANTES de processar qualquer mensagem
                    this.connectionTimestamp = Math.floor(Date.now() / 1000);
                    console.log(`🕐 Connection timestamp: ${this.connectionTimestamp}`);

                    // 🔥 LIMPAR histórico local
                    this.sessionManager.clearMessageHistory();

                    await this.sessionManager.uploadSession();
                }
                
                if (connection === "close") {
                    this.isConnected = false;
                    this.isConnecting = false;
                    qrCodeBase64 = null;
                    this.connectionTimestamp = null;
                    
                    const shouldReconnect = (lastDisconnect?.error instanceof Boom)
                        ? lastDisconnect.error.output.statusCode !== DisconnectReason.loggedOut
                        : true;

                    console.log("⚠️ Conexão fechada");
                    
                    if (shouldReconnect && this.qrAttempts < this.maxQRAttempts) {
                        setTimeout(() => this.initializeBailey(), 10000);
                    } else {
                        this.sessionManager.clearLocalSession();
                        this.qrAttempts = 0;
                    }
                }
            });

            this.sock.ev.on("creds.update", this.saveCreds);

            this.sock.ev.on("messages.upsert", async (m) => {
                try {
                    const msg = m.messages[0];

                    // 🔥 FILTROS IMEDIATOS (antes de qualquer processamento)
                    if (!msg || !msg.message || msg.key.fromMe || m.type !== "notify") {
                        return;
                    }

                    const messageId = msg.key.id;
                    const phoneNumber = msg.key.remoteJid.split("@")[0];
                    const messageTimestamp = msg.messageTimestamp?.low || msg.messageTimestamp || Math.floor(Date.now() / 1000);

                    // 🔥 VERIFICAÇÃO 1: Cache local (mais rápido)
                    if (this.processedMessages.has(messageId)) {
                        console.log(`⏭️ CACHE HIT | ${messageId.substring(0, 10)}...`);
                        return;
                    }

                    // 🔥 VERIFICAÇÃO 2: Mensagem antes da conexão
                    if (this.connectionTimestamp && messageTimestamp < this.connectionTimestamp) {
                        console.log(`⏭️ PRE-CONNECTION | ${messageId.substring(0, 10)}... | ${this.connectionTimestamp - messageTimestamp}s old`);
                        return;
                    }

                    // 🔥 VERIFICAÇÃO 3: Mensagem muito antiga
                    const now = Math.floor(Date.now() / 1000);
                    const messageAge = now - messageTimestamp;
                    
                    if (messageAge > this.STALE_MESSAGE_THRESHOLD) {
                        console.log(`⏭️ TOO OLD | ${messageId.substring(0, 10)}... | ${messageAge}s`);
                        return;
                    }

                    const messageText =
                        msg.message?.conversation ||
                        msg.message?.extendedTextMessage?.text ||
                        null;

                    if (!messageText) {
                        return;
                    }

                    // 🔥 ADICIONAR ao cache ANTES de processar
                    this.processedMessages.add(messageId);
                    
                    // Limpar cache se muito grande
                    if (this.processedMessages.size > this.MESSAGE_CACHE_LIMIT) {
                        const firstItems = Array.from(this.processedMessages).slice(0, 500);
                        firstItems.forEach(id => this.processedMessages.delete(id));
                    }

                    console.log(`✅ NEW MSG | ${messageId.substring(0, 10)}... | ${phoneNumber} | "${messageText.substring(0, 30)}..."`);

                    await this.forwardToBackend(
                        msg.key.remoteJid,
                        messageText,
                        messageId,
                        phoneNumber
                    );

                } catch (error) {
                    console.error("❌ Error processing:", error.message);
                }
            });
        } catch (error) {
            console.error("❌ Erro Baileys:", error.message);
            this.isConnecting = false;
            setTimeout(() => this.initializeBailey(), 15000);
        }
    }

    async forwardToBackend(remoteJid, messageText, messageId, phoneNumber) {
        try {
            const payload = {
                phone_number: phoneNumber,
                message: messageText,
                message_id: messageId,
                timestamp: Math.floor(Date.now() / 1000) // 🔥 Adicionar timestamp
            };

            console.log(`🔗 → Backend | ${messageId.substring(0, 10)}...`);

            const response = await axios.post(CONFIG.backendUrl, payload, {
                timeout: 30000,
                headers: {
                    'Content-Type': 'application/json',
                    'User-Agent': 'WhatsApp-Bot/1.0'
                }
            });

            if (response.data) {
                const status = response.data.status;

                if (status === 'ignored') {
                    console.log(`⏭️ Backend ignored: ${response.data.reason}`);
                    return;
                }

                if (response.data.response) {
                    await this.sendMessage(remoteJid, response.data.response);
                    console.log(`✅ Response sent`);
                }
            }
        } catch (error) {
            console.error(`❌ Backend error:`, error.message);
        }
    }

    async sendMessage(to, message) {
        if (!this.isConnected || !this.sock) {
            throw new Error("WhatsApp not connected");
        }

        try {
            const result = await this.sock.sendMessage(to, { text: message });
            return result.key.id;
        } catch (error) {
            console.error("Erro enviar:", error);
            throw error;
        }
    }
}

console.log("🚀 Iniciando WhatsApp Bot...");
new BaileysWhatsAppBot();