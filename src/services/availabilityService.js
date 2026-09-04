// services/availabilityService.js
// Calcula horários disponíveis para um barbeiro em uma data, cruzando o
// horário de trabalho dele (working_hours) com os agendamentos que já existem.

const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false, autoRefreshToken: false }, realtime: { enabled: false } }
);

const SLOT_STEP_MINUTES = 15; // granularidade dos horários oferecidos ao cliente

function timeToMinutes(t) {
  const [h, m] = t.split(':').map(Number);
  return h * 60 + m;
}

function minutesToTime(mins) {
  const h = Math.floor(mins / 60).toString().padStart(2, '0');
  const m = (mins % 60).toString().padStart(2, '0');
  return `${h}:${m}`;
}

async function getAvailableSlots({ tenantId, barberId, serviceId, date }) {
  // date esperado no formato 'YYYY-MM-DD'
  const dayOfWeek = new Date(`${date}T12:00:00`).getDay(); // meio-dia evita bug de fuso horário

  const { data: service, error: serviceErr } = await supabase
    .from('services')
    .select('duration_minutes')
    .eq('id', serviceId)
    .eq('tenant_id', tenantId)
    .single();
  if (serviceErr || !service) throw new Error('Serviço não encontrado.');
  const duration = service.duration_minutes;

  const { data: hours, error: hoursErr } = await supabase
    .from('working_hours')
    .select('*')
    .eq('barber_id', barberId)
    .eq('day_of_week', dayOfWeek)
    .single();
  // sem linha configurada pra esse dia, ou dia marcado como fechado = sem horários
  if (hoursErr || !hours || !hours.is_open) return [];

  const dayStart = timeToMinutes(hours.open_time);
  const dayEnd = timeToMinutes(hours.close_time);
  const lunchStart = hours.lunch_start ? timeToMinutes(hours.lunch_start) : null;
  const lunchEnd = hours.lunch_end ? timeToMinutes(hours.lunch_end) : null;

  const { data: existing, error: apptErr } = await supabase
    .from('appointments')
    .select('start_time, end_time')
    .eq('barber_id', barberId)
    .neq('status', 'CANCELLED')
    .gte('start_time', `${date}T00:00:00`)
    .lte('start_time', `${date}T23:59:59`);
  if (apptErr) throw apptErr;

  const busyRanges = (existing || []).map((a) => ({
    start: new Date(a.start_time),
    end: new Date(a.end_time),
  }));

  const now = new Date();
  const slots = [];

  for (let slotStart = dayStart; slotStart + duration <= dayEnd; slotStart += SLOT_STEP_MINUTES) {
    const slotEnd = slotStart + duration;

    if (lunchStart !== null && lunchEnd !== null) {
      const overlapsLunch = slotStart < lunchEnd && slotEnd > lunchStart;
      if (overlapsLunch) continue;
    }

    const slotStartDate = new Date(`${date}T${minutesToTime(slotStart)}:00`);
    const slotEndDate = new Date(`${date}T${minutesToTime(slotEnd)}:00`);

    if (slotStartDate < now) continue; // não oferece horário no passado

    const overlapsAppointment = busyRanges.some(
      (b) => slotStartDate < b.end && slotEndDate > b.start
    );
    if (overlapsAppointment) continue;

    slots.push(minutesToTime(slotStart));
  }

  return slots;
}

module.exports = { getAvailableSlots };
