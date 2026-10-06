import { t, locale } from './i18n.js';
export const escape = value => String(value ?? '').replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
export const dayNames = () => ['Mon','Tue','Wed','Thu','Fri','Sat','Sun'].map(day=>t(day));
export const typeNames = {get image(){return t('Photo');},get video(){return t('Video');},get question(){return t('Question');},get news(){return t('News Post');}};
export const editable = draft => ['draft', 'scheduled', 'failed'].includes(draft?.status);
export const formatDate = value => value ? new Intl.DateTimeFormat(locale(), {month:'short',day:'numeric',hour:'numeric',minute:'2-digit',timeZone:'Asia/Jerusalem'}).format(new Date(value)) : '—';
export function zonedParts(date, timezone) {
  return Object.fromEntries(new Intl.DateTimeFormat('en-CA', {timeZone: timezone, year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(date).map(p => [p.type,p.value]));
}
export function inZone(value, zone) {
  const [date, time] = value.split('T');
  const [year,month,day] = date.split('-').map(Number);
  const [hour,minute] = time.split(':').map(Number);
  const target = Date.UTC(year,month-1,day,hour,minute);
  let result = target;
  for (let i=0;i<3;i++) {
    const p = zonedParts(new Date(result),zone);
    result += target - Date.UTC(+p.year,+p.month-1,+p.day,+p.hour,+p.minute);
  }
  // Pick the first occurrence of a repeated fall-back time, like Python fold=0.
  const before = new Date(result - 36 * 3600000);
  const beforeParts = zonedParts(before, zone);
  const beforeOffset = Date.UTC(+beforeParts.year,+beforeParts.month-1,+beforeParts.day,+beforeParts.hour,+beforeParts.minute) - before.getTime();
  const earlier = target - beforeOffset;
  if (earlier < result) {
    const p = zonedParts(new Date(earlier), zone);
    if (`${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}` === value) result = earlier;
  }
  const p = zonedParts(new Date(result),zone);
  if (`${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}` !== value) throw new Error(t("This local time does not exist because of a clock change. Choose another time."));
  return new Date(result);
}
export function nextOccurrence(schedule, now = new Date()) {
  const parts = zonedParts(now,schedule.timezone);
  const base = new Date(Date.UTC(+parts.year,+parts.month-1,+parts.day));
  for (let i=0;i<8;i++) {
    const date = new Date(base.getTime()+i*86400000);
    if (!schedule.days.includes((date.getUTCDay()+6)%7)) continue;
    try {
      const result = inZone(`${date.toISOString().slice(0,10)}T${schedule.time}`,schedule.timezone);
      if (result > now) return result;
    } catch { /* skip a nonexistent DST time */ }
  }
  return null;
}

// Keep the latest occurrence visible while it is waiting for a delayed worker.
export function latestOccurrence(schedule, now = new Date()) {
  if (!schedule.enabled) return null;
  const parts = zonedParts(now, schedule.timezone);
  const base = Date.UTC(+parts.year, +parts.month - 1, +parts.day);
  const starts = schedule.starts_at || schedule.created_at;
  for (let i = 0; i < 8; i++) {
    const date = new Date(base - i * 86400000);
    if (!schedule.days.includes((date.getUTCDay() + 6) % 7)) continue;
    const day = date.toISOString().slice(0, 10);
    try {
      const time = inZone(`${day}T${schedule.time}`, schedule.timezone);
      if (time <= now && (!starts || time >= new Date(starts)))
        return { date: time, slot: `${day}@${schedule.time}` };
    } catch { /* skip a nonexistent DST time */ }
  }
  return null;
}

export function scheduleRun(schedule, drafts = [], now = new Date()) {
  const latest = latestOccurrence(schedule, now);
  if (!latest) return null;
  if (latest.slot <= (schedule.last_slot || '')) {
    const draft = drafts.find(d => d.id === schedule.last_draft_id);
    return { ...latest, status: draft?.status === 'draft' && schedule.last_error ? 'failed' : draft?.status || schedule.last_status || 'running',
      error: draft?.error || schedule.last_error };
  }
  const age = now - latest.date;
  return { ...latest, status: age > 24 * 3600000 ? 'missed' : age > 30 * 60000 ? 'overdue' : 'waiting' };
}

export function dueTasks(state, now = new Date()) {
  const posts = state.drafts.filter(d => d.status === 'scheduled' && new Date(d.scheduled_at) <= now)
    .map(d => ({kind:'draft', id:d.id, name:d.source.name, type:d.type, mode:'publish', date:new Date(d.scheduled_at)}));
  const schedules = state.schedules.flatMap(s => {
    const run = scheduleRun(s, state.drafts, now);
    return run && ['waiting','overdue'].includes(run.status) && run.slot > (s.last_missed_slot || '')
      ? [{kind:'schedule', id:s.id, name:s.name, type:s.type, mode:s.mode, date:run.date, slot:run.slot}] : [];
  });
  return [...posts, ...schedules].sort((a,b) => a.date - b.date);
}
export const sourceUrl = value => {
  try { const u=new URL(value);return u.protocol==='https:' && ['drive.google.com','docs.google.com','www.facebook.com','facebook.com','github.com'].includes(u.hostname) ? u.href : ''; }
  catch { return ''; }
};
export const newsUrl = value => {
  try {
    const u = new URL(value);
    return u.protocol === 'https:' && !u.username && !u.password && (!u.port || u.port === '443')
      && u.hostname.includes('.') && !/^(?:127\.|10\.|192\.168\.|169\.254\.|0\.)/.test(u.hostname)
      && !/(?:\.local|\.localhost|\.internal)$/.test(u.hostname) ? u.href : '';
  } catch { return ''; }
};
