require('dotenv').config();
const express = require('express');
const cors = require('cors');

// Importações com os caminhos corretos dentro de /services
const { initTenantSession, sessions } = require('./services/whatsappClient');
const { initReminderCron } = require('./services/reminderService');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// Rota de Health Check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', uptime: process.uptime() });
});

// Rota para inicializar a sessão do WhatsApp de um tenant
app.post('/api/whatsapp/init', async (req, res) => {
  try {
    const { tenant_id } = req.body;
    if (!tenant_id) {
      return res.status(400).json({ error: 'tenant_id é obrigatório.' });
    }

    const session = await initTenantSession(tenant_id);
    res.json({ status: 'initialized', qr: session.qr || null });
  } catch (error) {
    console.error('[WhatsApp Init Error]', error);
    res.status(500).json({ error: error.message });
  }
});

// Rota para consultar o status da sessão
app.get('/api/whatsapp/status/:tenant_id', (req, res) => {
  const { tenant_id } = req.params;
  const session = sessions.get(tenant_id);

  if (!session) {
    return res.json({ status: 'disconnected', qr: null });
  }

  res.json({
    status: session.status,
    qr: session.qr || null
  });
});

// Inicializa a rotina de lembretes automáticos
initReminderCron();

app.listen(PORT, '0.0.0.0', () => {
  console.log(`[Server] Servidor rodando com sucesso na porta ${PORT}`);
});
