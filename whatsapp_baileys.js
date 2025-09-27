global.crypto = require("crypto");
const express = require("express");
const fs = require("fs");
const path = require("path");
const axios = require("axios");
const qrcode = require("qrcode-terminal");
const QRCode = require("qrcode");

// Firebase Storage
let firebaseStorage = null;
let storageBucket = null;
let isFirebaseConnected = false;

const initializeFirebaseStorage = async () => {
    try {
        if (!process.env.FIREBASE_KEY) {
            console.log("Firebase Storage não configurado");
            return;
        }

        const admin = require("firebase-admin");
        const firebaseKey = JSON.parse(process.env.FIREBASE_KEY);
        const credential = admin.credential.cert(firebaseKey);

        if (!admin.apps.length) {
            admin.initializeApp({
                credential,
                storageBucket: process.env.FIREBASE_STORAGE_BUCKET,
            });
        }

        firebaseStorage = admin.storage();
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

            for (const file of files) {
                const fileName = file.name.replace(`${this.cloudPath}/`, "");
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
        this.isConnecting = false; // NOVO: evitar múltiplas conexões
        this.authState = null;
        this.saveCreds = null;
        this.server = null;
        this.sessionManager = new CloudSessionManager();
        this.qrAttempts = 0; // NOVO: controlar tentativas de QR
        this.maxQRAttempts = 3; // NOVO: limite de tentativas
        this.setupExpressServer();
    }

    setupExpressServer() {
        app.get("/health", (req, res) => {
            res.status(200).json({
                status: "healthy",
                connected: this.isConnected,
                connecting: this.isConnecting,
                firebase_connected: isFirebaseConnected,
                qr_attempts: this.qrAttempts,
                uptime: process.uptime(),
                timestamp: new Date().toISOString(),
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
    <p>Tentativas QR: ${this.qrAttempts}/${this.maxQRAttempts}</p>
    ${
        this.isConnected
            ? "<p>✅ Conectado com sucesso!</p>"
            : qrCodeBase64
            ? `<img src="${qrCodeBase64}" alt="QR Code" style="max-width:300px;"><br><p>Escaneie RAPIDAMENTE (expira em ~20s)</p>`
            : "<p>⏳ Carregando QR...</p>"
    }
    <button onclick="location.reload()">Refresh</button>
    ${this.qrAttempts >= this.maxQRAttempts ? '<br><button onclick="fetch(\'/reset-session\', {method:\'POST\'}).then(()=>location.reload())">Reset Sessão</button>' : ''}
</body>
</html>`;
            res.send(htmlContent);
        });

        // NOVO: endpoint para resetar sessão
        app.post("/reset-session", async (req, res) => {
            try {
                console.log("🔄 Resetando sessão...");
                this.sessionManager.clearLocalSession();
                this.qrAttempts = 0;
                this.isConnecting = false;
                qrCodeBase64 = null;
                
                if (this.sock) {
                    this.sock.end();
                }
                
                setTimeout(() => {
                    this.initializeBailey();
                }, 2000);
                
                res.json({ success: true, message: "Sessão resetada" });
            } catch (error) {
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
        // CORREÇÃO: evitar múltiplas inicializações simultâneas
        if (this.isConnecting) {
            console.log("⚠️ Já está conectando, ignorando nova tentativa");
            return;
        }

        this.isConnecting = true;
        console.log("Carregando Baileys...");
        
        try {
            const {
                default: makeWASocket,
                DisconnectReason,
                useMultiFileAuthState,
            } = require("@whiskeysockets/baileys");
            const { Boom } = require("@hapi/boom");

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
                // NOVO: configurações para estabilizar QR
                qrTimeout: 40000, // 40 segundos por QR
                connectTimeoutMs: 60000,
                defaultQueryTimeoutMs: 60000,
            });

            this.sock.ev.on("connection.update", async (update) => {
                const { connection, lastDisconnect, qr } = update;
                
                if (qr) {
                    this.qrAttempts++;
                    console.log(`📱 QR Code ${this.qrAttempts}/${this.maxQRAttempts} gerado`);
                    
                    // Só gerar QR se não excedeu limite
                    if (this.qrAttempts <= this.maxQRAttempts) {
                        qrcode.generate(qr, { small: true });
                        qrCodeBase64 = await QRCode.toDataURL(qr);
                        console.log("📲 QR Code pronto - escaneie RAPIDAMENTE!");
                    } else {
                        console.log("❌ Muitas tentativas de QR - resetar sessão necessário");
                        qrCodeBase64 = null;
                        this.sessionManager.clearLocalSession();
                    }
                }
                
                if (connection === "open") {
                    console.log("✅ WhatsApp conectado com sucesso!");
                    this.isConnected = true;
                    this.isConnecting = false;
                    this.qrAttempts = 0; // RESET contador
                    qrCodeBase64 = null;
                    await this.sessionManager.uploadSession();
                }
                
                if (connection === "close") {
                    this.isConnected = false;
                    this.isConnecting = false;
                    qrCodeBase64 = null;
                    
                    const shouldReconnect = (lastDisconnect?.error instanceof Boom)
                        ? lastDisconnect.error.output.statusCode !== DisconnectReason.loggedOut
                        : true;

                    console.log("⚠️ Conexão fechada:", lastDisconnect?.error?.message);
                    
                    if (shouldReconnect && this.qrAttempts < this.maxQRAttempts) {
                        console.log("🔄 Tentando reconectar em 10s...");
                        setTimeout(() => {
                            this.initializeBailey();
                        }, 10000);
                    } else {
                        console.log("❌ Não reconectando - muitas tentativas ou deslogado");
                        this.sessionManager.clearLocalSession();
                        this.qrAttempts = 0;
                    }
                }
            });

            this.sock.ev.on("creds.update", this.saveCreds);

            this.sock.ev.on("messages.upsert", async (m) => {
                try {
                    const msg = m.messages[0];
                    if (!msg.key.fromMe && m.type === "notify") {
                        const messageText =
                            msg.message?.conversation ||
                            msg.message?.extendedTextMessage?.text ||
                            null;

                        if (messageText) {
                            console.log("📩 Nova mensagem:", messageText.substring(0, 50) + "...");
                            await this.forwardToBackend(
                                msg.key.remoteJid,
                                messageText,
                                msg.key.id
                            );
                        }
                    }
                } catch (error) {
                    console.error("Erro processar mensagem:", error);
                }
            });
        } catch (error) {
            console.error("Erro Baileys:", error.message);
            this.isConnecting = false;
            setTimeout(() => this.initializeBailey(), 15000);
        }
    }

    async forwardToBackend(remoteJid, messageText, messageId) {
        try {
            const payload = {
                phone_number: remoteJid.split("@")[0],
                message: messageText,
                message_id: messageId,
            };

            console.log("🔗 Enviando para backend:", payload.phone_number);
            const response = await axios.post(CONFIG.backendUrl, payload, {
                timeout: 30000
            });

            if (response.data && response.data.response) {
                const reply = response.data.response;
                await this.sendMessage(remoteJid, reply);
                console.log("✅ Resposta enviada");
            }
        } catch (error) {
            console.error("❌ Erro no backend:", error.message);
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