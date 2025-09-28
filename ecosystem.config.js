const express = require('express');
const fs = require('fs');
const path = require('path');

// Firebase Admin SDK Integration
let firebaseDb = null;
let isFirebaseConnected = false;

async function initializeFirebase() {
    try {
        if (!process.env.FIREBASE_KEY) {
            console.log('⚠️ FIREBASE_KEY não encontrada - funcionando sem Firebase');
            return;
        }

        console.log('🔥 Inicializando Firebase Admin...');
        const admin = require('firebase-admin');
        const firebaseKey = JSON.parse(process.env.FIREBASE_KEY);
        const credential = admin.credential.cert(firebaseKey);
        
        if (!admin.apps.length) {
            admin.initializeApp({ credential });
        }
        
        firebaseDb = admin.firestore();
        
        // Teste de conexão
        await firebaseDb.collection('_health_check').doc('whatsapp_bot').set({
            timestamp: new Date(),
            service: 'whatsapp_baileys_bot',
            status: 'initialized'
        });
        
        isFirebaseConnected = true;
        console.log('✅ Firebase conectado com sucesso!');
        
    } catch (error) {
        console.error('❌ Erro ao inicializar Firebase:', error.message);
        isFirebaseConnected = false;
    }
}

// Função para salvar mensagem no Firebase
async function saveMessageToFirebase(from, message, direction = 'received') {
    try {
        if (!firebaseDb) return;
        
        await firebaseDb.collection('whatsapp_messages').add({
            from: from,
            message: message,
            direction: direction, // 'received' ou 'sent'
            timestamp: new Date(),
            bot_service: 'baileys',
            phone_clean: from.replace('@s.whatsapp.net', '')
        });
        
        console.log(`💾 Mensagem ${direction} salva no Firebase`);
    } catch (error) {
        console.error('❌ Erro ao salvar mensagem no Firebase:', error);
    }
}

// Função para buscar dados do usuário no Firebase
async function getUserDataFromFirebase(phoneNumber) {
    try {
        if (!firebaseDb) return null;
        
        const cleanPhone = phoneNumber.replace('@s.whatsapp.net', '');
        
        // Buscar na collection de leads
        const leadsSnapshot = await firebaseDb.collection('leads')
            .where('phone', '==', cleanPhone)
            .limit(1)
            .get();
            
        if (!leadsSnapshot.empty) {
            return leadsSnapshot.docs[0].data();
        }
        
        // Buscar também na collection de sessões
        const sessionSnapshot = await firebaseDb.collection('user_sessions')
            .doc(cleanPhone)
            .get();
            
        if (sessionSnapshot.exists) {
            return sessionSnapshot.data();
        }
        
        return null;
    } catch (error) {
        console.error('❌ Erro ao buscar dados do usuário:', error);
        return null;
    }
}

// Configuration - FIXED for Cloud Run
const CONFIG = {
    phoneNumber: process.env.WHATSAPP_PHONE_NUMBER || '+5511918368812',
    whatsappWebVersion: [2, 3000, 1026946712],
    sessionPath: './whatsapp_session',
    expressPort: process.env.PORT || 8081 // CORRIGIDO: usar PORT do Cloud Run
};

