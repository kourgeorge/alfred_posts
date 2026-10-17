// Timezone-aware schedules with explicit detection of missed occurrences.
// Mirrors studio/scheduler.py, including its daylight-saving rules.
import { UserError, get, isInt, isoUtc, parseIso, pyLen, pyStr, pyStrip } from './util.js';

export const TYPES = ['image', 'video', 'question'];
export const LATE_LIMIT = 24 * 60 * 60 * 1000;
const DAY = 24 * 60 * 60 * 1000;
const formatters = new Map();

function formatter(zone) {
  if (!formatters.has(zone)) formatters.set(zone, new Intl.DateTimeFormat('en-US', {
    timeZone: zone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }));
  return formatters.get(zone);
}

/** Wall-clock fields of an instant in an IANA zone. */
export function wallClock(date, zone) {
  const parts = Object.fromEntries(formatter(zone).formatToParts(date).map(p => [p.type, p.value]));
  return { year: +parts.year, month: +parts.month, day: +parts.day, hour: +parts.hour, minute: +parts.minute, second: +parts.second };
}

const wallMs = w => Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second || 0);

/**
 * The UTC instant for a local wall time, like Python's replace(fold=0):
 * the earlier instant when the hour repeats, and null when the time is skipped.
 */
export function zonedTime(wall, zone) {
  const local = wallMs(wall);
  const offsets = new Set([-DAY, 0, DAY].map(shift => {
    const probe = new Date(local + shift);
    return wallMs(wallClock(probe, zone)) - probe.getTime();
  }));
  const matches = [...offsets].map(offset => local - offset)
    .filter(utc => wallMs(wallClock(new Date(utc), zone)) === local).sort((a, b) => a - b);
  return matches.length ? new Date(matches[0]) : null;
}

export function validZone(zone) {
  try { formatter(zone); return true; } catch { return false; }
}

const pad = n => String(n).padStart(2, '0');
const repr = value => `'${String(value).replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;

/** Python strptime(value, "%H:%M"): one or two digits each, with Python's own error text. */
function parseClock(value) {
  if (typeof value !== 'string') throw new TypeError('strptime() argument must be str');
  const match = value.match(/^(\d{1,2}):(\d{1,2})$/);
  if (!match || +match[1] > 23 || +match[2] > 59)
    throw new UserError(`time data ${repr(value)} does not match format '%H:%M'`);
  return [+match[1], +match[2]];
}

export function validateSchedule(value) {
  const name = pyStrip(pyStr(get(value, 'name', '')));
  if (!name || pyLen(name) > 100) throw new UserError('Give the schedule a name of 1–100 characters.');
  if (!TYPES.includes(value.type)) throw new UserError('Choose a photo, video, or question.');
  if (!['draft', 'publish'].includes(value.mode)) throw new UserError('Choose whether to prepare a draft or publish automatically.');
  const zone = get(value, 'timezone', 'Asia/Jerusalem');
  if (typeof zone !== 'string' || !validZone(zone)) throw new Error('Unknown time zone.');
  parseClock(get(value, 'time', ''));
  const days = get(value, 'days', []);
  if (!Array.isArray(days) || !days.length || days.some(d => !isInt(d) || d < 0 || d > 6))
    throw new UserError('Choose at least one weekday.');
  return { name, type: value.type, mode: value.mode, timezone: zone, time: value.time,
    days: [...new Set(days)].sort((a, b) => a - b), enabled: Boolean(get(value, 'enabled', true)) };
}

/** Eligible local occurrences, newest first, as [slot, utcDate]. */
export function recentSlots(schedule, now, daysBack = 7) {
  if (!schedule.enabled) return [];
  const zone = schedule.timezone;
  const today = wallClock(now, zone);
  const [hour, minute] = schedule.time.split(':').map(Number);
  const startsValue = schedule.starts_at || schedule.created_at;
  const starts = startsValue ? parseIso(startsValue)?.date : null;
  const slots = [];
  for (let daysAgo = 0; daysAgo <= daysBack; daysAgo++) {
    const day = new Date(Date.UTC(today.year, today.month - 1, today.day - daysAgo));
    const weekday = (day.getUTCDay() + 6) % 7; // Python weekday(): Monday is 0.
    if (!schedule.days.includes(weekday)) continue;
    const wall = { year: day.getUTCFullYear(), month: day.getUTCMonth() + 1, day: day.getUTCDate(), hour, minute, second: 0 };
    const target = zonedTime(wall, zone);
    if (!target) continue; // A nonexistent spring-forward time is skipped.
    if (starts && target < starts) continue;
    if (target <= now) slots.push([`${wall.year}-${pad(wall.month)}-${pad(wall.day)}@${schedule.time}`, target]);
  }
  return slots;
}

export function dueSlot(schedule, now) {
  const latest = recentSlots(schedule, now)[0];
  if (latest) {
    const [slot, target] = latest;
    if (now - target <= LATE_LIMIT && slot > (schedule.last_slot ?? '') && slot > (schedule.last_missed_slot ?? ''))
      return slot;
  }
  return null;
}

export function parseFuture(value, now) {
  const parsed = typeof value === 'string' ? parseIso(value.replace('Z', '+00:00')) : null;
  if (!parsed) throw new UserError('Choose a valid publication date and time.');
  if (!parsed.aware || parsed.date <= now) throw new UserError('Publication time must be in the future and include a timezone.');
  return isoUtc(parsed.date);
}
