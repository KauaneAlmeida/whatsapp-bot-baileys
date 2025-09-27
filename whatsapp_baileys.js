const express = require('express');
const fs = require('fs');
const path = require('path');

let firebaseDb = null;
let firebaseStorage = null;
let storageBucket = null;
let isFirebaseConnected = false;

const initializeFirebase = async () => {
    try {
        if (!process.env.FIREBASE_KEY) {
            console.log('Firebase não configurado');
            return;
        }

        const admin = require('firebase-admin');
        const firebaseKey = JSON.parse(process.env.FIREBASE_KEY);
        const credential = admin.credential.cert(firebaseKey);
        
        if (!admin.apps.length) {
            admin.initializeApp({ 
                credential,
                storageBucket: process.env.FIREBASE_STORAGE_BUCKET || 'whatsapp-sessions-exalted-kayak-472517-s4-1758254195'
            });
        }
        
        firebaseDb = admin.firestore();
        firebaseStorage = admin.storage();
        storageBucket = firebaseStorage.bucket();
        
        await firebaseDb.collection('_health_check').doc('whatsapp_bot').set({
            timestamp: new Date(),
            service: 'whatsapp_baileys_bot',
            status: 'initialized'
        });
        
        isFirebaseConnected = true;
        console.log('Firebase conectado');
        
    } catch (error) {
        console.error('Erro Firebase:', error.message);
        isFirebaseConnected = false;
    }
};

const saveMessageToFirebase = async (from, message, direction = 'received') => {
    try {
        if (!firebaseDb) return;
        
        await firebaseDb.collection('whatsapp_messages').add({
            from: from,
            message: message,
            direction: direction,
            timestamp: new Date(),
            bot_service: 'baileys',
            phone_clean: from.replace('@s.whatsapp.net', '')
        });
        
        console.log(`Mensagem ${direction} salva`);
    } catch (error) {
        console.error('Erro ao salvar mensagem:', error);
    }
};

const getUserDataFromFirebase = async (phoneNumber) => {
    try {
        if (!firebaseDb) return null;
        
        const cleanPhone = phoneNumber.replace('@s.whatsapp.net', '');
        
        const leadsSnapshot = await firebaseDb.collection('leads')
            .where('phone', '==', cleanPhone)
            .limit(1)
            .get();
            
        if (!leadsSnapshot.empty) {
            return leadsSnapshot.docs[0].data();
        }
        
        return null;
    } catch (error) {
        console.error('Erro ao buscar dados:', error);
        return null;
    }
};

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

class CloudSessionManager {
    constructor() {
        this.sessionPath = './whatsapp_session';
        this.cloudPath = 'whatsapp-sessions/baileys-session';
        this.backupInterval = 5 * 60 * 1000;
        this.lastBackup = 0;
    }

    async downloadSession() {
        try {
            if (!storageBucket) {
                console.log('Storage não disponível');
                return false;
            }

            console.log('Baixando sessão...');
            
            if (!fs.existsSync(this.sessionPath)) {
                fs.mkdirSync(this.sessionPath, { recursive: true });
            }

            const [files] = await storageBucket.getFiles({
                prefix: this.cloudPath
            });

            if (files.length === 0) {
                console.log('Nenhuma sessão no cloud');
                return false;
            }

            for (const file of files) {
                const fileName = file.name.replace(`${this.cloudPath}/`, '');
                const localPath = path.join(this.sessionPath, fileName);
                
                try {
                    await file.download({ destination: localPath });
                    console.log(`Baixado: ${fileName}`);
                } catch (downloadError) {
                    console.error(`Erro ao baixar ${fileName}:`, downloadError.message);
                }
            }

            console.log('Sessão restaurada');
            return true;

        } catch (error) {
            console.error('Erro ao baixar sessão:', error.message);
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
            let uploadedFiles = 0;

            for (const fileName of files) {
                const localPath = path.join(this.sessionPath, fileName);
                const cloudPath = `${this.cloudPath}/${fileName}`;

                try {
                    const stats = fs.statSync(localPath);
                    if (stats.isFile()) {
                        await storageBucket.upload(localPath, {
                            destination: cloudPath,
                            metadata: {
                                contentType: 'application/octet-stream'
                            }
                        });
                        uploadedFiles++;
                    }
                } catch (uploadError) {
                    console.error(`Erro upload ${fileName}:`, uploadError.message);
                }
            }

            this.lastBackup = now;
            console.log(`Backup: ${uploadedFiles} arquivos`);
            return true;

        } catch (error) {
            console.error('Erro backup:', error.message);
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

    async clearSession() {
        try {
            if (fs.existsSync(this.sessionPath)) {
                fs.rmSync(this.sessionPath, { recursive: true, force: true });
            }

            if (storageBucket) {
                const [files] = await storageBucket.getFiles({
                    prefix: this.cloudPath
                });

                for (const file of files) {
                    await file.delete();
                }
            }

            console.log('Sessão limpa');
        } catch (error) {
            console.error('Erro limpar sessão:', error);
        }
    }
}

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
        this.sessionManager = new CloudSessionManager();
        this.setupExpressServer();
    }

