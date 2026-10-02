export const escape = value => String(value ?? '').replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
export const dayNames = ['Mon','Tue','Wed','Thu','Fri','Sat','Sun'];
export const typeNames = {image: 'Photo', video: 'Video', question: 'Question'};
export const editable = draft => ['draft', 'scheduled', 'failed'].includes(draft?.status);
export const formatDate = value => value ? new Intl.DateTimeFormat('en', {month:'short',day:'numeric',hour:'numeric',minute:'2-digit',timeZone:'Asia/Jerusalem'}).format(new Date(value)) : '—';
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
  const p = zonedParts(new Date(result),zone);
  if (`${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}` !== value) throw new Error('This local time does not exist because of a clock change. Choose another time.');
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
export const sourceUrl = value => {
  try { const u=new URL(value);return u.protocol==='https:' && ['drive.google.com','docs.google.com','www.facebook.com','facebook.com','github.com'].includes(u.hostname) ? u.href : ''; }
  catch { return ''; }
};
