require('dotenv').config();
const express = require('express');
const cors = require('cors');

// Importações com os nomes exatos do whatsappClient.js
const { getOrInitWhatsApp, getWhatsAppStatus } = require('./services/whatsappClient');
const { initReminderCron } = require('./services/reminderService') || {};

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));
app.use(express.json());

// Health Check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', uptime: process.uptime() });
});

// Rota do QR Code (chamada pelo Frontend)
app.get(['/api/whatsapp/qrcode/:tenantId', '/whatsapp/qrcode/:tenantId'], async (req, res) => {
  try {
    const { tenantId } = req.params;
    let session = await getOrInitWhatsApp(tenantId);

    // Se acabou de disparar a inicialização, aguarda até 5s para o evento 'qr' preencher o qrcode
    let attempts = 0;
    while (session && !session.qrcode && session.status !== 'connected' && attempts < 10) {
      await new Promise((r) => setTimeout(r, 500));
      session = getWhatsAppStatus(tenantId);
      attempts++;
    }

    const currentStatus = session?.status || 'connecting';
    const qrcode = session?.qrcode || null;

    res.json({
      status: currentStatus,
      qrcode: qrcode,
      qr: qrcode
    });
  } catch (error) {
    console.error('[WhatsApp QRCode Route Error]', error);
    res.status(500).json({ error: error.message });
  }
});

// Rota de status do WhatsApp
app.get(['/api/whatsapp/status/:tenantId', '/whatsapp/status/:tenantId'], (req, res) => {
  const { tenantId } = req.params;
  const statusData = getWhatsAppStatus(tenantId);
  res.json(statusData);
});

// Fallback para as rotas do painel evitarem o 404 caso chamadas diretamente
app.get(['/api/services/:tenantId', '/api/services'], (req, res) => res.json([]));
app.get(['/api/appointments/:tenantId', '/api/appointments'], (req, res) => res.json([]));
app.get(['/api/settings/:tenantId', '/api/settings'], (req, res) => res.json({}));

if (typeof initReminderCron === 'function') {
  try {
    initReminderCron();
  } catch (err) {
    console.warn('[Cron Warning]', err.message);
  }
}

app.listen(PORT, '0.0.0.0', () => {
  console.log(`[Server] Servidor rodando com sucesso na porta ${PORT}`);
});
