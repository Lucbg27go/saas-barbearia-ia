require('dotenv').config();
const express = require('express');
const cors = require('cors');
const QRCode = require('qrcode');
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  {
    auth: { persistSession: false, autoRefreshToken: false },
    realtime: { enabled: false }
  }
);

const { getOrInitWhatsApp, getWhatsAppStatus } = require('./services/whatsappClient');
const { getGoogleAuthUrl, handleGoogleCallback } = require('./services/calendarService');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors({ origin: '*', methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'] }));
app.use(express.json());

app.get('/health', (req, res) => {
  res.json({ status: 'ok', uptime: process.uptime() });
});

// --- GOOGLE CALENDAR ---
app.get(['/auth/google', '/api/auth/google'], (req, res) => {
  try {
    const tenantId = req.query.tenantId || req.query.tenant_id;
    if (!tenantId) return res.status(400).send('Tenant ID é obrigatório.');
    res.redirect(getGoogleAuthUrl(tenantId));
  } catch (error) {
    res.status(500).send('Erro Google Auth: ' + error.message);
  }
});

app.get(['/auth/google/callback', '/api/auth/google/callback'], async (req, res) => {
  try {
    const { code, state } = req.query;
    if (!code || !state) return res.status(400).send('Parâmetros ausentes.');
    await handleGoogleCallback(code, state);
    res.redirect(`https://barberai-web.vercel.app?google=connected&tenantId=${state}`);
  } catch (error) {
    res.status(500).send('Falha ao autenticar com Google.');
  }
});

// --- WHATSAPP QR CODE ---
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

    let qrDataUrl = null;
    if (session?.qrcode) {
      qrDataUrl = await QRCode.toDataURL(session.qrcode, { margin: 2, width: 300 });
    }

    res.json({
      status: session?.status || 'connecting',
      qrcode: qrDataUrl,
      qr: qrDataUrl
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get(['/api/whatsapp/status/:tenantId', '/whatsapp/status/:tenantId'], (req, res) => {
  res.json(getWhatsAppStatus(req.params.tenantId));
});

// --- SERVIÇOS ---
app.get(['/api/services/:tenantId', '/api/services'], async (req, res) => {
  try {
    const tenantId = req.params.tenantId || req.query.tenantId || req.query.tenant_id;
    let q = supabase.from('services').select('*').order('created_at', { ascending: true });
    if (tenantId) q = q.eq('tenant_id', tenantId);
    const { data, error } = await q;
    if (error) throw error;
    res.json(data || []);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post(['/api/services', '/api/services/:tenantId'], async (req, res) => {
  try {
    const tenantId = req.params.tenantId || req.body.tenant_id || req.body.tenantId;
    const { name, price, duration_minutes, duration } = req.body;
    const { data, error } = await supabase.from('services').insert([{
      tenant_id: tenantId,
      name,
      price: parseFloat(price),
      duration_minutes: parseInt(duration_minutes || duration, 10) || 30
    }]).select().single();
    if (error) throw error;
    res.status(201).json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete(['/api/services/:id', '/api/services/:tenantId/:id'], async (req, res) => {
  try {
    const { error } = await supabase.from('services').delete().eq('id', req.params.id);
    if (error) throw error;
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- AGENDAMENTOS ---
app.get(['/api/appointments/:tenantId', '/api/appointments'], async (req, res) => {
  try {
    const tenantId = req.params.tenantId || req.query.tenantId || req.query.tenant_id;
    let q = supabase.from('appointments').select('*').order('start_time', { ascending: false });
    if (tenantId) q = q.eq('tenant_id', tenantId);
    const { data, error } = await q;
    if (error) throw error;
    res.json(data || []);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- CONFIGURAÇÕES DE HORÁRIO ---
app.get(['/api/settings/:tenantId', '/api/settings'], async (req, res) => {
  try {
    const tenantId = req.params.tenantId || req.query.tenantId || req.query.tenant_id;
    const { data, error } = await supabase.from('tenants').select('*').eq('id', tenantId).single();
    if (error) throw error;
    res.json(data || {});
  } catch (err) {
    res.status(500).json({ error: err.message });
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
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`[Server] Servidor rodando com sucesso na porta ${PORT}`);
});
