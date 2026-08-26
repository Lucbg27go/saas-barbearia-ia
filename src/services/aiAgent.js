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

// Lista priorizada de modelos de chat válidos na Groq
const CHAT_MODELS = [
  'llama-3.3-70b-versatile',
  'llama-3.1-70b-versatile',
  'llama3-70b-8192',
  'llama-3.1-8b-instant',
  'llama3-8b-8192',
  'mixtral-8x7b-32768',
  'gemma2-9b-it'
];

async function getAvailableModel() {
  try {
    const list = await groq.models.list();
    const available = (list.data || []).map(m => m.id);
    console.log('[Groq] Modelos ativos detectados:', available.join(', '));

    for (const model of CHAT_MODELS) {
      if (available.includes(model)) {
        return model;
      }
    }

    // Se nenhum preferido bater, pega o primeiro que for puramente texto (não whisper / vision / embed)
    const validTextModel = available.find(id => 
      !id.includes('whisper') && 
      !id.includes('embed') && 
      !id.includes('guard')
    );

    if (validTextModel) return validTextModel;
  } catch (err) {
    console.warn('[Groq Models Warning] Falha ao consultar lista:', err.message);
  }

  // Fallback padrão seguro
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
            description: 'Data no formato YYYY-MM-DD para consultar horários ocupados.',
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
          durationMinutes: { type: 'number', description: 'Duração em minutos do serviço.' },
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
          customerPhone: { type: 'string', description: 'Telefone do cliente que deseja cancelar.' },
        },
        required: ['customerPhone'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'rescheduleAppointment',
      description: 'Altera o dia ou horário de um agendamento já existente.',
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
  try {
    // 1. Busca configurações e assinatura do tenant
    const { data: tenant, error: tenantErr } = await supabase
      .from('tenants')
      .select('*')
      .eq('id', tenantId)
      .single();

    if (tenantErr) {
      console.error('[Tenant Fetch Error]', tenantErr);
    }

    const isTrialExpired = tenant?.trial_ends_at && new Date(tenant.trial_ends_at) < new Date();
    if (tenant?.subscription_status !== 'active' && isTrialExpired) {
      return "Olá! Nosso canal de agendamento automático está temporariamente indisponível. Por favor, entre em contato diretamente com a barbearia.";
    }

    // 2. Busca os serviços cadastrados
    const { data: services } = await supabase
      .from('services')
      .select('name, price, duration_minutes')
      .eq('tenant_id', tenantId);

    const servicesList = (services && services.length > 0)
      ? services.map(s => `- ${s.name}: R$ ${parseFloat(s.price).toFixed(2)} (${s.duration_minutes || 30} min)`).join('\n')
      : 'Nenhum serviço cadastrado no momento.';

    // Horários e dias configurados
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

    const systemInstruction = `
Você é o atendente virtual inteligente da barbearia.
Hoje é: ${formattedToday} | Horário atual: ${nowIso} (Horário de Brasília -03:00).

REGRAS DE FUNCIONAMENTO:
- Dias de funcionamento: ${workDays}
- Horário de atendimento: das ${openTime} às ${closeTime}
- Intervalo de almoço: das ${lunchStart} às ${lunchEnd} (NÃO agendar nesse período)

Serviços disponíveis:
${servicesList}

DIRETRIZES DE ATENDIMENTO:
1. Seja amigável, ágil e direto.
2. Quando o cliente solicitar um agendamento e informar o serviço, data e horário:
   - Verifique se a barbearia abre no dia solicitado e se o horário respeita a abertura, fechamento e almoço.
   - Execute IMEDIATAMENTE a ferramenta "bookAppointment" passando startTime em formato ISO com offset (-03:00).
   - Ao receber o resultado positivo da ferramenta, responda confirmando o corte com serviço, data, horário e valor.
3. Se o cliente perguntar os horários vagos, execute a ferramenta "checkAvailability".
`;

    const messages = [
      { role: 'system', content: systemInstruction },
      { role: 'user', content: `[Cliente: ${customerName} | Telefone: ${customerPhone}]\nMensagem: ${incomingMessage}` },
    ];

    const modelToUse = await getAvailableModel();
    console.log(`[Tenant ${tenantId}] Usando modelo: ${modelToUse}`);

    let response = await groq.chat.completions.create({
      model: modelToUse,
      messages,
      tools,
      tool_choice: 'auto',
    });

    let responseMessage = response.choices[0].message;

    // Processamento das ferramentas (Function Calling)
    let loopCount = 0;
    while (responseMessage.tool_calls && responseMessage.tool_calls.length > 0 && loopCount < 5) {
      loopCount++;
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
        } catch (toolErr) {
          console.error(`[Tool Execution Error - ${functionName}]:`, toolErr.message);
          functionResponseData = { error: toolErr.message };
        }

        messages.push({
          role: 'tool',
          tool_call_id: toolCall.id,
          content: JSON.stringify(functionResponseData),
        });
      }

      response = await groq.chat.completions.create({
        model: modelToUse,
        messages,
        tools,
        tool_choice: 'auto',
      });

      responseMessage = response.choices[0].message;
    }

    return responseMessage.content || "Desculpe, não consegui entender completamente. Poderia repetir?";
  } catch (globalErr) {
    console.error(`[AI Agent Error]:`, globalErr);
    return "Olá! Tivemos uma pequena oscilação no momento. Poderia me informar novamente o serviço e o horário desejado?";
  }
}

module.exports = {
  processUserMessage: handleCustomerChat,
  handleCustomerChat,
};