    setupExpressServer() {
        app.get('/health', (req, res) => {
            res.status(200).json({
                status: 'healthy',
                connected: this.isConnected,
                firebase_connected: isFirebaseConnected,
                uptime: process.uptime(),
                timestamp: new Date().toISOString()
            });
        });

        app.get('/', (req, res) => {
            res.json({
                service: 'WhatsApp Baileys Bot',
                status: 'running',
                connected: this.isConnected,
                firebase_connected: isFirebaseConnected
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
                await saveMessageToFirebase(to, message, 'sent');
                
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
        
        await initializeFirebase();
        
        if (isFirebaseConnected) {
            this.sessionManager.startAutoBackup();
            await this.sessionManager.downloadSession();
        }
        
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
                
                setTimeout(async () => {
                    await this.sessionManager.uploadSession();
                }, 5000);
            }
        });

        this.sock.ev.on('creds.update', async () => {
            try {
                await this.saveCreds();
            } catch (error) {
                console.error('Erro salvar credenciais:', error);
            }
        });

        this.sock.ev.on('messages.upsert', async (m) => {
            try {
                const msg = m.messages[0];
                if (!msg.key.fromMe && m.type === 'notify') {
                    const messageText = msg.message?.conversation || msg.message?.extendedTextMessage?.text || null;
                    if (messageText) {
                        console.log('Nova mensagem:', messageText.substring(0, 50));
                        await saveMessageToFirebase(msg.key.remoteJid, messageText, 'received');
                        await this.forwardToBackend(msg.key.remoteJid, messageText, msg.key.id);
                    }
                }
            } catch (error) {
                console.error('Erro processar mensagem:', error);
            }
        });
    }

    async forwardToBackend(from, message, messageId) {
        try {
            const webhookUrl = process.env.FASTAPI_WEBHOOK_URL || 'https://law-firm-backend-936902782519-936902782519.us-central1.run.app/api/v1/whatsapp/webhook';
            
            const payload = { 
                from, 
                message, 
                messageId, 
                timestamp: new Date().toISOString(),
                platform: 'whatsapp'
            };

            const fetch = globalThis.fetch || require('node-fetch');
            
            const response = await fetch(webhookUrl, {
                method: 'POST',
                headers: { 
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify(payload)
            });
            
            if (response.ok) {
                const responseText = await response.text();
                
                let responseData = null;
                try {
                    responseData = JSON.parse(responseText);
                } catch (parseError) {
                    console.error('Erro parse JSON:', parseError);
                    return;
                }
                
                if (responseData && responseData.response && responseData.response.trim() !== '') {
                    await this.sendMessage(from, responseData.response);
                    await saveMessageToFirebase(from, responseData.response, 'sent');
                }
            } else {
                console.error('Erro HTTP:', response.status);
            }
        } catch (error) {
            console.error('Erro backend:', error.message);
        }
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