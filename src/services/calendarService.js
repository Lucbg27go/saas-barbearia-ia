const { google } = require('googleapis');
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  {
    auth: { persistSession: false, autoRefreshToken: false },
    realtime: { enabled: false }
  }
);

function getBaseOAuth2Client() {
  return new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_REDIRECT_URI
  );
}

function getGoogleAuthUrl(tenantId) {
  const oauth2Client = getBaseOAuth2Client();
  const scopes = [
    'https://www.googleapis.com/auth/calendar',
    'https://www.googleapis.com/auth/calendar.events',
  ];

  return oauth2Client.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: scopes,
    state: tenantId,
  });
}

async function handleGoogleCallback(code, tenantId) {
  const oauth2Client = getBaseOAuth2Client();
  const { tokens } = await oauth2Client.getToken(code);

  const updateData = {
    google_access_token: tokens.access_token,
  };

  if (tokens.refresh_token) {
    updateData.google_refresh_token = tokens.refresh_token;
  }

  const { error } = await supabase
    .from('tenants')
    .update(updateData)
    .eq('id', tenantId);

  if (error) {
    throw new Error('Falha ao salvar tokens do Google: ' + error.message);
  }

  return tokens;
}

async function getOAuth2Client(tenantId) {
  const { data: tenant, error } = await supabase
    .from('tenants')
    .select('google_access_token, google_refresh_token')
    .eq('id', tenantId)
    .single();

  if (error || !tenant || !tenant.google_refresh_token) {
    throw new Error('Tenant não possui integração ativa com o Google Calendar.');
  }

  const oauth2Client = getBaseOAuth2Client();
  oauth2Client.setCredentials({
    access_token: tenant.google_access_token,
    refresh_token: tenant.google_refresh_token,
  });

  return oauth2Client;
}

function parseDateTimeSafe(dateInput) {
  if (!dateInput) return new Date();
  if (/^\d{4}-\d{2}-\d{2}$/.test(dateInput)) {
    return new Date(`${dateInput}T09:00:00-03:00`);
  }
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/.test(dateInput)) {
    return new Date(`${dateInput}-03:00`);
  }
  const parsed = new Date(dateInput);
  return isNaN(parsed.getTime()) ? new Date() : parsed;
}

async function listBusySlots(tenantId, dateStr) {
  const auth = await getOAuth2Client(tenantId);
  const calendar = google.calendar({ version: 'v3', auth });

  const rawDate = dateStr && dateStr.includes('T') ? dateStr.split('T')[0] : (dateStr || '2026-08-24');
  const timeMin = new Date(`${rawDate}T00:00:00-03:00`).toISOString();
  const timeMax = new Date(`${rawDate}T23:59:59-03:00`).toISOString();

  const response = await calendar.events.list({
    calendarId: 'primary',
    timeMin,
    timeMax,
    singleEvents: true,
    orderBy: 'startTime',
    timeZone: 'America/Sao_Paulo',
  });

  return (response.data.items || []).map(event => ({
    summary: event.summary,
    start: event.start.dateTime || event.start.date,
    end: event.end.dateTime || event.end.date
  }));
}

async function createAppointmentEvent(tenantId, { customerName, customerPhone, serviceName, startTime, durationMinutes, price }) {
  const auth = await getOAuth2Client(tenantId);
  const calendar = google.calendar({ version: 'v3', auth });

  const start = parseDateTimeSafe(startTime);
  const duration = parseInt(durationMinutes, 10) || 30;
  const end = new Date(start.getTime() + duration * 60 * 1000);

  const event = await calendar.events.insert({
    calendarId: 'primary',
    requestBody: {
      summary: `${serviceName || 'Corte'} - ${customerName}`,
      description: `Cliente: ${customerName}\nTelefone: ${customerPhone}\nServiço: ${serviceName}`,
      start: { dateTime: start.toISOString(), timeZone: 'America/Sao_Paulo' },
      end: { dateTime: end.toISOString(), timeZone: 'America/Sao_Paulo' },
    },
  });

  const { data: inserted, error: insertErr } = await supabase
    .from('appointments')
    .insert([
      {
        tenant_id: tenantId,
        customer_name: customerName,
        customer_phone: customerPhone,
        service_name: serviceName || 'Corte',
        start_time: start.toISOString(),
        end_time: end.toISOString(),
        price: price ? parseFloat(price) : 40.0,
        google_event_id: event.data.id,
        status: 'confirmed'
      }
    ])
    .select()
    .single();

  if (insertErr) console.error('[Appointment Insert Error]', insertErr);

  return { ...event.data, appointmentId: inserted?.id };
}

