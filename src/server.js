require('dotenv').config();
// ---------- Proteção contra crashes globais ----------
// Evita que um erro não tratado (ex: falha interna do Puppeteer/WhatsApp)
// derrube o servidor inteiro e afete todas as barbearias conectadas.
process.on('uncaughtException', (err) => {
  console.error('❌ [Uncaught Exception] O servidor continua rodando, mas isso precisa ser investigado:', err);
});

process.on('unhandledRejection', (reason) => {
  console.error('❌ [Unhandled Rejection] O servidor continua rodando, mas isso precisa ser investigado:', reason);
});

const { createOrGetCustomer, createSubscription, getFirstPaymentLink } = require('./services/asaasService');
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

// ---------- Middleware de autenticação ----------
// Valida o token de sessão do Supabase e descobre o tenantId a partir do
// usuário autenticado — NUNCA confia em tenantId vindo de query/params/body.
async function authenticateTenant(req, res, next) {
  try {
    const authHeader = req.headers.authorization || '';
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;

    if (!token) {
      return res.status(401).json({ error: 'Token de autenticação ausente.' });
    }

    const { data: userData, error: userErr } = await supabase.auth.getUser(token);
    if (userErr || !userData?.user) {
      return res.status(401).json({ error: 'Sessão inválida ou expirada. Faça login novamente.' });
    }

    const { data: tenant, error: tenantErr } = await supabase
      .from('tenants')
      .select('*')
      .eq('user_id', userData.user.id)
      .single();

    if (tenantErr || !tenant) {
      return res.status(403).json({ error: 'Nenhuma barbearia vinculada a este usuário.' });
    }

    req.user = userData.user;
    req.tenant = tenant;
    req.tenantId = tenant.id;
    next();
  } catch (err) {
    console.error('[Auth Middleware Error]', err);
    res.status(500).json({ error: 'Erro ao validar autenticação.' });
  }
}

// --- GOOGLE CALENDAR ---
// Endpoint autenticado que devolve a URL de autorização (o frontend faz o redirect via JS)
app.get('/api/auth/google-url', authenticateTenant, (req, res) => {
  try {
    res.json({ url: getGoogleAuthUrl(req.tenantId) });
  } catch (error) {
    res.status(500).json({ error: 'Erro ao gerar link do Google: ' + error.message });
  }
});

