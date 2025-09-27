global.crypto = require("crypto"); // Fix para "crypto is not defined"
const express = require("express");
const fs = require("fs");
const path = require("path");
const axios = require("axios");
const qrcode = require("qrcode-terminal");
const QRCode = require("qrcode");

// 🔹 Firebase Storage (apenas para gerenciar sessão)
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
        this.authState = null;
        this.saveCreds = null;
        this.server = null;
        this.sessionManager = new CloudSessionManager();
        this.setupExpressServer();
    }

    setupExpressServer() {
        app.get("/health", (req, res) => {
            res.status(200).json({
                status: "healthy",
                connected: this.isConnected,
                firebase_connected: isFirebaseConnected,
                uptime: process.uptime(),
                timestamp: new Date().toISOString(),
            });
        });

        app.get("/qr", async (req, res) => {
            const htmlContent = `
<!DOCTYPE html>
<html>
<head><title>WhatsApp QR</title></head>
<body>
    <h1>WhatsApp Bot</h1>
    ${
        this.isConnected
            ? "<p>✅ Conectado!</p>"
            : qrCodeBase64
            ? `<img src="${qrCodeBase64}" alt="QR Code">`
            : "<p>Carregando QR...</p>"
    }
    <button onclick="location.reload()">Refresh</button>
</body>
</html>`;
            res.send(htmlContent);
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
                printQRInTerminal: false, // desativado para não bugar
                browser: ["Bot", "Chrome", "110.0.0"],
            });

            this.sock.ev.on("connection.update", async (update) => {
                const { connection, qr } = update;
                if (qr) {
                    // QR no terminal
                    qrcode.generate(qr, { small: true });
                    // QR no navegador
                    qrCodeBase64 = await QRCode.toDataURL(qr);
                    console.log("📲 Novo QR Code gerado, escaneie no celular!");
                }
                if (connection === "open") {
                    console.log("✅ WhatsApp conectado");
                    this.isConnected = true;
                    await this.sessionManager.uploadSession();
                }
                if (connection === "close") {
                    this.isConnected = false;
                    console.log("⚠️ Conexão fechada, limpando sessão e tentando reconectar...");
                    this.sessionManager.clearLocalSession();
                    setTimeout(() => this.initializeBailey(), 5000);
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
                            console.log("📩 Nova mensagem recebida:", messageText);
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
            setTimeout(() => this.initializeBailey(), 10000);
        }
    }

    async forwardToBackend(remoteJid, messageText, messageId) {
        try {
            const payload = {
                phone_number: remoteJid.split("@")[0],
                message: messageText,
                message_id: messageId,
            };

            const response = await axios.post(CONFIG.backendUrl, payload);

            if (response.data && response.data.response) {
                const reply = response.data.response;
                await this.sendMessage(remoteJid, reply);
            }
        } catch (error) {
            console.error("❌ Erro no forwardToBackend:", error.message);
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