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

async function clearHistory(tenantId, customerPhone) {
  const { error } = await supabase
    .from('conversation_history')
    .delete()
    .eq('tenant_id', tenantId)
    .eq('customer_phone', customerPhone);
  if (error) console.error('[History Clear Error]', error);
}

// ---------- Ações pendentes (confirmação de cancelamento/remarcação) ----------

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
      description: 'Verifica se um horário específico está livre na agenda antes de confirmar um agendamento novo. Use SEMPRE antes de bookAppointment.',
      parameters: {
        type: 'object',
        properties: {
          startTime: { type: 'string', description: 'Data e hora ISO com offset -03:00' },
          durationMinutes: { type: 'number', description: 'Duração do serviço em minutos' }
        },
        required: ['startTime', 'durationMinutes']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'bookAppointment',
      description: 'Cria um novo agendamento depois que o cliente confirmou serviço, data e hora, e o horário foi validado como disponível.',
      parameters: {
        type: 'object',
        properties: {
          serviceName: { type: 'string' },
          startTime: { type: 'string', description: 'Data e hora ISO com offset -03:00' },
          durationMinutes: { type: 'number' }
        },
        required: ['serviceName', 'startTime', 'durationMinutes']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'proposeCancelAppointment',
      description: 'Busca o agendamento ativo do cliente e PROPÕE o cancelamento (não cancela ainda). Use quando o cliente pedir para desmarcar. Depois de chamar, pergunte ao cliente se ele confirma.',
      parameters: { type: 'object', properties: {}, required: [] }
    }
  },
  {
    type: 'function',
    function: {
      name: 'proposeRescheduleAppointment',
      description: 'Busca o agendamento ativo do cliente e PROPÕE remarcar para um novo horário (não remarca ainda). Depois de chamar, pergunte ao cliente se ele confirma o novo horário.',
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
      description: 'Executa a ação de cancelamento ou remarcação que foi proposta anteriormente. SÓ chame isso depois que o cliente confirmar explicitamente (ex: "sim", "confirmo", "pode ser") na mensagem atual.',
      parameters: { type: 'object', properties: {}, required: [] }
    }
  },
  {
    type: 'function',
    function: {
      name: 'rejectPendingAction',
      description: 'Cancela/descarta a proposta pendente sem executar nada. Use quando o cliente disser "não", "deixa quieto" ou mudar de ideia.',
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

async function executeBookAppointment(tenantId, customerName, customerPhone, args) {
  const availability = await executeCheckAvailability(tenantId, args);
  if (!availability.available) {
    return { success: false, reason: availability.reason || availability.error || 'Horário indisponível.' };
  }

  try {
    const event = await createAppointmentEvent(tenantId, {
      customerName,
      customerPhone,
      serviceName: args.serviceName,
      startTime: args.startTime,
      durationMinutes: args.durationMinutes
    });
    return { success: true, startTime: args.startTime, serviceName: args.serviceName };
  } catch (err) {
    console.error('[bookAppointment Error]', err);
    return { success: false, reason: 'Erro ao criar o agendamento na agenda.' };
  }
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
  if (!availability.available) {
    return { found: true, available: false, reason: availability.reason || availability.error };
  }

  const summary = `Remarcação de ${appt.service_name} para ${args.newStartTime}`;
  await setPendingAction(
    tenantId,
    customerPhone,
    'reschedule',
    { appointmentId: appt.id, newStartTime: args.newStartTime, durationMinutes },
    summary
  );

  return { found: true, available: true, serviceName: appt.service_name, currentStart: appt.start_time, newStartTime: args.newStartTime, awaitingConfirmation: true };
}

async function executeConfirmPendingAction(tenantId, customerPhone) {
  const pending = await getPendingAction(tenantId, customerPhone);
  if (!pending) {
    return { success: false, reason: 'Não há nenhuma solicitação pendente para confirmar.' };
  }

  try {
    if (pending.action_type === 'cancel') {
      const result = await cancelAppointmentById(tenantId, pending.payload.appointmentId);
      await clearPendingAction(tenantId, customerPhone);
      return { success: true, action: 'cancel', ...result };
    }

    if (pending.action_type === 'reschedule') {
      // Revalida disponibilidade no momento da confirmação (pode ter mudado desde a proposta)
      const availability = await executeCheckAvailability(tenantId, {
        startTime: pending.payload.newStartTime,
        durationMinutes: pending.payload.durationMinutes
      });
      if (!availability.available) {
        await clearPendingAction(tenantId, customerPhone);
        return { success: false, reason: `Esse horário ficou indisponível enquanto aguardávamos (${availability.reason || availability.error}). Peça um novo horário ao cliente.` };
      }

      const result = await rescheduleAppointmentById(tenantId, pending.payload.appointmentId, pending.payload.newStartTime);
      await clearPendingAction(tenantId, customerPhone);
      return { success: true, action: 'reschedule', ...result };
    }

    return { success: false, reason: 'Tipo de ação pendente desconhecido.' };
  } catch (err) {
    console.error('[confirmPendingAction Error]', err);
    await clearPendingAction(tenantId, customerPhone);
    return { success: false, reason: 'Erro ao executar a ação confirmada.' };
  }
}

async function executeRejectPendingAction(tenantId, customerPhone) {
  await clearPendingAction(tenantId, customerPhone);
  return { success: true, cleared: true };
}

async function dispatchToolCall(toolCall, ctx) {
  const { tenantId, customerName, customerPhone } = ctx;
  let args = {};
  try {
    args = JSON.parse(toolCall.function.arguments || '{}');
  } catch (e) {
    return { error: 'Argumentos inválidos recebidos.' };
  }

  switch (toolCall.function.name) {
    case 'checkAvailability':
      return executeCheckAvailability(tenantId, args);
    case 'bookAppointment':
      return executeBookAppointment(tenantId, customerName, customerPhone, args);
    case 'proposeCancelAppointment':
      return executeProposeCancelAppointment(tenantId, customerPhone);
    case 'proposeRescheduleAppointment':
      return executeProposeRescheduleAppointment(tenantId, customerPhone, args);
    case 'confirmPendingAction':
      return executeConfirmPendingAction(tenantId, customerPhone);
    case 'rejectPendingAction':
      return executeRejectPendingAction(tenantId, customerPhone);
    default:
      return { error: `Ferramenta desconhecida: ${toolCall.function.name}` };
  }
}

// ---------- Handler principal ----------

async function handleCustomerChat(tenantId, customerPhone, customerName, incomingMessage) {
  try {
    const { data: tenant, error: tenantErr } = await supabase
      .from('tenants')
      .select('*')
      .eq('id', tenantId)
      .single();

    if (tenantErr) console.error('[Tenant Error]', tenantErr);

    const isTrialExpired = tenant?.trial_ends_at && new Date(tenant.trial_ends_at) < new Date();
    if (tenant?.subscription_status !== 'active' && isTrialExpired) {
      return "Olá! Nosso canal de agendamento automático está temporariamente em manutenção. Por favor, entre em contato diretamente com a barbearia.";
    }

    const { data: services } = await supabase
      .from('services')
      .select('name, price, duration_minutes')
      .eq('tenant_id', tenantId);

    const servicesList = (services && services.length > 0)
      ? services.map(s => `- ${s.name}: R$ ${parseFloat(s.price).toFixed(2)} (${s.duration_minutes || 30} min)`).join('\n')
      : 'Nenhum serviço cadastrado';

    const openTime = tenant?.open_time || '09:00';
    const closeTime = tenant?.close_time || '19:00';
    const lunchStart = tenant?.lunch_start || '12:00';
    const lunchEnd = tenant?.lunch_end || '13:00';
    const workDays = Array.isArray(tenant?.work_days) && tenant.work_days.length > 0
      ? tenant.work_days.join(', ')
      : 'seg, ter, qua, qui, sex, sab, dom';

    const brasiliaNow = new Date(new Date().toLocaleString("en-US", { timeZone: "America/Sao_Paulo" }));
    const formattedToday = brasiliaNow.toISOString().split('T')[0];
    const nowIso = brasiliaNow.toISOString();

    const systemPrompt = `
Você é a atendente virtual da Barbearia. Converse de forma natural, calorosa e objetiva, como uma pessoa real faria pelo WhatsApp — evite soar robótica ou repetitiva.

Hoje é: ${formattedToday} | Horário atual: ${nowIso} (Horário de Brasília -03:00).

REGRAS DA BARBEARIA:
- Dias de atendimento: ${workDays}
- Horário: das ${openTime} às ${closeTime}
- Intervalo de almoço: das ${lunchStart} às ${lunchEnd} (NÃO agendar nesse horário)

SERVIÇOS CADASTRADOS:
${servicesList}

COMO CONVERSAR:
- Use o HISTÓRICO da conversa para lembrar o que o cliente já disse. NUNCA pergunte de novo algo que ele já respondeu.
- Só liste todos os serviços na primeira vez ou se o cliente pedir.
- Calcule datas relativas ("amanhã", "sexta que vem") com base na data de hoje informada acima.

REGRAS DE FERRAMENTAS — MUITO IMPORTANTE:
- Para AGENDAR um serviço novo: chame checkAvailability, e se estiver livre, chame bookAppointment diretamente (não precisa de confirmação extra).
- Para CANCELAR: NUNCA cancele direto. Primeiro chame proposeCancelAppointment, informe ao cliente exatamente qual agendamento seria cancelado (serviço, data, hora) e pergunte se ele confirma. Só chame confirmPendingAction depois que o cliente disser claramente "sim"/"confirmo"/algo equivalente NA MENSAGEM ATUAL.
- Para REMARCAR: NUNCA remarque direto. Primeiro chame proposeRescheduleAppointment com o novo horário, informe ao cliente o que mudaria (de/para) e pergunte se confirma. Só chame confirmPendingAction depois da confirmação explícita.
- Se o cliente disser "não", "deixa quieto" ou mudar de ideia sobre uma proposta pendente, chame rejectPendingAction.
- Nunca invente que algo foi cancelado ou remarcado sem ter chamado confirmPendingAction e recebido success:true de volta.
- Depois que uma ferramenta responder, formule você mesma a mensagem final pro cliente em texto natural — nunca responda em JSON.
`;

    const history = await getHistory(tenantId, customerPhone);

    let messages = [
      { role: 'system', content: systemPrompt },
      ...history,
      { role: 'user', content: `[Cliente: ${customerName} | Telefone: ${customerPhone}]\nMensagem: ${incomingMessage}` }
    ];

    const ctx = { tenantId, customerName, customerPhone };
    let finalReply = null;
    let shouldClearHistory = false;

    for (let i = 0; i < MAX_TOOL_ITERATIONS; i++) {
      const completion = await groq.chat.completions.create({
        model: GROQ_MODEL,
        messages,
        tools,
        tool_choice: 'auto'
      });

      const message = completion.choices[0]?.message;
      if (!message) break;

      messages.push(message);

      if (message.tool_calls && message.tool_calls.length > 0) {
        for (const toolCall of message.tool_calls) {
          const result = await dispatchToolCall(toolCall, ctx);
          if (toolCall.function.name === 'bookAppointment' && result?.success) shouldClearHistory = true;
          if (toolCall.function.name === 'confirmPendingAction' && result?.success) shouldClearHistory = true;

          messages.push({
            role: 'tool',
            tool_call_id: toolCall.id,
            content: JSON.stringify(result)
          });
        }
        continue;
      }

      finalReply = message.content;
      break;
    }

    if (!finalReply) {
      finalReply = "Desculpe, tive uma dificuldade para processar sua solicitação. Pode repetir, por favor?";
    }

    await pushHistory(tenantId, customerPhone, 'user', incomingMessage);
    await pushHistory(tenantId, customerPhone, 'assistant', finalReply);

    if (shouldClearHistory) {
      await clearHistory(tenantId, customerPhone);
    }

    return finalReply;
  } catch (err) {
    console.error('[AI Handler Error]', err);
    return "Olá! Tivemos uma pequena oscilação. Poderia me confirmar o serviço e o horário que deseja agendar?";
  }
}

module.exports = {
  processUserMessage: handleCustomerChat,
  handleCustomerChat,
};
