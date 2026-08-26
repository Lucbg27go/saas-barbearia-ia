require('dotenv').config();
const express = require('express');
const cors = require('cors');

// Importações dos serviços
const { getOrInitWhatsApp, getWhatsAppStatus } = require('./services/whatsappClient');
const { getGoogleAuthUrl, handleGoogleCallback } = require('./services/calendarService');
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

// --- GOOGLE CALENDAR AUTH ---
app.get(['/auth/google', '/api/auth/google'], (req, res) => {
  try {
    const tenantId = req.query.tenantId || req.query.tenant_id;
    if (!tenantId) {
      return res.status(400).send('Tenant ID é obrigatório para iniciar a autenticação.');
    }

    const authUrl = getGoogleAuthUrl(tenantId);
    res.redirect(authUrl);
  } catch (error) {
    console.error('[Google Auth URL Error]', error);
    res.status(500).send('Erro ao gerar URL do Google: ' + error.message);
  }
});

app.get(['/auth/google/callback', '/api/auth/google/callback'], async (req, res) => {
  try {
    const { code, state } = req.query; // 'state' contém o tenantId
    if (!code || !state) {
      return res.status(400).send('Parâmetros de callback ausentes.');
    }

    await handleGoogleCallback(code, state);

    // Redireciona com flag de sucesso para a Vercel
    res.redirect(`https://barberai-web.vercel.app?google=connected&tenantId=${state}`);
  } catch (error) {
    console.error('[Google Callback Error]', error);
    res.status(500).send('Falha ao autenticar com o Google: ' + error.message);
  }
});

// --- WHATSAPP QR CODE & STATUS ---
app.get(['/api/whatsapp/qrcode/:tenantId', '/whatsapp/qrcode/:tenantId'], async (req, res) => {
  try {
    const { tenantId } = req.params;
    let session = await getOrInitWhatsApp(tenantId);

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
    console.error('[WhatsApp QRCode Error]', error);
    res.status(500).json({ error: error.message });
  }
});

app.get(['/api/whatsapp/status/:tenantId', '/whatsapp/status/:tenantId'], (req, res) => {
  const { tenantId } = req.params;
  const statusData = getWhatsAppStatus(tenantId);
  res.json(statusData);
});

// Rotas do painel (fallback para evitar 404 caso chamadas diretamente)
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
