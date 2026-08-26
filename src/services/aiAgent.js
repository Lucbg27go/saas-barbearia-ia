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

const GROQ_MODEL = 'openai/gpt-oss-20b';
const MAX_HISTORY_MESSAGES = 12;
const HISTORY_TTL_MINUTES = 30;
const MAX_TOOL_ITERATIONS = 4; // evita loop infinito de chamadas de ferramenta

// ---------- Histórico de conversa (Supabase) ----------

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

// ---------- Definição das ferramentas (tools) ----------

const tools = [
  {
    type: 'function',
    function: {
      name: 'checkAvailability',
      description: 'Verifica se um horário específico está livre na agenda antes de confirmar um agendamento. Use SEMPRE antes de bookAppointment ou rescheduleAppointment.',
      parameters: {
        type: 'object',
        properties: {
          startTime: { type: 'string', description: 'Data e hora ISO com offset -03:00, ex: 2026-08-27T14:00:00-03:00' },
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
      description: 'Cria um novo agendamento na agenda depois que o cliente confirmou serviço, data e hora, e o horário foi validado como disponível.',
      parameters: {
        type: 'object',
        properties: {
          serviceName: { type: 'string', description: 'Nome exato do serviço, igual está cadastrado' },
          startTime: { type: 'string', description: 'Data e hora ISO com offset -03:00' },
          durationMinutes: { type: 'number', description: 'Duração do serviço em minutos' }
        },
        required: ['serviceName', 'startTime', 'durationMinutes']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'cancelAppointment',
      description: 'Cancela o agendamento ativo mais recente deste cliente. Use quando o cliente pedir para desmarcar/cancelar.',
      parameters: { type: 'object', properties: {}, required: [] }
    }
  },
  {
    type: 'function',
    function: {
      name: 'rescheduleAppointment',
      description: 'Remarca o agendamento ativo mais recente deste cliente para um novo horário, já validado como disponível.',
      parameters: {
        type: 'object',
        properties: {
          newStartTime: { type: 'string', description: 'Nova data e hora ISO com offset -03:00' }
        },
        required: ['newStartTime']
      }
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
  // Revalida disponibilidade no momento exato do agendamento (evita corrida entre mensagens)
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
    return { success: true, eventId: event.id, startTime: args.startTime, serviceName: args.serviceName };
  } catch (err) {
    console.error('[bookAppointment Error]', err);
    return { success: false, reason: 'Erro ao criar o agendamento na agenda.' };
  }
}

async function executeCancelAppointment(tenantId, customerPhone) {
  try {
    const result = await cancelAppointmentEvent(tenantId, customerPhone);
    return { success: true, ...result };
  } catch (err) {
    return { success: false, reason: err.message };
  }
}

async function executeRescheduleAppointment(tenantId, customerPhone, args) {
  try {
    const result = await rescheduleAppointmentEvent(tenantId, customerPhone, args.newStartTime);
    return { success: true, ...result };
  } catch (err) {
    return { success: false, reason: err.message };
  }
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
    case 'cancelAppointment':
      return executeCancelAppointment(tenantId, customerPhone);
    case 'rescheduleAppointment':
      return executeRescheduleAppointment(tenantId, customerPhone, args);
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
- Só liste todos os serviços na primeira vez ou se o cliente pedir. Depois disso, seja direto.
- Calcule datas relativas ("amanhã", "hoje", "sexta que vem") com base na data de hoje informada acima.
- Se faltar só um dado (ex: só falta a hora), pergunte só isso.

COMO USAR AS FERRAMENTAS:
- Antes de confirmar QUALQUER agendamento novo ou remarcação, chame checkAvailability primeiro.
- Só chame bookAppointment depois que o cliente confirmou serviço + data + hora, e o horário está disponível.
- Se checkAvailability disser que está indisponível, avise o cliente e peça outro horário — não tente agendar mesmo assim.
- Se o cliente pedir para cancelar, chame cancelAppointment diretamente.
- Se o cliente pedir para remarcar/mudar o horário, primeiro chame checkAvailability para o novo horário, depois rescheduleAppointment.
- Nunca invente um horário como disponível sem checar antes.
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
    let bookedOrChanged = false;

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
          if (
            (toolCall.function.name === 'bookAppointment' || toolCall.function.name === 'rescheduleAppointment' || toolCall.function.name === 'cancelAppointment')
            && result?.success
          ) {
            bookedOrChanged = true;
          }
          messages.push({
            role: 'tool',
            tool_call_id: toolCall.id,
            content: JSON.stringify(result)
          });
        }
        // continua o loop pra IA formular a resposta final com base no resultado da ferramenta
        continue;
      }

      // Sem tool_calls: essa é a resposta final em texto
      finalReply = message.content;
      break;
    }

    if (!finalReply) {
      finalReply = "Desculpe, tive uma dificuldade para processar sua solicitação. Pode repetir, por favor?";
    }

    await pushHistory(tenantId, customerPhone, 'user', incomingMessage);
    await pushHistory(tenantId, customerPhone, 'assistant', finalReply);

    // Agendamento/cancelamento/remarcação concluído: limpa histórico pra próxima conversa começar do zero
    if (bookedOrChanged) {
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