// Callback é chamado pelo próprio Google (redirect de navegador), não pelo frontend — continua público
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
app.get('/api/whatsapp/qrcode', authenticateTenant, async (req, res) => {
  try {
    const tenantId = req.tenantId;
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

app.get('/api/whatsapp/status', authenticateTenant, (req, res) => {
  res.json(getWhatsAppStatus(req.tenantId));
});

// --- SERVIÇOS ---
app.get('/api/services', authenticateTenant, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('services')
      .select('*')
      .eq('tenant_id', req.tenantId)
      .order('created_at', { ascending: true });
    if (error) throw error;
    res.json(data || []);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- ASSINATURA (ASAAS) ---
app.post('/api/billing/subscribe', authenticateTenant, async (req, res) => {
  try {
    const { cpfCnpj } = req.body;
    const tenant = req.tenant;

    if (!cpfCnpj && !tenant.cpf_cnpj) {
      return res.status(400).json({ error: 'CPF ou CNPJ é obrigatório para gerar a assinatura.' });
    }

    let asaasCustomerId = tenant.asaas_customer_id;

    // Cria o cliente na Asaas só na primeira vez
    if (!asaasCustomerId) {
      const customer = await createOrGetCustomer({
        name: tenant.owner_name || tenant.name,
        email: tenant.email || req.user.email,
        cpfCnpj: cpfCnpj || tenant.cpf_cnpj,
        phone: tenant.phone_number,
      });
      asaasCustomerId = customer.id;

      await supabase
        .from('tenants')
        .update({ asaas_customer_id: asaasCustomerId, cpf_cnpj: cpfCnpj || tenant.cpf_cnpj })
        .eq('id', tenant.id);
    }

    // Alinha a primeira cobrança com o fim do trial (ou hoje, se o trial já passou)
    const trialEnd = tenant.trial_ends_at ? new Date(tenant.trial_ends_at) : new Date();
    const firstDueDate = trialEnd > new Date() ? trialEnd : new Date();
    const nextDueDate = firstDueDate.toISOString().split('T')[0];

    const subscription = await createSubscription({
      customerId: asaasCustomerId,
      value: 97.0,
      nextDueDate,
      description: `Assinatura BarberAI - ${tenant.name}`,
    });

    await supabase
      .from('tenants')
      .update({ asaas_subscription_id: subscription.id })
      .eq('id', tenant.id);

    const checkoutUrl = await getFirstPaymentLink(subscription.id);

    res.json({ checkoutUrl, subscriptionId: subscription.id });
  } catch (err) {
    console.error('[Asaas Subscribe Error]', JSON.stringify({
      status: err.response?.status,
      data: err.response?.data,
      message: err.message,
      url: err.config?.url,
    }, null, 2));
    res.status(500).json({ error: 'Erro ao criar assinatura. Tente novamente.' });
  }
});

// Webhook da Asaas — recebe confirmação de pagamento (rota pública, mas valida token)
app.post('/api/webhooks/asaas', async (req, res) => {
  try {
    const receivedToken = req.headers['asaas-access-token'];
    if (receivedToken !== process.env.ASAAS_WEBHOOK_TOKEN) {
      return res.status(401).json({ error: 'Token de webhook inválido.' });
    }

    const { event, payment } = req.body;
    console.log(`[Asaas Webhook] Evento: ${event}`);

    if (!payment?.subscription) {
      return res.status(200).json({ received: true });
    }

    if (event === 'PAYMENT_CONFIRMED' || event === 'PAYMENT_RECEIVED') {
      await supabase
        .from('tenants')
        .update({ subscription_status: 'active' })
        .eq('asaas_subscription_id', payment.subscription);
    }

    if (event === 'PAYMENT_OVERDUE' || event === 'PAYMENT_DELETED') {
      await supabase
        .from('tenants')
        .update({ subscription_status: 'overdue' })
        .eq('asaas_subscription_id', payment.subscription);
    }

    res.status(200).json({ received: true });
  } catch (err) {
    console.error('[Asaas Webhook Error]', err);
    res.status(500).json({ error: 'Erro ao processar webhook.' });
  }
});

app.post('/api/services', authenticateTenant, async (req, res) => {
  try {
    const { name, price, duration_minutes, duration } = req.body;
    const { data, error } = await supabase.from('services').insert([{
      tenant_id: req.tenantId,
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

app.delete('/api/services/:id', authenticateTenant, async (req, res) => {
  try {
    // Confere tenant_id também, pra garantir que ninguém apague serviço de outra barbearia
    const { error } = await supabase
      .from('services')
      .delete()
      .eq('id', req.params.id)
      .eq('tenant_id', req.tenantId);
    if (error) throw error;
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- BARBEIROS ---
app.get('/api/barbers', authenticateTenant, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('barbers')
      .select('*')
      .eq('tenant_id', req.tenantId)
      .order('created_at', { ascending: true });
    if (error) throw error;
    res.json(data || []);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/barbers', authenticateTenant, async (req, res) => {
  try {
    const { name } = req.body;
    if (!name || !name.trim()) {
      return res.status(400).json({ error: 'Nome do barbeiro é obrigatório.' });
    }
    const { data, error } = await supabase
      .from('barbers')
      .insert([{ tenant_id: req.tenantId, name: name.trim() }])
      .select()
      .single();
    if (error) throw error;
    res.status(201).json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/barbers/:id', authenticateTenant, async (req, res) => {
  try {
    const { name, is_active } = req.body;
    const updateData = {};
    if (name !== undefined) updateData.name = name.trim();
    if (is_active !== undefined) updateData.is_active = is_active;

    const { data, error } = await supabase
      .from('barbers')
      .update(updateData)
      .eq('id', req.params.id)
      .eq('tenant_id', req.tenantId) // garante isolamento por tenant
      .select()
      .single();
    if (error) throw error;
    if (!data) return res.status(404).json({ error: 'Barbeiro não encontrado.' });
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/barbers/:id', authenticateTenant, async (req, res) => {
  try {
    // Impede excluir barbeiro que já tem agendamento (evita quebrar histórico)
    const { count } = await supabase
      .from('appointments')
      .select('id', { count: 'exact', head: true })
      .eq('barber_id', req.params.id);

    if (count > 0) {
      return res.status(409).json({
        error: 'Este barbeiro já possui agendamentos e não pode ser excluído. Desative-o em vez disso.'
      });
    }

    const { error } = await supabase
      .from('barbers')
      .delete()
      .eq('id', req.params.id)
      .eq('tenant_id', req.tenantId);
    if (error) throw error;
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- HORÁRIO DE TRABALHO POR BARBEIRO ---
app.get('/api/barbers/:id/working-hours', authenticateTenant, async (req, res) => {
  try {
    const { data: barber } = await supabase
      .from('barbers')
      .select('id')
      .eq('id', req.params.id)
      .eq('tenant_id', req.tenantId)
      .single();
    if (!barber) return res.status(404).json({ error: 'Barbeiro não encontrado.' });

    const { data, error } = await supabase
      .from('working_hours')
      .select('*')
      .eq('barber_id', req.params.id)
      .order('day_of_week', { ascending: true });
    if (error) throw error;
    res.json(data || []);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Substitui o horário completo do barbeiro de uma vez (upsert por dia da semana)
app.put('/api/barbers/:id/working-hours', authenticateTenant, async (req, res) => {
  try {
    const { data: barber } = await supabase
      .from('barbers')
      .select('id')
      .eq('id', req.params.id)
      .eq('tenant_id', req.tenantId)
      .single();
    if (!barber) return res.status(404).json({ error: 'Barbeiro não encontrado.' });

    const { days } = req.body; // array: [{ day_of_week, is_open, open_time, close_time, lunch_start, lunch_end }]
    if (!Array.isArray(days)) {
      return res.status(400).json({ error: 'Formato inválido: "days" deve ser um array.' });
    }

    const rows = days.map((d) => ({ ...d, barber_id: req.params.id, tenant_id: req.tenantId }));

    const { data, error } = await supabase
      .from('working_hours')
      .upsert(rows, { onConflict: 'barber_id,day_of_week' })
      .select();
    if (error) throw error;
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- AGENDAMENTOS ---
app.get('/api/appointments', authenticateTenant, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('appointments')
      .select('*')
      .eq('tenant_id', req.tenantId)
      .order('start_time', { ascending: false });
    if (error) throw error;
    res.json(data || []);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- CONFIGURAÇÕES DE HORÁRIO ---
app.get('/api/settings', authenticateTenant, async (req, res) => {
  // req.tenant já vem carregado do middleware, evita nova consulta
  res.json(req.tenant || {});
});

app.post('/api/settings', authenticateTenant, async (req, res) => {
  try {
    const updateData = { ...req.body };
    delete updateData.tenant_id;
    delete updateData.tenantId;
    delete updateData.id; // nunca deixa sobrescrever o próprio ID do tenant
    delete updateData.user_id;

    const { data, error } = await supabase
      .from('tenants')
      .update(updateData)
      .eq('id', req.tenantId)
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
