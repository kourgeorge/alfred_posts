// Keep missed occurrences outside the bounded command log until resolved.
// Mirrors studio/missed.py.
import { LATE_LIMIT, recentSlots, zonedTime } from './scheduler.js';
import { UserError, isoUtc, parseIso, sha256Hex } from './util.js';

export const runId = async (scheduleId, slot) => (await sha256Hex(`${scheduleId}:${slot}`)).slice(0, 32);

export async function remember(state, schedule, slot, now) {
  const records = state.missed_runs ??= [];
  const key = await runId(schedule.id, slot);
  const existing = records.find(r => r.id === key);
  if (existing) return existing;
  const [day, time] = slot.split('@');
  const [year, month, date] = day.split('-').map(Number);
  const [hour, minute] = time.split(':').map(Number);
  // Python's fold=0 picks the earlier instant; a skipped time keeps the pre-change offset.
  const scheduled = zonedTime({ year, month, day: date, hour, minute, second: 0 }, schedule.timezone)
    ?? new Date(Date.UTC(year, month - 1, date, hour, minute));
  records.push({ id: key, schedule_id: schedule.id, slot, name: schedule.name, type: schedule.type,
    mode: schedule.mode, timezone: schedule.timezone, scheduled_at: isoUtc(scheduled),
    created_at: isoUtc(now), status: 'missed' });
  return records.at(-1);
}

export async function captureMissed(state, now, { onlySchedule = null, retiring = false } = {}) {
  const schedules = onlySchedule ? [onlySchedule] : state.schedules;
  // Import older receipts before their bounded log can roll over. Store a
  // snapshot, so editing or deleting a recurring rule cannot erase its backlog.
  for (const schedule of schedules) {
    const legacy = new Set(state.operations.filter(op => op.action === 'missed_schedule'
      && op.schedule_id === schedule.id && op.slot).map(op => op.slot));
    if (schedule.last_missed_slot) legacy.add(schedule.last_missed_slot);
    for (const slot of [...legacy].sort()) await remember(state, schedule, slot, now);
    if (schedule.last_status === 'failed' && schedule.last_slot
        && !state.drafts.some(d => d.id === schedule.last_draft_id)) {
      const failed = await remember(state, schedule, schedule.last_slot, now);
      Object.assign(failed, { status: 'failed', error: schedule.last_error ?? null });
    }
    const startsValue = schedule.starts_at || schedule.created_at;
    const starts = startsValue ? parseIso(startsValue)?.date : null;
    const daysBack = starts ? Math.max(7, Math.floor((now - starts) / 86400000) + 2) : 7;
    const slots = recentSlots(schedule, now, daysBack);
    const latestSlot = slots[0]?.[0] ?? null;
    const expired = slots.filter(([slot, target]) => (retiring || now - target > LATE_LIMIT || slot !== latestSlot)
      && slot > (schedule.last_slot ?? '') && slot > (schedule.last_missed_slot ?? ''));
    for (const [slot] of [...expired].reverse()) await remember(state, schedule, slot, now);
    if (expired.length) {
      const slot = expired[0][0];
      Object.assign(schedule, { last_missed_slot: slot, last_missed_at: isoUtc(now) });
      state.operations.unshift({
        id: `missed-${schedule.id}-${slot}`, action: 'missed_schedule', status: 'failed',
        created_at: isoUtc(now), finished_at: isoUtc(now), schedule_id: schedule.id, slot,
        error: `${schedule.name}: ${expired.length} unclaimed run(s) are saved in Needs attention for recovery.`,
      });
      state.operations = state.operations.slice(0, 150);
    }
  }
}

export function findMissed(state, key) {
  const item = (state.missed_runs ?? []).find(r => r.id === key);
  if (!item) throw new UserError('This missed run is not available. Refresh Activity and try again.');
  return item;
}
