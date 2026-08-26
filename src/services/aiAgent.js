const Groq = require('groq-sdk');
const { createClient } = require('@supabase/supabase-js');
const { 
  listBusySlots, 
  createAppointmentEvent, 
  cancelAppointmentEvent, 
  rescheduleAppointmentEvent 
} = require('./calendarService');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } }
);

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

// Modelo de chat rápido e compatível
const GROQ_MODEL = 'openai/gpt-oss-20b';

async function handleCustomerChat(tenantId, customerPhone, customerName, incomingMessage) {
  try {
    // 1. Verifica status do tenant
    const { data: tenant, error: tenantErr } = await supabase
      .from('tenants')
      .select('*')
      .eq('id', tenantId)
      .single();

    if (tenantErr) console.error('[Tenant Error]', tenantErr);

    const isTrialExpired = tenant?.trial_ends_at && new Date(tenant.trial_ends_at) < new Date();
    if (tenant?.subscription_status !== 'active' && isTrialExpired) {
      return "Olá! Nosso canal de agendamento automático está temporariamente em
