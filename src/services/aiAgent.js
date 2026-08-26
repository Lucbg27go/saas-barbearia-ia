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

// Função robusta que pega exatamente um modelo de chat disponível na sua chave
async function getActiveChatModel() {
  const preferredTextModels = [
    'llama3-70b-8192',
    'llama3-8b-8192',
    'llama-3.3-70b-versatile',
    'llama-3.1-70b-versatile',
    'llama-3.1-8b-instant',
    'mixtral-8x7b-32768',
    'gemma2-9b-it'
  ];

  try {
    const list = await groq.models.list();
    const available = (list.data || []).map(m => m.id);
    console.log('[Groq] Modelos disponíveis na conta:', available.join(', '));
    
    // Procura na ordem de prioridade
    for (const model of preferredTextModels) {
      if (available.includes(model)) {
        return model;
      }
    }

    // Se nenhum dos preferidos bater, pega o primeiro que NÃO for whisper/áudio
    const textOnly = available.filter(id => !id.includes('whisper') && !id.includes('embed'));
    if (textOnly.length > 0) {
      return textOnly[0];
    }
  } catch (err) {
    console.warn('[Groq Models Warning] Erro ao listar modelos:', err.message);
  }

  return 'llama3-8b-8192';
}

const tools = [
  {
    type: 'function',
    function: {
      name: 'checkAvailability',
      description: 'Verifica horários ocupados na agenda em uma determinada data.',
      parameters: {
        type: 'object',
        properties: {
          date: {
            type: 'string',
            description: 'Data no formato YYYY-MM-DD para consultar disponibilidade.',
          },
        },
        required: ['date'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'bookAppointment',
      description: 'Agenda o horário na barbearia quando o cliente confirmar serviço, data e hora.',
      parameters: {
        type: 'object',
        properties: {
          serviceName: { type: 'string', description: 'Nome do serviço escolhido.' },
          startTime: { type: 'string', description: 'Data/Hora de início no formato ISO (ex: 2026-08-27T10:00:00-03:00).' },
          durationMinutes: { type: 'number', description: 'Duração em minutos.' },
          customerName: { type: 'string', description: 'Nome do cliente.' },
          customerPhone: { type: 'string', description: 'Telefone do cliente.' },
        },
        required: ['serviceName', 'startTime', 'durationMinutes', 'customerName', 'customerPhone'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'cancelAppointment',
      description: 'Cancela o agendamento atual do cliente.',
      parameters: {
        type: 'object',
        properties: {
          customerPhone: { type: 'string', description: 'Telefone do cliente.' },
        },
        required: ['customerPhone'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'rescheduleAppointment',
      description: 'Remarca um horário já existente do cliente.',
      parameters: {
        type: 'object',
        properties: {
          customerPhone: { type: 'string', description: 'Telefone do cliente.' },
          newStartTime: { type: 'string', description: 'Novo horário ISO (ex: 2026-08-27T14:00:00-03:00).' },
        },
        required: ['customerPhone', 'newStartTime'],
      },
    },
  },
];

async function handleCustomerChat(tenantId, customerPhone, customerName, incomingMessage) {
  // 1. Verifica status do tenant
  const { data: tenant } = await supabase
    .from('tenants')
    .select('*')
    .eq('id', tenantId)
    .single();

  const isTrialExpired = tenant?.trial_ends_at && new Date(tenant.trial_ends_at) < new Date();
  if (tenant?.subscription_status !== 'active' && isTrialExpired) {
    return "Olá! Nosso canal de agendamento automático está temporariamente em manutenção. Por favor, entre em contato diretamente com a barbearia.";
  }

  // 2. Busca os serviços cadastrados
  const { data: services } = await supabase
    .from('services')
    .select('name, price, duration_minutes')
    .eq('tenant_id', tenantId);

  const servicesList = (services || [])
    .map(s => `- ${s.name}: R$ ${parseFloat(s.price).toFixed(2)} (${s.duration_minutes || 30} min)`)
    .join('\n');

  // Configurações de horários e escala
  const openTime = tenant?.open_time || '09:00';
  const closeTime = tenant?.close_time || '19:00';
  const lunchStart = tenant?.lunch_start || '12:00';
  const lunchEnd = tenant?.lunch_end || '13:00';
  const workDays = Array.isArray(tenant?.work_days)
    ? tenant.work_days.join(', ')
    : 'seg, ter, qua, qui, sex, sab, dom';

  const brasiliaDate = new Date(new Date().toLocaleString("en-US", { timeZone: "America/Sao_Paulo" }));
  const formattedToday = brasiliaDate.toISOString().split('T')[0];
  const nowIso = brasiliaDate.toISOString();

  const systemInstruction = `
Você é a atendente virtual inteligente da barbearia.
Hoje é: ${formattedToday} | Horário atual: ${nowIso} (Horário de Brasília -03:00).

REGRAS DE FUNCIONAMENTO:
- Dias de funcionamento: ${workDays}
- Horário de atendimento: das ${openTime} às ${closeTime}
- Intervalo de almoço: das ${lunchStart} às ${lunchEnd} (NÃO agendar nesse intervalo)

Serviços disponíveis:
${servicesList || 'Nenhum serviço cadastrado'}

DIRETRIZES OBRIGATÓRIAS:
1. Seja educado, objetivo e rápido.
2. Quando o cliente escolher o serviço, dia e horário:
   - Verifique se está dentro do horário e dias de atendimento.
   - Execute IMEDIATAMENTE a ferramenta "bookAppointment" passando a data/hora ISO com offset (-03:00).
   - Ao receber o retorno de sucesso da ferramenta, confirme todos os dados do agendamento para o cliente.
3. Se o cliente perguntar horários disponíveis, execute "checkAvailability".
`;

  const messages = [
    { role: 'system', content: systemInstruction },
    { role: 'user', content: `[Cliente: ${customerName} | Telefone: ${customerPhone}]\nMensagem: ${incomingMessage}` },
  ];

  const selectedModel = await getActiveChatModel();
  console.log(`[Tenant ${tenantId}] Usando modelo Groq: ${selectedModel}`);

  let response = await groq.chat.completions.create({
    model: selectedModel,
    messages,
    tools,
    tool_choice: 'auto',
  });

  let responseMessage = response.choices[0].message;

  // Processamento de Function Calling
  while (responseMessage.tool_calls && responseMessage.tool_calls.length > 0) {
    messages.push(responseMessage);

    for (const toolCall of responseMessage.tool_calls) {
      const functionName = toolCall.function.name;
      let args = {};
      try {
        args = JSON.parse(toolCall.function.arguments);
      } catch (e) {
        args = {};
      }

      let functionResponseData = {};

      try {
        if (functionName === 'checkAvailability') {
          const { date } = args;
          const busySlots = await listBusySlots(tenantId, date || formattedToday);
          functionResponseData = { busySlots, dateChecked: date };
        } else if (functionName === 'bookAppointment') {
          const { serviceName, startTime, durationMinutes, customerName: cName, customerPhone: cPhone } = args;
          const event = await createAppointmentEvent(tenantId, {
            customerName: cName || customerName,
            customerPhone: cPhone || customerPhone,
            serviceName,
            startTime,
            durationMinutes: durationMinutes || 30,
          });
          functionResponseData = { success: true, eventId: event?.id || 'ok', start: startTime };
        } else if (functionName === 'cancelAppointment') {
          const resCancel = await cancelAppointmentEvent(tenantId, args.customerPhone || customerPhone);
          functionResponseData = resCancel;
        } else if (functionName === 'rescheduleAppointment') {
          const resReschedule = await rescheduleAppointmentEvent(
            tenantId, 
            args.customerPhone || customerPhone, 
            args.newStartTime
          );
          functionResponseData = resReschedule;
        }
      } catch (err) {
        console.error(`[Tool Error ${functionName}]`, err);
        functionResponseData = { error: err.message };
      }

      messages.push({
        role: 'tool',
        tool_call_id: toolCall.id,
        content: JSON.stringify(functionResponseData),
      });
    }

    response = await groq.chat.completions.create({
      model: selectedModel,
      messages,
      tools,
      tool_choice: 'auto',
    });

    responseMessage = response.choices[0].message;
  }

  return responseMessage.content;
}

module.exports = {
  processUserMessage: handleCustomerChat,
  handleCustomerChat,
};
