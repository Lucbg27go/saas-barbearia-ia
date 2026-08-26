require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');

// Supabase Client
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  {
    auth: { persistSession: false, autoRefreshToken: false },
    realtime: { enabled: false }
  }
);

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

// --- ROTAS DO GOOGLE CALENDAR ---
app.get(['/auth/google', '/api/auth/google'], (req, res) => {
  try {
    const tenantId = req.query.tenantId || req.query.tenant_id;
    if (!tenantId) {
      return res.status(400).send('Tenant ID é obrigatório.');
    }
    const authUrl = getGoogleAuthUrl(tenantId);
    res.redirect(authUrl);
  } catch (error) {
    console.error('[Google Auth Error]', error);
    res.status(500).send('Erro ao gerar URL do Google: ' + error.message);
  }
});

app.get(['/auth/google/callback', '/api/auth/google/callback'], async (req, res) => {
  try {
    const { code, state } = req.query;
    if (!code || !state) return res.status(400).send('Parâmetros ausentes.');
    await handleGoogleCallback(code, state);
    res.redirect(`https://barberai-web.vercel.app?google=connected&tenantId=${state}`);
  } catch (error) {
    console.error('[Google Callback Error]', error);
    res.status(500).send('Falha ao autenticar com o Google.');
  }
});

// --- ROTAS DO WHATSAPP ---
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

// --- ROTAS DE SERVIÇOS (TABELA DE SERVIÇOS) ---
app.get(['/api/services/:tenantId', '/api/services'], async (req, res) => {
  try {
    const tenantId = req.params.tenantId || req.query.tenantId || req.query.tenant_id;
    let query = supabase.from('services').select('*').order('created_at', { ascending: true });
    if (tenantId) query = query.eq('tenant_id', tenantId);
    
    const { data, error } = await query;
    if (error) throw error;
    res.json(data || []);
  } catch (error) {
    console.error('[Get Services Error]', error);
    res.status(500).json({ error: error.message });
  }
});

app.post(['/api/services', '/api/services/:tenantId'], async (req, res) => {
  try {
    const tenantId = req.params.tenantId || req.body.tenant_id || req.body.tenantId;
    const { name, price, duration_minutes, duration } = req.body;

    const { data, error } = await supabase.from('services').insert([
      {
        tenant_id: tenantId,
        name: name,
        price: parseFloat(price),
        duration_minutes: parseInt(duration_minutes || duration, 10) || 30
      }
    ]).select().single();

    if (error) throw error;
    res.status(201).json(data);
  } catch (error) {
    console.error('[Create Service Error]', error);
    res.status(500).json({ error: error.message });
  }
});

app.delete(['/api/services/:id', '/api/services/:tenantId/:id'], async (req, res) => {
  try {
    const id = req.params.id;
    const { error } = await supabase.from('services').delete().eq('id', id);
    if (error) throw error;
    res.json({ success: true });
  } catch (error) {
    console.error('[Delete Service Error]', error);
    res.status(500).json({ error: error.message });
  }
});

// --- ROTAS DE AGENDAMENTOS (DASHBOARD) ---
app.get(['/api/appointments/:tenantId', '/api/appointments'], async (req, res) => {
  try {
    const tenantId = req.params.tenantId || req.query.tenantId || req.query.tenant_id;
    let query = supabase.from('appointments').select('*').order('start_time', { ascending: false });
    if (tenantId) query = query.eq('tenant_id', tenantId);

    const { data, error } = await query;
    if (error) throw error;
    res.json(data || []);
  } catch (error) {
    console.error('[Get Appointments Error]', error);
    res.status(500).json({ error: error.message });
  }
});

// --- ROTAS DE CONFIGURAÇÕES DE HORÁRIO ---
app.get(['/api/settings/:tenantId', '/api/settings'], async (req, res) => {
  try {
    const tenantId = req.params.tenantId || req.query.tenantId || req.query.tenant_id;
    if (!tenantId) return res.json({});

    const { data, error } = await supabase.from('tenants').select('*').eq('id', tenantId).single();
    if (error) throw error;
    res.json(data || {});
  } catch (error) {
    console.error('[Get Settings Error]', error);
    res.status(500).json({ error: error.message });
  }
});

app.post(['/api/settings', '/api/settings/:tenantId'], async (req, res) => {
  try {
    const tenantId = req.params.tenantId || req.body.tenant_id || req.body.tenantId;
    const updateData = { ...req.body };
    delete updateData.tenant_id;
    delete updateData.tenantId;

    const { data, error } = await supabase
      .from('tenants')
      .update(updateData)
      .eq('id', tenantId)
      .select()
      .single();

    if (error) throw error;
    res.json(data);
  } catch (error) {
    console.error('[Save Settings Error]', error);
    res.status(500).json({ error: error.message });
  }
});

// Inicialização do cron de lembretes
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
