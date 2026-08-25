const cron = require('node-cron');
const { createClient } = require('@supabase/supabase-js');
const { sessions } = require('./whatsappService');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } }
);

function initReminderCron() {
  // Executa todo minuto
  cron.schedule('* * * * *', async () => {
    try {
      const now = new Date();
      // Janela de busca: agendamentos entre 55 e 65 minutos a partir de agora
      const windowStart = new Date(now.getTime() + 55 * 60 * 1000).toISOString();
      const windowEnd = new Date(now.getTime() + 65 * 60 * 1000).toISOString();

      const { data: upcomingAppts, error } = await supabase
        .from('appointments')
        .select('*')
        .eq('status', 'confirmed')
        .is('reminder_sent', null)
        .gte('start_time', windowStart)
        .lte('start_time', windowEnd);

      if (error || !upcomingAppts || upcomingAppts.length === 0) {
        return;
      }

      for (const appt of upcomingAppts) {
        const clientSession = sessions[appt.tenant_id];
        
        if (clientSession && clientSession.status === 'connected') {
          // Formata o número do cliente para o padrão do WhatsApp Web
          let cleanPhone = String(appt.customer_phone).replace(/\D/g, '');
          if (!cleanPhone.includes('@c.us')) {
            cleanPhone = `${cleanPhone}@c.us`;
          }

          const horaFormatada = new Date(appt.start_time).toLocaleTimeString('pt-BR', {
            hour: '2-digit',
            minute: '2-digit',
            timeZone: 'America/Sao_Paulo'
          });

          const msg = `Olá, ${appt.customer_name}! ✂️\n\nPassando para lembrar que o seu horário para *${appt.service_name || 'Corte'}* está marcado para hoje às *${horaFormatada}*.\n\nContamos com a sua presença! Se precisar remarcar ou cancelar, é só me avisar por aqui.`;

          try {
            await clientSession.client.sendMessage(cleanPhone, msg);
            console.log(`[Lembrete] Enviado com sucesso para ${appt.customer_name} (${cleanPhone})`);

            // Marca como enviado no banco para não duplicar
            await supabase
              .from('appointments')
              .update({ reminder_sent: true })
              .eq('id', appt.id);
          } catch (sendErr) {
            console.error(`[Lembrete] Erro ao enviar para ${cleanPhone}:`, sendErr.message);
          }
        }
      }
    } catch (err) {
      console.error('[Lembrete Cron] Erro na execução:', err.message);
    }
  });

  console.log('⏰ Rotina de Lembretes Automáticos (Cron Job) iniciada.');
}

module.exports = { initReminderCron };
