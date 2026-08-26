const { Client, LocalAuth } = require('whatsapp-web.js');
const { processUserMessage } = require('./aiAgent');

// Armazena as instâncias em memória por tenant
const sessions = new Map();

async function getOrInitWhatsApp(tenantId) {
  if (sessions.has(tenantId)) {
    const existing = sessions.get(tenantId);
    if (existing.client) return existing;
  }

  const sessionState = {
    status: 'initializing',
    qrcode: null,
    client: null,
  };
  sessions.set(tenantId, sessionState);

  console.log(`[Tenant ${tenantId}] Inicializando WhatsApp Web...`);

  const client = new Client({
    authStrategy: new LocalAuth({
      clientId: `tenant_${tenantId}`,
      dataPath: './.wwebjs_auth'
    }),
    puppeteer: {
      headless: true,
      executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-accelerated-2d-canvas',
        '--no-first-run',
        '--no-zygote',
        '--disable-gpu'
      ]
    },
    webVersionCache: {
      type: 'remote',
      remotePath: 'https://raw.githubusercontent.com/wppconnect-team/wa-version/main/html/2.3000.1018944888-alpha.html',
    }
  });

  sessionState.client = client;

  client.on('qr', (qr) => {
    console.log(`⚡ [Tenant ${tenantId}] QR Code gerado.`);
    sessionState.status = 'qrcode';
    sessionState.qrcode = qr;
  });

  client.on('ready', () => {
    console.log(`✅ [Tenant ${tenantId}] WhatsApp pronto e operacional!`);
    sessionState.status = 'connected';
    sessionState.qrcode = null;
  });

  client.on('authenticated', () => {
    console.log(`🔑 [Tenant ${tenantId}] Autenticado com sucesso.`);
    sessionState.status = 'authenticated';
  });

  client.on('auth_failure', (msg) => {
    console.error(`❌ [Tenant ${tenantId}] Falha de autenticação:`, msg);
    sessionState.status = 'error';
  });

  client.on('disconnected', (reason) => {
    console.warn(`⚠️ [Tenant ${tenantId}] Desconectado:`, reason);
    sessionState.status = 'disconnected';
    sessionState.qrcode = null;
    sessions.delete(tenantId);
  });

  // Processamento de Mensagens
  client.on('message', async (msg) => {
    try {
      if (msg.from.includes('@g.us') || msg.isStatus || msg.fromMe) return;

      const customerPhone = msg.from.replace('@c.us', '');
      const customerName = msg._data?.notifyName || 'Cliente';
      const text = msg.body;

      console.log(`📩 [Tenant ${tenantId}] Msg de ${customerName} (${customerPhone}): ${text}`);

      const reply = await processUserMessage(tenantId, customerPhone, customerName, text);

      if (reply) {
        await client.sendMessage(msg.from, reply);
      }
    } catch (err) {
      console.error(`❌ [Tenant ${tenantId}] Erro ao processar mensagem:`, err);
    }
  });

  try {
    await client.initialize();
  } catch (initErr) {
    console.error(`❌ [Tenant ${tenantId}] Erro ao inicializar client:`, initErr);
    sessionState.status = 'error';
  }

  return sessionState;
}

function getWhatsAppStatus(tenantId) {
  if (!sessions.has(tenantId)) {
    return { status: 'disconnected', qrcode: null };
  }
  const session = sessions.get(tenantId);
  return {
    status: session.status,
    qrcode: session.qrcode
  };
}

module.exports = {
  getOrInitWhatsApp,
  getWhatsAppStatus,
};