// Express app setup
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
        this.setupExpressServer();
    }

    setupExpressServer() {
        // Health check primeiro
        app.get('/health', (req, res) => {
            res.status(200).json({
                status: 'healthy',
                service: 'whatsapp_baileys_bot',
                connected: this.isConnected,
                firebase_connected: isFirebaseConnected,
                uptime: process.uptime(),
                timestamp: new Date().toISOString(),
                port: CONFIG.expressPort,
                firebase_key_configured: !!process.env.FIREBASE_KEY
            });
        });

        app.get('/', (req, res) => {
            res.json({
                service: 'WhatsApp Baileys Bot with Firebase',
                status: 'running',
                connected: this.isConnected,
                firebase_connected: isFirebaseConnected,
                endpoints: {
                    qr: '/qr',
                    health: '/health',
                    sendMessage: '/send-message',
                    sendWithContext: '/send-to-whatsapp-with-context',
                    qrStatus: '/api/qr-status'
                }
            });
        });

        app.get('/qr', async (req, res) => {
            try {
                const htmlContent = `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Connect your WhatsApp</title>
    <link href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.0/dist/css/bootstrap.min.css" rel="stylesheet">
    <style>
        body { background: linear-gradient(135deg, #25D366 0%, #128C7E 100%); min-height: 100vh; }
        .qr-container { background: white; border-radius: 20px; padding: 3rem; margin: 2rem auto; max-width: 500px; text-align: center; box-shadow: 0 10px 30px rgba(0,0,0,0.2); }
        .qr-code-img { max-width: 280px; border: 3px solid #25D366; border-radius: 15px; padding: 15px; background: white; }
        .title { color: #128C7E; font-weight: 700; margin-bottom: 1rem; }
        .subtitle { color: #666; font-size: 1rem; margin-top: 1rem; }
        .footer { margin-top: 2rem; font-size: 0.9rem; color: #888; }
        .refresh-btn { background: #25D366; border: none; border-radius: 25px; padding: 10px 25px; color: white; font-weight: 600; transition: all 0.3s ease; }
        .refresh-btn:hover { background: #128C7E; transform: translateY(-2px); }
        .status-connected { color: #28a745; font-size: 1.2rem; font-weight: bold; }
        .status-waiting { color: #ffc107; font-size: 1.1rem; font-weight: bold; }
        .spinner-border { width: 1rem; height: 1rem; margin-right: 0.5rem; }
        .firebase-status { margin-top: 1rem; font-size: 0.9rem; }
        .firebase-connected { color: #28a745; }
        .firebase-disconnected { color: #dc3545; }
    </style>
</head>
<body>
    <div class="container d-flex justify-content-center align-items-center min-vh-100">
        <div class="qr-container">
            <h1 class="title">Connect WhatsApp</h1>
            ${this.isConnected 
                ? '<div class="mb-3 status-connected">✅ Conectado com sucesso!</div>'
                : '<div class="mb-3 status-waiting"><div class="spinner-border text-warning" role="status"></div>Esperando conectar...</div>'}
            ${qrCodeBase64 && !this.isConnected
                ? `<div class="mb-3">
                     <img src="${qrCodeBase64}" class="qr-code-img" alt="WhatsApp QR Code">
                     <p class="subtitle">Scan this QR Code with WhatsApp</p>
                     <small class="text-muted">Open WhatsApp → Settings → Linked Devices → Link a Device</small>
                   </div>`
                : this.isConnected
                ? '<div class="mb-3"><p class="subtitle">WhatsApp está conectado e pronto!</p></div>'
                : '<div class="mb-3"><p class="subtitle">Gerando QR Code...</p></div>'}
            <button class="refresh-btn mt-3" onclick="window.location.reload()">Refresh</button>
            <div class="firebase-status">
                <strong>Firebase:</strong> 
                <span class="${isFirebaseConnected ? 'firebase-connected' : 'firebase-disconnected'}">
                    ${isFirebaseConnected ? '✅ Conectado' : '❌ Desconectado'}
                </span>
            </div>
            <div class="footer">
                <strong>WhatsApp Baileys Bot</strong><br>
                <small>${CONFIG.phoneNumber}</small><br>
                <small class="text-muted">Powered by Baileys + Firebase</small>
            </div>
        </div>
    </div>
</body>
</html>`;
                res.send(htmlContent);
            } catch (error) {
                console.error('Error serving QR page:', error);
                res.status(500).send("Error");
            }
        });

        app.get('/api/qr-status', (req, res) => {
            res.json({
                hasQR: !!qrCodeBase64,
                isConnected: this.isConnected,
                phoneNumber: CONFIG.phoneNumber,
                firebase_connected: isFirebaseConnected,
                timestamp: new Date().toISOString(),
                status: this.isConnected ? 'connected' : qrCodeBase64 ? 'waiting_for_scan' : 'generating_qr'
            });
        });

        app.post('/send-message', async (req, res) => {
            try {
                const { to, message } = req.body;
                if (!to || !message) {
                    return res.status(400).json({ success: false, error: 'Missing required fields: to, message' });
                }
                if (!this.isConnected) {
                    return res.status(503).json({ success: false, error: 'WhatsApp not connected. Please scan QR code first.' });
                }
                const messageId = await this.sendMessage(to, message);
                
                // Salvar no Firebase
                await saveMessageToFirebase(to, message, 'sent');
                
                res.json({ success: true, messageId, to, timestamp: new Date().toISOString() });
            } catch (error) {
                console.error('Error in send-message endpoint:', error);
                res.status(500).json({ success: false, error: error.message || 'Failed to send message' });
            }
        });

        app.post('/send-to-whatsapp-with-context', async (req, res) => {
            try {
                const { to, message, userData } = req.body;
                if (!to || !message || !userData) {
                    return res.status(400).json({ success: false, error: 'Missing required fields: to, message, userData' });
                }
                if (!this.isConnected) {
                    return res.status(503).json({ success: false, error: 'WhatsApp not connected. Please scan QR code first.' });
                }

                const contextMsg = `
Dados do cliente (via Landing Page):
- Nome: ${userData.name || 'Não informado'}
- Email: ${userData.email || 'Não informado'}
- Telefone: ${userData.phone || 'Não informado'}
- Área de interesse: ${userData.area || 'Não informado'}
- Descrição: ${userData.description || 'Não informado'}

Primeira mensagem do cliente:
${message}
                `;

                const messageId = await this.sendMessage(to, contextMsg);
                
                // Salvar no Firebase
                await saveMessageToFirebase(to, contextMsg, 'sent');
                
                res.json({ success: true, messageId, to, timestamp: new Date().toISOString() });
            } catch (error) {
                console.error('Error in send-to-whatsapp-with-context endpoint:', error);
                res.status(500).json({ success: false, error: error.message || 'Failed to send message with context' });
            }
        });

        // CRÍTICO: Iniciar servidor HTTP IMEDIATAMENTE
        this.server = app.listen(CONFIG.expressPort, '0.0.0.0', () => {
            console.log(`🌐 Express server running on PORT ${CONFIG.expressPort}`);
            console.log(`📱 QR Code page: http://localhost:${CONFIG.expressPort}/qr`);
            console.log(`❤️ Health check: http://localhost:${CONFIG.expressPort}/health`);
            console.log('✅ Server is ready to receive requests');
            
            // Inicializar Firebase primeiro, depois Baileys
            this.initializeServices();
        });

        this.server.on('error', (error) => {
            console.error('❌ Server error:', error);
            if (error.code === 'EADDRINUSE') {
                console.error(`Port ${CONFIG.expressPort} is already in use`);
                process.exit(1);
            }
        });
    }

    // Inicializar serviços na ordem correta
    async initializeServices() {
        console.log('🚀 Inicializando serviços...');
        
        // 1. Primeiro Firebase
        await initializeFirebase();
        
        // 2. Pequeno delay para estabilizar
        setTimeout(async () => {
            // 3. Depois Baileys
            await this.initializeBailey();
        }, 2000);
    }

    // Separar a inicialização do Baileys (CORRIGIDO)
    async initializeBailey() {
        console.log('📱 Carregando dependências do Baileys...');
        
        try {
            // IMPORTAÇÃO CORRIGIDA DO BAILEYS
            const baileys = require('@whiskeysockets/baileys');
            
            // Correct Baileys imports
            const { makeWASocket, DisconnectReason, useMultiFileAuthState } = baileys;
            
            // Verificar se conseguimos as funções necessárias
            if (typeof makeWASocket !== 'function') {
                throw new Error(`makeWASocket is not a function. Type: ${typeof makeWASocket}`);
            }
            
            if (!DisconnectReason) {
                throw new Error('DisconnectReason not found');
            }
            
            if (typeof useMultiFileAuthState !== 'function') {
                throw new Error('useMultiFileAuthState is not a function');
            }
            
            const { Boom } = require('@hapi/boom');
            const qrcode = require('qrcode-terminal');
            const QRCode = require('qrcode');
            
            console.log('✅ Dependências do Baileys carregadas com sucesso');
            console.log('📋 makeWASocket:', typeof makeWASocket);
            console.log('📋 DisconnectReason:', typeof DisconnectReason);
            console.log('📋 useMultiFileAuthState:', typeof useMultiFileAuthState);
            
            if (!fs.existsSync(CONFIG.sessionPath)) {
                fs.mkdirSync(CONFIG.sessionPath, { recursive: true });
            }

            const { state, saveCreds } = await useMultiFileAuthState(CONFIG.sessionPath);
            this.authState = state;
            this.saveCreds = saveCreds;

            await this.connectToWhatsApp(makeWASocket, DisconnectReason, Boom, qrcode, QRCode);
            
        } catch (error) {
            console.error('❌ Erro ao inicializar Baileys:', error);
            console.error('🔍 Stack trace completo:', error.stack);
            
            // Retry após 10 segundos
            setTimeout(() => {
                console.log('🔄 Tentando reinicializar Baileys...');
                this.initializeBailey();
            }, 10000);
        }
    }

    async connectToWhatsApp(makeWASocket, DisconnectReason, Boom, qrcode, QRCode) {
        try {
            console.log('🔌 Conectando ao WhatsApp Web...');
            
            // Configurações otimizadas para evitar timeout de QR
            this.sock = makeWASocket({
                auth: this.authState,
                version: CONFIG.whatsappWebVersion,
                printQRInTerminal: false,
                browser: ['WhatsApp Baileys Bot', 'Chrome', '110.0.5481.77'],
                defaultQueryTimeoutMs: 30000,
                connectTimeoutMs: 30000,
                keepAliveIntervalMs: 30000,
                markOnlineOnConnect: false,
                generateHighQualityLinkPreview: false,
                syncFullHistory: false,
                shouldSyncHistoryMessage: () => false,
                shouldIgnoreJid: () => false,
                patchMessageBeforeSending: (msg) => msg,
                retryRequestDelayMs: 250,
                maxMsgRetryCount: 3,
                // Configurações específicas para QR code
                qrTimeout: 120000, // 2 minutos
                connectCooldownMs: 5000
            });
            
            this.setupEventHandlers(DisconnectReason, Boom, qrcode, QRCode);
        } catch (error) {
            console.error('❌ Erro ao conectar WhatsApp:', error);
            console.error('🔍 Stack trace:', error.stack);
            
            // Retry conexão após delay
            setTimeout(() => {
                console.log('🔄 Tentando reconectar...');
                this.connectToWhatsApp(makeWASocket, DisconnectReason, Boom, qrcode, QRCode);
            }, 10000);
        }
    }

    setupEventHandlers(DisconnectReason, Boom, qrcode, QRCode) {
        // Contador para QR code attempts
        let qrAttempts = 0;
        const maxQRAttempts = 5;
        
        this.sock.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect, qr } = update;

            if (qr) {
                qrAttempts++;
                console.log(`📱 QR Code gerado (tentativa ${qrAttempts}/${maxQRAttempts})`);
                console.log(`🔗 Acesse IMEDIATAMENTE: http://localhost:${CONFIG.expressPort}/qr`);
                
                // Mostrar QR no terminal
                qrcode.generate(qr, { small: true });

                try {
                    // Gerar QR para web com configurações otimizadas
                    qrCodeBase64 = await QRCode.toDataURL(qr, {
                        width: 320,
                        margin: 3,
                        color: { dark: '#000000', light: '#FFFFFF' },
                        errorCorrectionLevel: 'M'
                    });
                    console.log('✅ QR Code pronto para display web - ESCANEIE AGORA!');
                    
                    // Log de urgência
                    console.log('⚠️ IMPORTANTE: QR Code expira em ~40 segundos!');
                    
                } catch (err) {
                    console.error('❌ Erro ao gerar QR code para web:', err);
                }
                
                // Se muitas tentativas de QR, limpar sessão
                if (qrAttempts >= maxQRAttempts) {
                    console.log('⚠️ Muitas tentativas de QR. Limpando sessão...');
                    try {
                        // Limpar arquivos de sessão
                        if (fs.existsSync(CONFIG.sessionPath)) {
                            fs.rmSync(CONFIG.sessionPath, { recursive: true, force: true });
                        }
                        qrAttempts = 0;
                        
                        // Reinicializar após limpar
                        setTimeout(() => {
                            this.initializeBailey();
                        }, 5000);
                    } catch (cleanError) {
                        console.error('❌ Erro ao limpar sessão:', cleanError);
                    }
                }
            }

            if (connection === 'close') {
                this.isConnected = false;
                qrCodeBase64 = null;
                qrAttempts = 0; // Reset QR attempts on close
                
                const shouldReconnect = (lastDisconnect?.error instanceof Boom)
                    ? lastDisconnect.error.output.statusCode !== DisconnectReason.loggedOut
                    : true;

                console.log('❌ Conexão fechada:', lastDisconnect?.error?.message || 'Motivo desconhecido');
                
                // Log detalhado do erro
                if (lastDisconnect?.error) {
                    console.log('🔍 Código do erro:', lastDisconnect.error.output?.statusCode);
                    console.log('🔍 Detalhes:', lastDisconnect.error.message);
                }
                
                if (shouldReconnect) {
                    const reconnectDelay = lastDisconnect?.error?.message?.includes('QR refs attempts ended') ? 30000 : 10000;
                    console.log(`🔄 Reconectando em ${reconnectDelay/1000} segundos...`);
                    
                    setTimeout(() => {
                        // Limpar socket antigo
                        if (this.sock) {
                            try {
                                this.sock.end();
                            } catch (e) {
                                console.log('⚠️ Erro ao fechar socket antigo:', e.message);
                            }
                        }
                        this.initializeBailey();
                    }, reconnectDelay);
                } else {
                    console.log('❌ Não reconectando (usuário foi deslogado)');
                }
            } else if (connection === 'open') {
                console.log('✅ WhatsApp conectado com sucesso!');
                this.isConnected = true;
                qrCodeBase64 = null;
                qrAttempts = 0; // Reset QR attempts on successful connection
                
                const user = this.sock.user;
                if (user) {
                    console.log(`👤 Conectado como: ${user.name || user.id}`);
                    console.log(`📞 Número: ${user.id?.split('@')[0] || 'Desconhecido'}`);
                }
            } else if (connection === 'connecting') {
                console.log('🔄 Conectando ao WhatsApp...');
            }
        });

        // Melhor tratamento de erro para credentials
        this.sock.ev.on('creds.update', async () => {
            try {
                await this.saveCreds();
                console.log('💾 Credenciais salvas');
            } catch (error) {
                console.error('❌ Erro ao salvar credenciais:', error);
            }
        });

        this.sock.ev.on('messages.upsert', async (m) => {
            try {
                const msg = m.messages[0];
                if (!msg.key.fromMe && m.type === 'notify') {
                    const messageText = msg.message?.conversation || msg.message?.extendedTextMessage?.text || null;
                    if (messageText) {
                        console.log('📩 Nova mensagem de', msg.key.remoteJid, ':', messageText.substring(0, 50) + '...');
                        
                        // Salvar mensagem recebida no Firebase
                        await saveMessageToFirebase(msg.key.remoteJid, messageText, 'received');
                        
                        // Processar comandos especiais para Firebase
                        await this.processSpecialCommands(msg.key.remoteJid, messageText);
                        
                        // Encaminhar para backend
                        await this.forwardToBackend(msg.key.remoteJid, messageText, msg.key.id);
                    }
                }
            } catch (error) {
                console.error('❌ Erro ao processar mensagem recebida:', error);
            }
        });

        // Handle socket errors
        this.sock.ev.on('connection.error', (error) => {
            console.error('❌ Connection error:', error);
        });
    }

    // Processar comandos especiais relacionados ao Firebase
    async processSpecialCommands(from, message) {
        try {
            const lowerMessage = message.toLowerCase().trim();
            
            if (lowerMessage === '!meusdados' || lowerMessage === '!dados') {
                const userData = await getUserDataFromFirebase(from);
                
                if (userData) {
                    const answers = userData.answers || [];
                    let dataText = '📋 *Seus dados cadastrados:*\n\n';
                    
                    answers.forEach((answer, index) => {
                        dataText += `${index + 1}. ${answer}\n`;
                    });
                    
                    dataText += `\n📅 Cadastrado em: ${userData.created_at?.toDate?.() || userData.timestamp?.toDate?.() || 'Data não disponível'}`;
                    
                    await this.sendMessage(from, dataText);
                } else {
                    await this.sendMessage(from, '❌ Não encontrei seus dados cadastrados. Você já preencheu nosso formulário de captação?\n\nPara se cadastrar, entre em contato conosco.');
                }
                return;
            }
            
            if (lowerMessage === '!firebase' || lowerMessage === '!status') {
                const statusMsg = `🔥 *Status Firebase:* ${isFirebaseConnected ? '✅ Conectado' : '❌ Desconectado'}\n📱 *WhatsApp:* ✅ Conectado\n⏰ *Timestamp:* ${new Date().toLocaleString('pt-BR')}`;
                await this.sendMessage(from, statusMsg);
                return;
            }
            
        } catch (error) {
            console.error('❌ Erro ao processar comandos especiais:', error);
        }
    }

    async forwardToBackend(from, message, messageId) {
        try {
            const webhookUrl = process.env.FASTAPI_WEBHOOK_URL || 'http://law_firm_backend:8000/api/v1/whatsapp/webhook';
            const sessionId = `whatsapp_${from.replace('@s.whatsapp.net', '')}`;
            const payload = { 
                from, 
                message, 
                messageId, 
                sessionId, 
                timestamp: new Date().toISOString(), 
                platform: 'whatsapp',
                firebase_available: isFirebaseConnected
            };

            console.log('🔗 Encaminhando para backend:', message.substring(0, 50) + '...');
            
            const fetch = globalThis.fetch || require('node-fetch');
            const response = await fetch(webhookUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload),
                timeout: 30000
            });
            
            if (response.ok) {
                const responseData = await response.json();
                console.log('✅ Mensagem encaminhada com sucesso');
                if (responseData.response) {
                    await this.sendMessage(from, responseData.response);
                    // Salvar resposta do bot no Firebase
                    await saveMessageToFirebase(from, responseData.response, 'sent');
                }
            } else {
                const fallbackMsg = "Desculpe, estou enfrentando dificuldades técnicas. Nossa equipe foi notificada e entrará em contato em breve.";
                await this.sendMessage(from, fallbackMsg);
                await saveMessageToFirebase(from, fallbackMsg, 'sent');
            }
        } catch (error) {
            console.error('❌ Erro ao encaminhar para backend:', error);
            try {
                const fallbackMsg = "Desculpe, estou enfrentando dificuldades técnicas. Nossa equipe foi notificada e entrará em contato em breve.";
                await this.sendMessage(from, fallbackMsg);
                await saveMessageToFirebase(from, fallbackMsg, 'sent');
            } catch (sendError) {
                console.error('❌ Falha ao enviar mensagem de fallback:', sendError);
            }
        }
    }

    async sendMessage(to, message) {
        if (!this.isConnected || !this.sock) throw new Error('WhatsApp not connected');
        try {
            const result = await this.sock.sendMessage(to, { text: message });
            console.log('✅ Mensagem enviada com sucesso:', result.key.id);
            return result.key.id;
        } catch (error) {
            console.error('❌ Erro ao enviar mensagem:', error);
            throw error;
        }
    }
}

// Inicialização
console.log('🚀 Baileys WhatsApp Bot com Firebase iniciando...');
console.log(`🌐 Servidor iniciará na PORTA ${CONFIG.expressPort}`);
console.log(`🔥 Firebase: ${process.env.FIREBASE_KEY ? 'Configurado' : 'Não configurado'}`);

const bot = new BaileysWhatsAppBot();

process.on('SIGTERM', () => {
    console.log('🔄 Finalizando graciosamente...');
    process.exit(0);
});

process.on('SIGINT', () => {
    console.log('🔄 Finalizando graciosamente...');
    process.exit(0);
});

console.log('✅ Inicialização do bot concluída')