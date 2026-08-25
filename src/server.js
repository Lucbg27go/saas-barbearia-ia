const cron = require('node-cron');
const { createClient } = require('@supabase/supabase-js');
const { sessions } = require('./whatsappClient');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } }
);

function initReminderCron() {
  cron.schedule('* * * * *', async () => {
    const now = new Date();
    const inTwoHours = new Date(now.getTime() + 2 * 60 * 60 * 1000);

    const { data: appointments } = await supabase
      .from('appointments')
      .select('*, services(*)')
      .eq('reminder_sent', false)
      .lte('start_time', inTwoHours.toISOString())
      .gt('start_time', now.toISOString());

    if (!appointments || appointments.length === 0) return;

    for (const appt of appointments) {
      const session = sessions.get(appt.tenant_id);
      if (session && session.status === 'connected') {
        const msg = `Olá! Lembramos do seu agendamento hoje às ${new Date(appt.start_time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}.`;
        try {
          await session.client.sendMessage(appt.customer_phone, msg);
          await supabase.from('appointments').update({ reminder_sent: true }).eq('id', appt.id);
        } catch (err) {
          console.error('[Reminder Error]', err);
        }
      }
    }
  });
}

module.exports = { initReminderCron };
