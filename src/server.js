require('dotenv').config();
const express = require('express');
const cors = require('cors');

// Importação resiliente dos serviços
const whatsappService = require('./services/whatsappService') || {};
const whatsappClient = require('./services/whatsappClient') || {};
const { initReminderCron } = require('./services/reminderService') || {};

// Mapeamento das funções exportadas
const initClient = whatsappService.initWhatsAppClient || whatsappClient.initTenantSession || whatsappClient.getOrInitWhatsApp;
const getQr = whatsappService.getQrCode || whatsappClient.getWhatsAppStatus;

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// Health Check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', uptime: process.uptime() });
});

// Rota do QR Code consumida pelo Frontend
app.get('/api/whatsapp/qrcode/:tenantId', async (req, res) => {
  try {
    const { tenantId } = req.params;
    let session = null;

    if (typeof getQr === 'function') {
      session = getQr(tenantId);
    }

    if (!session && typeof initClient === 'function') {
      session = await initClient(tenantId);
    }

    // Se a sessão for um objeto ou string
    const qrcode = session?.qrCodeDataUrl || session?.qr || session?.qrcode || (typeof session === 'string' ? session : null);
    const status = session?.status || (qrcode ? 'qr_ready' : 'initializing');

    res.json({
      status,
      qrcode,
      qr: qrcode
    });
  } catch (error) {
    console.error('[WhatsApp QRCode Error]', error);
    res.status(500).json({ error: error.message });
  }
});

// Rota de inicialização
app.post('/api/whatsapp/init', async (req, res) => {
  try {
    const tenant_id = req.body.tenant_id || req.body.tenantId;
    if (!tenant_id) return res.status(400).json({ error: 'tenant_id é obrigatório.' });

    let session = null;
    if (typeof initClient === 'function') {
      session = await initClient(tenant_id);
    }

    res.json({ status: 'initialized', qr: session?.qr || session?.qrCodeDataUrl || null });
  } catch (error) {
    console.error('[WhatsApp Init Error]', error);
    res.status(500).json({ error: error.message });
  }
});

// Rota de status
app.get('/api/whatsapp/status/:tenant_id', (req, res) => {
  const tenant_id = req.params.tenant_id || req.params.tenantId;
  let session = null;

  if (typeof getQr === 'function') {
    session = getQr(tenant_id);
  }

  res.json({
    status: session?.status || 'disconnected',
    qr: session?.qr || session?.qrCodeDataUrl || null,
    qrcode: session?.qr || session?.qrCodeDataUrl || null
  });
});

if (typeof initReminderCron === 'function') {
  initReminderCron();
}

app.listen(PORT, '0.0.0.0', () => {
  console.log(`[Server] Servidor rodando com sucesso na porta ${PORT}`);
});
