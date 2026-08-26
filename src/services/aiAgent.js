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

const MAX_HISTORY_MESSAGES = 12; // ~6 pares de pergunta/resposta
const HISTORY_TTL_MINUTES = 30;  // ignora mensagens mais antigas que isso

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

  // vem em ordem decrescente, precisa inverter pra ordem cronológica
  return (data || [])
    .reverse()
    .map(row => ({ role: row.role, content: row.content }));
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
      return "Olá! Nosso canal de agendamento automático está temporariamente em manutenção. Por favor, entre em contato diretamente com a barbearia.";
    }

    // 2. Busca os serviços cadastrados
    const { data: services } = await supabase
      .from('services')
      .select('name, price, duration_minutes')
      .eq('tenant_id', tenantId);

    const servicesList = (services && services.length > 0)
      ? services.map(s => `- ${s.name}: R$ ${parseFloat(s.price).toFixed(2)} (${s.duration_minutes || 30} min)`).join('\n')
      : 'Nenhum serviço cadastrado';

    // Regras de horário
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
- Use o HISTÓRICO da conversa para lembrar o que o cliente já disse (serviço, data, hora). NUNCA pergunte de novo algo que ele já respondeu.
- Só liste todos os serviços na primeira vez ou se o cliente pedir. Depois disso, seja direto.
- Calcule datas relativas ("amanhã", "hoje", "sexta que vem") com base na data de hoje informada acima.
- Se faltar só um dado (ex: só falta a hora), pergunte só isso, sem repetir o resto.

INSTRUÇÃO DE RESPOSTA OBRIGATÓRIA:
Você SEMPRE deve responder em formato JSON estrito, sem formatações Markdown adicionais fora do JSON.

FORMATO DO JSON:
{
  "action": "reply" | "book" | "check",
  "replyMessage": "Texto da sua mensagem que o cliente vai ler no WhatsApp",
  "bookingData": {
    "serviceName": "Nome exato do serviço",
    "startTime": "Data e hora ISO com offset -03:00 (Ex: ${formattedToday}T14:00:00-03:00)",
    "durationMinutes": 30
  }
}

COMO DECIDIR A ACTION:
- Se o cliente apenas disser "olá", perguntar serviços ou tiver dúvidas -> "action": "reply"
- Se o cliente pedir para agendar e já tiver informado o serviço e horário (mesmo que em mensagens anteriores) -> "action": "book", preencha o "bookingData" com a data/hora calculada e coloque em "replyMessage" uma confirmação cordial com o resumo do agendamento (serviço, data, hora e valor).
- Não agende em horários fora do expediente ou durante o almoço.
`;

    const history = await getHistory(tenantId, customerPhone);

    const chatCompletion = await groq.chat.completions.create({
      model: GROQ_MODEL,
      messages: [
        { role: 'system', content: systemPrompt },
        ...history,
        { role: 'user', content: `[Cliente: ${customerName} | Telefone: ${customerPhone}]\nMensagem: ${incomingMessage}` }
      ],
      response_format: { type: 'json_object' }
    });

    const rawResponse = chatCompletion.choices[0]?.message?.content || '{}';
    let parsed;
    try {
      parsed = JSON.parse(rawResponse);
    } catch (e) {
      return rawResponse;
    }

    // Salva a troca no histórico (mensagem do cliente + resposta da IA)
    await pushHistory(tenantId, customerPhone, 'user', incomingMessage);
    await pushHistory(tenantId, customerPhone, 'assistant', parsed.replyMessage || rawResponse);

    // Se a IA decidiu agendar
    if (parsed.action === 'book' && parsed.bookingData) {
      try {
        await createAppointmentEvent(tenantId, {
          customerName,
          customerPhone,
          serviceName: parsed.bookingData.serviceName || 'Corte',
          startTime: parsed.bookingData.startTime,
          durationMinutes: parsed.bookingData.durationMinutes || 30
        });
        // Agendamento concluído: limpa o histórico pra próxima conversa começar do zero
        await clearHistory(tenantId, customerPhone);
      } catch (bookErr) {
        console.error('[Calendar Booking Error]', bookErr);
      }
    }

    return parsed.replyMessage || "Agendamento registrado com sucesso!";
  } catch (err) {
    console.error('[AI Handler Error]', err);
    return "Olá! Tivemos uma pequena oscilação. Poderia me confirmar o serviço e o horário que deseja agendar?";
  }
}

module.exports = {
  processUserMessage: handleCustomerChat,
  handleCustomerChat,
};
