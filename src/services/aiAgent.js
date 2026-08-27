const Groq = require('groq-sdk');
const { createClient } = require('@supabase/supabase-js');
const { 
  listBusySlots, 
  createAppointmentEvent, 
  findActiveAppointmentByPhone,
  cancelAppointmentById,
  rescheduleAppointmentById
} = require('./calendarService');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } }
);

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

const GROQ_MODEL = 'openai/gpt-oss-20b';
const MAX_HISTORY_MESSAGES = 12;
const HISTORY_TTL_MINUTES = 30;
const MAX_TOOL_ITERATIONS = 4;
const PENDING_ACTION_TTL_MINUTES = 10;
const DUPLICATE_WINDOW_MS = 10 * 1000; // 10s pra considerar mensagem repetida

// ---------- Fila por conversa (evita processar 2 mensagens do mesmo cliente ao mesmo tempo) ----------

const conversationLocks = new Map();

function withConversationLock(key, fn) {
  const previous = conversationLocks.get(key) || Promise.resolve();
  const run = previous.then(fn, fn);
  conversationLocks.set(key, run.catch(() => {}));
  return run;
}

// ---------- Histórico de conversa ----------

async function getHistory(tenantId, customerPhone) {
  const cutoff = new Date(Date.now() - HISTORY_TTL_MINUTES * 60 * 1000).toISOString();
  const { data, error } = await supabase
    .from('conversation_history')
    .select('role, content, created_at')
    .eq('tenant_id', tenantId)
    .eq('customer_phone', customerPhone)
    .gte('created_at', cutoff)
    .order('created_at',
