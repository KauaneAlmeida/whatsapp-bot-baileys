global.crypto = require("crypto"); // 🔹 Fix do erro "crypto is not defined"
const express = require('express');
const fs = require('fs');
const path = require('path');

// 🔹 Firebase desativado por enquanto
// let firebaseDb = null;
// let firebaseStorage = null;
// let storageBucket = null;
// let isFirebaseConnected = false;

class MessageRateLimit {
    constructor() {
        this.lastMessages = new Map();
        this.cooldownMs = 30000;
    }
    
    canSendFallback(from) {
        const now = Date.now();
        const lastTime = this.lastMessages.get(from);
        
        if (!lastTime || (now - lastTime) > this.cooldownMs) {
            this.lastMessages.set(from, now);
            return true;
        }
        
        return false;
    }
}

// 🔹 CloudSessionManager desativado por enquanto
// class CloudSessionManager { ... }

const CONFIG = {
    phoneNumber: process.env.WHATSAPP_PHONE_NUMBER || '+5511918368812',
    whatsappWebVersion: [2, 3000, 1026946712],
    sessionPath: './whatsapp_session',
    expressPort: process.env.PORT || 8080
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
        this.rateLimit = new MessageRateLimit();
        this.setupExpressServer();
    }

    setupExpressServer() {
        app.get('/health', (req, res) => {
            res.status(200).json({
                status: 'healthy',
                connected: this.isConnected,
                uptime: process.uptime(),
                timestamp: new Date().toISOString()
            });
        });

        app.get('/', (req, res) => {
            res.json({
                service: 'WhatsApp Baileys Bot',
                status: 'running',
                connected: this.isConnected
            });
        });

        app.get('/qr', async (req, res) => {
            const htmlContent = `
<!DOCTYPE html>
<html>
<head>
    <title>WhatsApp QR</title>
    <style>
        body { font-family: Arial; text-align: center; padding: 50px; }
        .qr-img { max-width: 300px; }
    </style>
</head>
<body>
    <h1>WhatsApp Bot</h1>
    ${this.isConnected 
        ? '<p>Conectado!</p>' 
        : qrCodeBase64 
            ? `<img src="${qrCodeBase64}" class="qr-img" alt="QR Code">` 
            : '<p>Carregando...</p>'
    }
    <button onclick="location.reload()">Refresh</button>
</body>
</html>`;
            res.send(htmlContent);
        });

        app.post('/send-message', async (req, res) => {
            try {
                const { to, message } = req.body;
                if (!to || !message) {
                    return res.status(400).json({ error: 'Missing fields' });
                }
                if (!this.isConnected) {
                    return res.status(503).json({ error: 'Not connected' });
                }
                
                const messageId = await this.sendMessage(to, message);
                res.json({ success: true, messageId });
            } catch (error) {
                res.status(500).json({ error: error.message });
            }
        });

        this.server = app.listen(CONFIG.expressPort, '0.0.0.0', () => {
            console.log(`Server running on port ${CONFIG.expressPort}`);
            this.initializeServices();
        });
    }

    async initializeServices() {
        console.log('Inicializando serviços...');
        setTimeout(async () => {
            await this.initializeBailey();
        }, 2000);
    }

    async initializeBailey() {
        console.log('Carregando Baileys...');
        
        try {
            const { 
                default: makeWASocket,
                DisconnectReason,
                useMultiFileAuthState
            } = require('@whiskeysockets/baileys');
            
            const { Boom } = require('@hapi/boom');
            const qrcode = require('qrcode-terminal');
            const QRCode = require('qrcode');
            
            if (!fs.existsSync(CONFIG.sessionPath)) {
                fs.mkdirSync(CONFIG.sessionPath, { recursive: true });
            }

            const { state, saveCreds } = await useMultiFileAuthState(CONFIG.sessionPath);
            this.authState = state;
            this.saveCreds = saveCreds;

            await this.connectToWhatsApp(makeWASocket, DisconnectReason, Boom, qrcode, QRCode);
            
        } catch (error) {
            console.error('Erro Baileys:', error.message);
            setTimeout(() => this.initializeBailey(), 10000);
        }
    }

    async connectToWhatsApp(makeWASocket, DisconnectReason, Boom, qrcode, QRCode) {
        try {
            this.sock = makeWASocket({
                auth: this.authState,
                printQRInTerminal: false,
                browser: ['Bot', 'Chrome', '110.0.0']
            });
            
            this.setupEventHandlers(DisconnectReason, Boom, qrcode, QRCode);
        } catch (error) {
            console.error('Erro conectar:', error);
            setTimeout(() => {
                this.connectToWhatsApp(makeWASocket, DisconnectReason, Boom, qrcode, QRCode);
            }, 10000);
        }
    }

    setupEventHandlers(DisconnectReason, Boom, qrcode, QRCode) {
        this.sock.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect, qr } = update;

            if (qr) {
                console.log('QR Code gerado');
                qrcode.generate(qr, { small: true });

                try {
                    qrCodeBase64 = await QRCode.toDataURL(qr);
                } catch (err) {
                    console.error('Erro QR:', err);
                }
            }

            if (connection === 'close') {
                this.isConnected = false;
                qrCodeBase64 = null;
                
                const shouldReconnect = (lastDisconnect?.error instanceof Boom)
                    ? lastDisconnect.error.output.statusCode !== DisconnectReason.loggedOut
                    : true;

                if (shouldReconnect) {
                    setTimeout(() => {
                        this.initializeBailey();
                    }, 5000);
                }
            } else if (connection === 'open') {
                console.log('WhatsApp conectado!');
                this.isConnected = true;
                qrCodeBase64 = null;
            }
        });

        this.sock.ev.on('creds.update', async () => {
            try {
                await this.saveCreds();
            } catch (error) {
                console.error('Erro salvar credenciais:', error);
            }
        });

        // 🔹 Aqui entra a resposta automática (Opção 1)
        this.sock.ev.on('messages.upsert', async (m) => {
            try {
                const msg = m.messages[0];
                if (!msg.key.fromMe && m.type === 'notify') {
                    const messageText = msg.message?.conversation || msg.message?.extendedTextMessage?.text || null;
                    if (messageText) {
                        console.log('Nova mensagem recebida:', messageText.substring(0, 50));

                        // ✅ Resposta automática simples
                        await this.sendMessage(
                            msg.key.remoteJid, 
                            "✅ Recebi sua mensagem: " + messageText
                        );
                    }
                }
            } catch (error) {
                console.error('Erro processar mensagem:', error);
            }
        });
    }

    async sendMessage(to, message) {
        if (!this.isConnected || !this.sock) {
            throw new Error('WhatsApp not connected');
        }
        
        try {
            const result = await this.sock.sendMessage(to, { text: message });
            return result.key.id;
        } catch (error) {
            console.error('Erro enviar:', error);
            throw error;
        }
    }
}

console.log('Iniciando WhatsApp Bot...');
const bot = new BaileysWhatsAppBot();

process.on('SIGTERM', () => {
    console.log('Finalizando...');
    process.exit(0);
});

process.on('SIGINT', () => {
    console.log('Finalizando...');
    process.exit(0);
});

console.log('Bot iniciado');