// Busca o agendamento ativo mais recente de um cliente (sem executar nenhuma ação)
async function findActiveAppointmentByPhone(tenantId, customerPhone) {
  const { data: appt, error } = await supabase
    .from('appointments')
    .select('*')
    .eq('tenant_id', tenantId)
    .ilike('customer_phone', `%${customerPhone.slice(-8)}%`)
    .eq('status', 'confirmed')
    .order('start_time', { ascending: false })
    .limit(1)
    .single();

  if (error || !appt) return null;
  return appt;
}

// Cancela um agendamento específico pelo ID (usado só após confirmação explícita)
async function cancelAppointmentById(tenantId, appointmentId) {
  const { data: appt, error } = await supabase
    .from('appointments')
    .select('*')
    .eq('id', appointmentId)
    .eq('tenant_id', tenantId)
    .single();

  if (error || !appt) {
    throw new Error('Agendamento não encontrado.');
  }

  if (appt.google_event_id) {
    try {
      const auth = await getOAuth2Client(tenantId);
      const calendar = google.calendar({ version: 'v3', auth });
      await calendar.events.delete({
        calendarId: 'primary',
        eventId: appt.google_event_id,
      });
    } catch (gErr) {
      console.warn('Evento já removido do Calendar ou erro ao deletar:', gErr.message);
    }
  }

  await supabase
    .from('appointments')
    .update({ status: 'cancelled' })
    .eq('id', appt.id);

  return { success: true, serviceName: appt.service_name, startTime: appt.start_time };
}

// Remarca um agendamento específico pelo ID (usado só após confirmação explícita)
async function rescheduleAppointmentById(tenantId, appointmentId, newStartTime) {
  const { data: appt, error } = await supabase
    .from('appointments')
    .select('*')
    .eq('id', appointmentId)
    .eq('tenant_id', tenantId)
    .single();

  if (error || !appt) {
    throw new Error('Agendamento não encontrado.');
  }

  const start = parseDateTimeSafe(newStartTime);
  const originalDurationMs = new Date(appt.end_time).getTime() - new Date(appt.start_time).getTime();
  const duration = originalDurationMs > 0 ? originalDurationMs / (60 * 1000) : 30;
  const end = new Date(start.getTime() + duration * 60 * 1000);

  if (appt.google_event_id) {
    try {
      const auth = await getOAuth2Client(tenantId);
      const calendar = google.calendar({ version: 'v3', auth });
      await calendar.events.patch({
        calendarId: 'primary',
        eventId: appt.google_event_id,
        requestBody: {
          start: { dateTime: start.toISOString(), timeZone: 'America/Sao_Paulo' },
          end: { dateTime: end.toISOString(), timeZone: 'America/Sao_Paulo' },
        },
      });
    } catch (gErr) {
      console.warn('Erro ao atualizar horário no Calendar:', gErr.message);
    }
  }

  await supabase
    .from('appointments')
    .update({
      start_time: start.toISOString(),
      end_time: end.toISOString(),
    })
    .eq('id', appt.id);

  return { success: true, serviceName: appt.service_name, newStart: start.toISOString(), durationMinutes: duration };
}

module.exports = {
  getGoogleAuthUrl,
  handleGoogleCallback,
  listBusySlots,
  createAppointmentEvent,
  findActiveAppointmentByPhone,
  cancelAppointmentById,
  rescheduleAppointmentById,
};
