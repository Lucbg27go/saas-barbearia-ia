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
    .order('created_at', { ascending: false })
    .limit(MAX_HISTORY_MESSAGES);

  if (error) {
    console.error('[History Fetch Error]', error);
    return [];
  }
  return (data || []).reverse().map(row => ({ role: row.role, content: row.content }));
}

async function pushHistory(tenantId, customerPhone, role, content) {
  const { error } = await supabase
    .from('conversation_history')
    .insert({ tenant_id: tenantId, customer_phone: customerPhone, role, content });
  if (error) console.error('[History Insert Error]', error);
}

// Verifica se a mensagem atual é uma repetição da última mensagem do cliente há poucos segundos.
// Se for, devolve a resposta que já foi dada, sem reprocessar (evita agendamento duplicado).
async function findDuplicateReply(tenantId, customerPhone, incomingMessage) {
  const cutoff = new Date(Date.now() - DUPLICATE_WINDOW_MS).toISOString();
  const { data, error } = await supabase
    .from('conversation_history')
    .select('role, content, created_at')
    .eq('tenant_id', tenantId)
    .eq('customer_phone', customerPhone)
    .gte('created_at', cutoff)
    .order('created_at', { ascending: false })
    .limit(4);

  if (error || !data || data.length < 2) return null;

  for (let i = 0; i < data.length - 1; i++) {
    if (data[i].role === 'assistant' && data[i + 1].role === 'user') {
      if (data[i + 1].content.trim() === incomingMessage.trim()) {
        return data[i].content;
      }
    }
  }
  return null;
}

// ---------- Ações pendentes (confirmação de agendar/cancelar/remarcar) ----------

async function getPendingAction(tenantId, customerPhone) {
  const { data, error } = await supabase
    .from('pending_actions')
    .select('*')
    .eq('tenant_id', tenantId)
    .eq('customer_phone', customerPhone)
    .gt('expires_at', new Date().toISOString())
    .order('created_at', { ascending: false })
    .limit(1)
    .single();

  if (error || !data) return null;
  return data;
}

async function setPendingAction(tenantId, customerPhone, actionType, payload, summary) {
  await supabase
    .from('pending_actions')
    .delete()
    .eq('tenant_id', tenantId)
    .eq('customer_phone', customerPhone);

  const expiresAt = new Date(Date.now() + PENDING_ACTION_TTL_MINUTES * 60 * 1000).toISOString();

  const { error } = await supabase
    .from('pending_actions')
    .insert({ tenant_id: tenantId, customer_phone: customerPhone, action_type: actionType, payload, summary, expires_at: expiresAt });

  if (error) console.error('[Pending Action Insert Error]', error);
}

async function clearPendingAction(tenantId, customerPhone) {
  await supabase
    .from('pending_actions')
    .delete()
    .eq('tenant_id', tenantId)
    .eq('customer_phone', customerPhone);
}

// ---------- Ferramentas (tools) ----------

