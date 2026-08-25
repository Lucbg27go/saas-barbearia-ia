const express = require('express');
const router = express.Router();
const { createClient } = require('@supabase/supabase-js');
const { google } = require('googleapis');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  {
    auth: { persistSession: false, autoRefreshToken: false },
    realtime: { enabled: false }
  }
);

// Obter serviços do tenant
router.get('/services', async (req, res) => {
  const tenantId = req.query.tenantId || '77585100-be4d-4e4d-b44b-ffc8f0ce6df1';
  try {
    const { data, error } = await supabase
      .from('services')
      .select('*')
      .eq('tenant_id', tenantId)
      .order('price', { ascending: true });
    if (error) throw error;
    res.json(data || []);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Criar serviço
router.post('/services', async (req, res) => {
  const { tenant_id, name, price, duration_minutes } = req.body;
  try {
    const { data, error } = await supabase
      .from('services')
      .insert([{ tenant_id, name, price, duration_minutes }])
      .select()
      .single();
    if (error) throw error;
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Deletar serviço
router.delete('/services/:id', async (req, res) => {
  try {
    const { error } = await supabase
      .from('services')
      .delete()
      .eq('id', req.params.id);
    if (error) throw error;
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Obter agendamentos sincronizados do Google Calendar e Supabase
router.get('/appointments', async (req, res) => {
  const tenantId = req.query.tenantId || '77585100-be4d-4e4d-b44b-ffc8f0ce6df1';
  try {
    const { data: dbAppointments, error } = await supabase
      .from('appointments')
      .select('*')
      .eq('tenant_id', tenantId)
      .order('start_time', { ascending: false });

    if (error) throw error;

    if (dbAppointments && dbAppointments.length > 0) {
      return res.json(dbAppointments);
    }

    // Se a tabela local estiver vazia, puxa direto do Google Calendar dos últimos eventos
    const { data: tenant } = await supabase
      .from('tenants')
      .select('google_access_token, google_refresh_token')
      .eq('id', tenantId)
      .single();

    if (!tenant || !tenant.google_refresh_token) {
      return res.json([]);
    }

    const oauth2Client = new google.auth.OAuth2(
      process.env.GOOGLE_CLIENT_ID,
      process.env.GOOGLE_CLIENT_SECRET,
      process.env.GOOGLE_REDIRECT_URI
    );

    oauth2Client.setCredentials({
      access_token: tenant.google_access_token,
      refresh_token: tenant.google_refresh_token,
    });

    const calendar = google.calendar({ version: 'v3', auth: oauth2Client });
    const eventsRes = await calendar.events.list({
      calendarId: 'primary',
      timeMin: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString(),
      maxResults: 20,
      singleEvents: true,
      orderBy: 'startTime',
    });

    const mapped = (eventsRes.data.items || []).map((ev) => {
      const summaryParts = (ev.summary || '').split(' - ');
      return {
        id: ev.id,
        customer_name: summaryParts[1] || 'Cliente',
        customer_phone: 'WhatsApp',
        service_name: summaryParts[0] || 'Serviço',
        start_time: ev.start.dateTime || ev.start.date,
        price: 40.0,
      };
    });

    res.json(mapped);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
