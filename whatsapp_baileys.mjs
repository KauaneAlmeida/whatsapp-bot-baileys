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
            this.clearLocalSession();
            fs.mkdirSync(this.sessionPath, { recursive: true });

            const [files] = await storageBucket.getFiles({ prefix: this.cloudPath });

            if (files.length === 0) {
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
                console.log("✅ Resposta enviada");
            } else {
                console.log("⚠️ Backend não retornou resposta");
            }
        } catch (err) {
            console.error("❌ Erro backend:", err.message);
            this.backendDownUntil = Date.now() + this.retryDelay;
            this.queue.push(task); // recoloca para tentar depois
        } finally {
            this.running--;
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

        this.seenMessages = new Map();
        this.seenMessagesTTL = 1000 * 60 * 5;
        setInterval(() => this.cleanupSeenMessages(), 60 * 1000);

        this.MAX_MESSAGE_AGE = 30;
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
            ${this.isConnected ? "<p>✅ Conectado com sucesso!</p>" : qrCodeBase64 ? `<img src="${qrCodeBase64}" alt="QR Code" style="max-width:300px;">` : "<p>⏳ Carregando QR...</p>"}
            </body></html>`;
            res.send(htmlContent);
        });

        this.server = app.listen(CONFIG.expressPort, "0.0.0.0", () => {
            console.log(`🚀 Server rodando na porta ${CONFIG.expressPort}`);
            this.initializeServices();
        });
    }

    async initializeServices() {
        this.modulesLoaded = await loadModules();
        this.baileysLoaded = this.modulesLoaded;
        if (!this.modulesLoaded) return;

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
        // ... (mesmo código do teu original para conectar no baileys)
        // não mexi aqui
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
                await this.sendMessage(remoteJid, reply);
            },
        });
    }

    async sendMessage(to, message) {
        if (!this.isConnected || !this.sock) {
            throw new Error("WhatsApp not connected");
        }
        const result = await this.sock.sendMessage(to, { text: message });
        return result.key.id;
    }
}

console.log("🚀 Iniciando WhatsApp Bot...");
new BaileysWhatsAppBot();
