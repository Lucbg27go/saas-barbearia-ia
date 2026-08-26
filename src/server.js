require('dotenv').config();
const express = require('express');
const cors = require('cors');

// Importações corretas dos arquivos existentes
const { initTenantSession, sessions } = require('./services/whatsappClient');
const { initReminderCron } = require('./services/reminderService');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// Health Check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', uptime: process.uptime() });
});

// Helper para buscar sessão de Map ou Objeto
function getSessionData(tenantId) {
  if (!sessions) return null;
  if (typeof sessions.get === 'function') {
    return sessions.get(tenantId);
  }
  return sessions[tenantId] || null;
}

// Rota do QR Code (chamada pelo Frontend)
app.get('/api/whatsapp/qrcode/:tenantId', async (req, res) => {
  try {
    const { tenantId } = req.params;
    let session = getSessionData(tenantId);

    if (!session && typeof initTenantSession === 'function') {
      session = await initTenantSession(tenantId);
    }

    const qrData = session?.qrCodeDataUrl || session?.qr || session?.qrcode || null;
    const currentStatus = session?.status || (qrData ? 'qr_ready' : 'initializing');

    res.json({
      status: currentStatus,
      qrcode: qrData,
      qr: qrData
    });
  } catch (error) {
    console.error('[WhatsApp QRCode Error]', error);
    res.status(500).json({ error: error.message });
  }
});

// Rota para inicializar sessão
app.post('/api/whatsapp/init', async (req, res) => {
  try {
    const tenant_id = req.body.tenant_id || req.body.tenantId;
    if (!tenant_id) return res.status(400).json({ error: 'tenant_id é obrigatório.' });

    let session = null;
    if (typeof initTenantSession === 'function') {
      session = await initTenantSession(tenant_id);
    }

    const qrData = session?.qrCodeDataUrl || session?.qr || session?.qrcode || null;
    res.json({ status: 'initialized', qr: qrData });
  } catch (error) {
    console.error('[WhatsApp Init Error]', error);
    res.status(500).json({ error: error.message });
  }
});

// Rota de status da sessão
app.get('/api/whatsapp/status/:tenant_id', (req, res) => {
  const tenant_id = req.params.tenant_id || req.params.tenantId;
  const session = getSessionData(tenant_id);

  if (!session) {
    return res.json({ status: 'disconnected', qr: null, qrcode: null });
  }

  const qrData = session.qrCodeDataUrl || session.qr || session.qrcode || null;
  res.json({
    status: session.status || 'connected',
    qr: qrData,
    qrcode: qrData
  });
});

// Inicialização de lembretes se existir a função
if (typeof initReminderCron === 'function') {
  try {
    initReminderCron();
  } catch (cronErr) {
    console.warn('[Cron Warning]', cronErr.message);
  }
}

app.listen(PORT, '0.0.0.0', () => {
  console.log(`[Server] Servidor rodando com sucesso na porta ${PORT}`);
});