const tools = [
  {
    type: 'function',
    function: {
      name: 'checkAvailability',
      description: 'Consulta se um horário está livre, apenas para informar o cliente. Não propõe nem executa nada.',
      parameters: {
        type: 'object',
        properties: {
          startTime: { type: 'string', description: 'Data e hora ISO com offset -03:00' },
          durationMinutes: { type: 'number' }
        },
        required: ['startTime', 'durationMinutes']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'proposeBookAppointment',
      description: 'PROPÕE um novo agendamento (não cria ainda). Só chame se o cliente já informou claramente o SERVIÇO, a DATA e a HORA. Depois de chamar, confirme com o cliente antes de executar.',
      parameters: {
        type: 'object',
        properties: {
          serviceName: { type: 'string', description: 'Nome do serviço exatamente como informado pelo cliente' },
          startTime: { type: 'string', description: 'Data e hora ISO com offset -03:00' }
        },
        required: ['serviceName', 'startTime']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'proposeCancelAppointment',
      description: 'Busca o agendamento ativo do cliente e PROPÕE o cancelamento (não cancela ainda).',
      parameters: { type: 'object', properties: {}, required: [] }
    }
  },
  {
    type: 'function',
    function: {
      name: 'proposeRescheduleAppointment',
      description: 'Busca o agendamento ativo do cliente e PROPÕE remarcar para um novo horário (não remarca ainda). Só chame se o cliente já disse claramente o novo horário desejado.',
      parameters: {
        type: 'object',
        properties: {
          newStartTime: { type: 'string', description: 'Novo horário desejado, ISO com offset -03:00' }
        },
        required: ['newStartTime']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'confirmPendingAction',
      description: 'Executa a ação (agendar, cancelar ou remarcar) que foi proposta anteriormente. SÓ chame depois que o cliente confirmar explicitamente ("sim", "confirmo", etc.) NA MENSAGEM ATUAL.',
      parameters: { type: 'object', properties: {}, required: [] }
    }
  },
  {
    type: 'function',
    function: {
      name: 'rejectPendingAction',
      description: 'Descarta a proposta pendente sem executar nada. Use se o cliente disser "não" ou mudar de ideia.',
      parameters: { type: 'object', properties: {}, required: [] }
    }
  }
];

// ---------- Execução das ferramentas ----------

function hasConflict(busySlots, start, end) {
  return busySlots.find(slot => {
    const slotStart = new Date(slot.start);
    const slotEnd = new Date(slot.end);
    return start < slotEnd && slotStart < end;
  });
}

async function executeCheckAvailability(tenantId, args) {
  const start = new Date(args.startTime);
  if (isNaN(start.getTime())) return { available: false, error: 'Data/hora inválida.' };

  const duration = parseInt(args.durationMinutes, 10) || 30;
  const end = new Date(start.getTime() + duration * 60 * 1000);
  const dateStr = args.startTime.split('T')[0];

  try {
    const busySlots = await listBusySlots(tenantId, dateStr);
    const conflict = hasConflict(busySlots, start, end);
    return conflict
      ? { available: false, reason: `Horário ocupado (${conflict.summary || 'outro compromisso'})` }
      : { available: true };
  } catch (err) {
    console.error('[checkAvailability Error]', err);
    return { available: false, error: 'Não foi possível consultar a agenda agora.' };
  }
}

async function findServiceByName(tenantId, serviceName) {
  if (!serviceName) return null;
  const { data } = await supabase
    .from('services')
    .select('name, price, duration_minutes')
    .eq('tenant_id', tenantId);

  if (!data) return null;
  const normalized = serviceName.trim().toLowerCase();
  return (
    data.find(s => s.name.trim().toLowerCase() === normalized) ||
    data.find(s => s.name.trim().toLowerCase().includes(normalized) || normalized.includes(s.name.trim().toLowerCase())) ||
    null
  );
}

async function executeProposeBookAppointment(tenantId, customerName, customerPhone, args) {
  const service = await findServiceByName(tenantId, args.serviceName);
  if (!service) {
    return { found: false, message: 'Serviço não encontrado no catálogo. Peça ao cliente para escolher um dos serviços cadastrados.' };
  }

  const durationMinutes = service.duration_minutes || 30;
  const availability = await executeCheckAvailability(tenantId, { startTime: args.startTime, durationMinutes });
  if (!availability.available) {
    return { found: true, available: false, reason: availability.reason || availability.error };
  }

  const summary = `Agendamento de ${service.name} em ${args.startTime}`;
  await setPendingAction(tenantId, customerPhone, 'book', {
    serviceName: service.name,
    startTime: args.startTime,
    durationMinutes,
    price: service.price,
    customerName
  }, summary);

  return {
    found: true,
    available: true,
    serviceName: service.name,
    startTime: args.startTime,
    durationMinutes,
    price: service.price,
    awaitingConfirmation: true
  };
}

async function executeProposeCancelAppointment(tenantId, customerPhone) {
  const appt = await findActiveAppointmentByPhone(tenantId, customerPhone);
  if (!appt) {
    return { found: false, message: 'Não encontrei nenhum agendamento ativo para este cliente.' };
  }

  const summary = `Cancelamento de ${appt.service_name} em ${appt.start_time}`;
  await setPendingAction(tenantId, customerPhone, 'cancel', { appointmentId: appt.id }, summary);

  return { found: true, serviceName: appt.service_name, startTime: appt.start_time, awaitingConfirmation: true };
}

async function executeProposeRescheduleAppointment(tenantId, customerPhone, args) {
  const appt = await findActiveAppointmentByPhone(tenantId, customerPhone);
  if (!appt) {
    return { found: false, message: 'Não encontrei nenhum agendamento ativo para este cliente.' };
  }

  const durationMs = new Date(appt.end_time).getTime() - new Date(appt.start_time).getTime();
  const durationMinutes = durationMs > 0 ? durationMs / (60 * 1000) : 30;

  const availability = await executeCheckAvailability(tenantId, { startTime: args.newStartTime, durationMinutes });
