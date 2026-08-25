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
            description: 'A data no formato YYYY-MM-DD para verificar horários ocupados.',
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
          startTime: { type: 'string', description: 'Data/Hora de início no formato ISO (YYYY-MM-DDTHH:mm:ss-03:00).' },
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
      description: 'Altera o dia ou horário de um agendamento já existente do cliente.',
      parameters: {
        type: 'object',
        properties: {
          customerPhone: { type: 'string', description: 'Telefone do cliente.' },
          newStartTime: { type: 'string', description: 'Novo horário de início no formato ISO (YYYY-MM-DDTHH:mm:ss-03:00).' },
        },
        required: ['customerPhone', 'newStartTime'],
      },
    },
  },
];

async function handleCustomerChat(tenantId, customerPhone, customerName, incomingMessage) {
  // 1. Verifica status da assinatura do Tenant
  const { data: tenant } = await supabase
    .from('tenants')
    .select('subscription_status, trial_ends_at')
    .eq('id', tenantId)
    .single();

  const isTrialExpired = tenant?.trial_ends_at && new Date(tenant.trial_ends_at) < new Date();
  const isInactive = tenant?.subscription_status !== 'active' && isTrialExpired;

  if (isInactive) {
    return "Olá! Nosso canal de agendamento automático está temporariamente em manutenção. Por favor, entre em contato diretamente com a barbearia pelo telefone principal.";
  }

  const [{ data: services }, { data: settings }] = await Promise.all([
    supabase.from('services').select('name, price, duration_minutes').eq('tenant_id', tenantId),
    supabase.from('business_settings').select('*').eq('tenant_id', tenantId).maybeSingle()
  ]);

  const servicesList = (services || [])
    .map(s => `- ${s.name}: R$ ${s.price} (${s.duration_minutes} min)`)
    .join('\n');

  const openTime = settings?.open_time || '09:00';
  const closeTime = settings?.close_time || '19:00';
  const lunchStart = settings?.lunch_start || '12:00';
  const lunchEnd = settings?.lunch_end || '13:00';
  const workDays = (settings?.work_days || ['segunda a sábado']).join(', ');

  const nowIso = new Date().toISOString();

  const systemInstruction = `
Você é o atendente virtual inteligente da barbearia.
Hoje e agora é: ${nowIso} (Fuso horário de Brasília -03:00).

REGRAS DE FUNCIONAMENTO:
- Dias de atendimento: ${workDays}
- Horário de abertura: ${openTime} | Horário de fechamento: ${closeTime}
- Intervalo de almoço / pausa: das ${lunchStart} às ${lunchEnd} (não agendar nesse intervalo)

Serviços disponíveis e preços:
${servicesList}

Diretrizes de Atendimento:
- Seja simpático, prestativo e direto.
- Respeite rigorosamente o horário de funcionamento e intervalo de almoço ao sugerir ou aceitar horários.
- Para verificar horários ocupados, chame "checkAvailability".
- Para novos agendamentos confirmados, chame "bookAppointment".
- Para cancelar horários, chame "cancelAppointment".
- Para remarcar, chame "rescheduleAppointment".
`;

  const messages = [
    { role: 'system', content: systemInstruction },
    { role: 'user', content: `[Cliente: ${customerName} | Telefone: ${customerPhone}]\nMensagem: ${incomingMessage}` },
  ];

  let response = await groq.chat.completions.create({
    model: 'openai/gpt-oss-120b',
    messages,
    tools,
    tool_choice: 'auto',
  });

  let responseMessage = response.choices[0].message;

  while (responseMessage.tool_calls && responseMessage.tool_calls.length > 0) {
    messages.push(responseMessage);

    for (const toolCall of responseMessage.tool_calls) {
      const functionName = toolCall.function.name;
      const args = JSON.parse(toolCall.function.arguments);
      let functionResponseData = {};

      try {
        if (functionName === 'checkAvailability') {
          const { date } = args;
          const busySlots = await listBusySlots(tenantId, date);
          functionResponseData = { busySlots, dateChecked: date };
        } else if (functionName === 'bookAppointment') {
          const { serviceName, startTime, durationMinutes, customerName: cName, customerPhone: cPhone } = args;
          const event = await createAppointmentEvent(tenantId, {
            customerName: cName || customerName,
            customerPhone: cPhone || customerPhone,
            serviceName,
            startTime,
            durationMinutes,
          });
          functionResponseData = { success: true, eventId: event.id, start: startTime };
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
        functionResponseData = { error: err.message };
      }

      messages.push({
        role: 'tool',
        tool_call_id: toolCall.id,
        content: JSON.stringify(functionResponseData),
      });
    }

    response = await groq.chat.completions.create({
      model: 'openai/gpt-oss-120b',
      messages,
      tools,
      tool_choice: 'auto',
    });

    responseMessage = response.choices[0].message;
  }

  return responseMessage.content;
}

module.exports = { handleCustomerChat };
