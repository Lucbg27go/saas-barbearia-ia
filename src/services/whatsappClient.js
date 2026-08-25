const { Client, LocalAuth } = require('whatsapp-web.js');
const QRCode = require('qrcode');
const { handleCustomerChat } = require('./aiAgent');
const fs = require('fs');
const path = require('path');

// Mapa para gerenciar múltiplas instâncias em memória
// Estrutura: Map<tenantId, { client, status, qrcode, startTime, isInitializing }>
const sessions = new Map();

const macChromePath = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const linuxChromePath = '/usr/bin/google-chrome-stable';
const executablePath = fs.existsSync(macChromePath)
  ? macChromePath
  : fs.existsSync(linuxChromePath)
  ? linuxChromePath
  : undefined;

async function getOrInitWhatsApp(tenantId) {
  if (!tenantId) throw new Error('Tenant ID é obrigatório.');

  let session = sessions.get(tenantId);

  // Se a sessão já existe e está conectada ou inicializando, retorna o estado atual
  if (session && (session.status === 'connected' || session.isInitializing)) {
    return session;
  }

  // Cria entrada de sessão caso não exista
  if (!session) {
    session = {
      client: null,
      status: 'connecting',
      qrcode: null,
      startTime: Math.floor(Date.now() / 1000),
      isInitializing: true,
    };
    sessions.set(tenantId, session);
  } else {
    session.isInitializing = true;
    session.status = 'connecting';
  }

  console.log(`🔄 [Tenant ${tenantId}] Inicializando WhatsApp Web dedicado...`);

  // Pasta de sessão isolada por barbearia
  const sessionDir = path.join(__dirname, `../../wwebjs_auth/session_${tenantId}`);

  const client = new Client({
    authStrategy: new LocalAuth({
      clientId: `tenant_${tenantId}`,
      dataPath: './wwebjs_auth',
    }),
    puppeteer: {
      headless: true,
      executablePath: executablePath,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-accelerated-2d-canvas',
        '--no-first-run',
        '--no-zygote',
        '--disable-gpu',
      ],
    },
  });

  session.client = client;

  client.on('qr', async (qr) => {
    try {
      session.qrcode = await QRCode.toDataURL(qr);
      session.status = 'connecting';
      console.log(`⚡ [Tenant ${tenantId}] QR Code gerado.`);
    } catch (err) {
      console.error(`[Tenant ${tenantId}] Erro ao gerar QR:`, err.message);
    }
  });

  client.on('ready', () => {
    session.status = 'connected';
    session.qrcode = null;
    session.isInitializing = false;
    session.startTime = Math.floor(Date.now() / 1000);
    console.log(`✅ [Tenant ${tenantId}] Conectado e operacional!`);
  });

  client.on('authenticated', () => {
    console.log(`🔑 [Tenant ${tenantId}] Sessão autenticada!`);
  });

  client.on('auth_failure', (msg) => {
    console.error(`❌ [Tenant ${tenantId}] Falha de autenticação:`, msg);
    session.status = 'disconnected';
    session.qrcode = null;
    session.isInitializing = false;
  });

  client.on('disconnected', async () => {
    console.log(`❌ [Tenant ${tenantId}] Desconectado pelo WhatsApp.`);
    session.status = 'disconnected';
    session.qrcode = null;
    session.isInitializing = false;
    try {
      await client.destroy();
    } catch (e) {}
    sessions.delete(tenantId);
  });

  client.on('message', async (msg) => {
    if (msg.timestamp < session.startTime) return;
    if (msg.fromMe || msg.isGroupMsg || msg.from === 'status@broadcast') return;

    const from = msg.from;
    const text = msg.body;
    const contact = await msg.getContact();
    const customerName = contact.pushname || contact.name || 'Cliente';
    const customerPhone = from.replace('@c.us', '');

    console.log(`📩 [Tenant ${tenantId}] Msg de ${customerName} (${customerPhone}): ${text}`);

    try {
      // Passa o tenantId dinâmico para carregar os serviços e agenda corretos dessa barbearia
      const reply = await handleCustomerChat(tenantId, customerPhone, customerName, text);
      if (reply) {
        await client.sendMessage(from, reply);
      }
    } catch (err) {
      console.error(`[Tenant ${tenantId}] Erro na resposta IA:`, err.message);
    }
  });

  client.initialize().catch((err) => {
    console.error(`❌ [Tenant ${tenantId}] Erro ao inicializar Puppeteer:`, err.message);
    session.isInitializing = false;
    sessions.delete(tenantId);
  });

  return session;
}

function getWhatsAppStatus(tenantId) {
  const session = sessions.get(tenantId);
  if (!session) {
    return { status: 'disconnected', qrcode: null };
  }
  return {
    status: session.status,
    qrcode: session.qrcode,
  };
}

module.exports = {
  getOrInitWhatsApp,
  getWhatsAppStatus,
};
