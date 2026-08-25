require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { getGoogleAuthUrl, handleGoogleCallback } = require('./services/calendarService');
const { handleCustomerChat } = require('./services/aiAgent');
const { initWhatsAppClient, getQrCode } = require('./services/whatsappClient');
const { initReminderCron } = require('./services/reminderService');
const { createClient } = require('@supabase/supabase-js');

const app = express();
app.use(cors());
app.use(express.json());

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } }
);

app.get('/', (req, res) => {
  res.json({ status: 'ok', message: 'Servidor BarberAI rodando!' });
});

app.get('/auth/google', (req, res) => {
  const { tenantId } = req.query;
  if (!tenantId) return res.status(400).send('Tenant ID é obrigatório.');
  const url = getGoogleAuthUrl(tenantId);
  res.redirect(url);
});

app.get('/auth/google/callback', async (req, res) => {
  const { code, state: tenantId } = req.query;
  if (!code || !tenantId) return res.status(400).send('Dados inválidos recebidos do Google.');

  try {
    await handleGoogleCallback(code, tenantId);
    res.send('<h1>Google Calendar conectado com sucesso!</h1><p>Você pode fechar esta aba.</p>');
  } catch (error) {
    console.error('Erro no callback do Google:', error);
    res.status(500).send('Falha ao autenticar com o Google.');
  }
});

app.get('/api/whatsapp/qrcode/:tenantId', async (req, res) => {
  const { tenantId } = req.params;
  const session = getQrCode(tenantId);

  if (!session) {
    initWhatsAppClient(tenantId);
    return res.json({ status: 'initializing', qrcode: null });
  }

  res.json({
    status: session.status,
    qrcode: session.qrCodeDataUrl || null,
  });
});

app.post('/chat/test', async (req, res) => {
  const { tenantId, customerName, customerPhone, message } = req.body;
  if (!tenantId || !customerPhone || !message) {
    return res.status(400).json({ error: 'tenantId, customerPhone e message são obrigatórios.' });
  }

  try {
    const response = await handleCustomerChat(tenantId, customerPhone, customerName || 'Cliente Teste', message);
    res.json({ response });
  } catch (error) {
    console.error('Erro no teste de IA:', error);
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/services', async (req, res) => {
  const { tenantId } = req.query;
  if (!tenantId) return res.status(400).json({ error: 'tenantId obrigatório' });

  const { data, error } = await supabase
    .from('services')
    .select('*')
    .eq('tenant_id', tenantId)
    .order('created_at', { ascending: true });

  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

app.post('/api/services', async (req, res) => {
  const { tenant_id, name, price, duration_minutes } = req.body;
  const { data, error } = await supabase
    .from('services')
    .insert([{ tenant_id, name, price, duration_minutes }])
    .select()
    .single();

  if (error) return res.status(500).json({ error: error.message });
  res.status(201).json(data);
});

app.delete('/api/services/:id', async (req, res) => {
  const { id } = req.params;
  const { error } = await supabase.from('services').delete().eq('id', id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true });
});

app.get('/api/appointments', async (req, res) => {
  const { tenantId } = req.query;
  if (!tenantId) return res.status(400).json({ error: 'tenantId obrigatório' });

  const { data, error } = await supabase
    .from('appointments')
    .select('*')
    .eq('tenant_id', tenantId)
    .order('start_time', { ascending: false });

  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// Configurações de Horário de Funcionamento
app.get('/api/settings/:tenantId', async (req, res) => {
  const { tenantId } = req.params;
  const { data, error } = await supabase
    .from('business_settings')
    .select('*')
    .eq('tenant_id', tenantId)
    .maybeSingle();

  if (error) return res.status(500).json({ error: error.message });
  
  if (!data) {
    return res.json({
      open_time: '09:00',
      close_time: '19:00',
      lunch_start: '12:00',
      lunch_end: '13:00',
      work_days: ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'],
    });
  }
  res.json(data);
});

app.post('/api/settings/:tenantId', async (req, res) => {
  const { tenantId } = req.params;
  const { open_time, close_time, lunch_start, lunch_end, work_days } = req.body;

  const { data, error } = await supabase
    .from('business_settings')
    .upsert({
      tenant_id: tenantId,
      open_time,
      close_time,
      lunch_start,
      lunch_end,
      work_days
    }, { onConflict: 'tenant_id' })
    .select()
    .single();

  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Servidor rodando com sucesso na porta ${PORT}`);
  initReminderCron();
});
