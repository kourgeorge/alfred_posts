import { inZone, nextOccurrence, scheduleRun } from './utils.js';

export function activityItems(state, now = new Date()) {
  const records = new Map();
  const postItem = draft => {
    const status = draft.status === 'scheduled' && now - new Date(draft.scheduled_at) > 30 * 60000
      ? 'overdue' : draft.status;
    return {kind:'post',id:draft.id,draft,status,
      date:draft.published_at || draft.scheduled_at || draft.created_at,
      attention:!['published','scheduled'].includes(status)};
  };
  const drafts = new Map(state.drafts.map(d => [d.id, d]));
  const recovered = new Set();
  const missed = new Map((state.missed_runs || []).map(r => [`${r.schedule_id}:${r.slot}`, {...r}]));
  // Older installations only kept missed receipts in the operation log.
  for (const op of state.operations) {
    if (op.action !== 'missed_schedule' || !op.slot || !op.schedule_id) continue;
    const s = state.schedules.find(s => s.id === op.schedule_id);
    if (!s || missed.has(`${s.id}:${op.slot}`)) continue;
    missed.set(`${s.id}:${op.slot}`, {id:null,schedule_id:s.id,name:s.name,type:s.type,mode:s.mode,
      timezone:s.timezone,slot:op.slot,scheduled_at:inZone(op.slot.replace('@','T'),s.timezone).toISOString(),status:'missed'});
  }
  for (const run of missed.values()) {
    const draft = drafts.get(run.draft_id || run.id);
    if (draft) {
      recovered.add(`${run.schedule_id}:${run.slot}`);
      if (draft.status === 'deleted') continue;
      records.set(`post:${draft.id}`, postItem(draft));
    } else {
      records.set(`schedule:${run.schedule_id}:${run.slot}`, {kind:'task',id:`missed:${run.schedule_id}:${run.slot}`,
        missedId:run.id,scheduleId:run.schedule_id,slot:run.slot,name:run.name,type:run.type,mode:run.mode,
        status:run.status==='failed'?'failed':'missed',error:run.error,date:run.scheduled_at,attention:true});
    }
  }
  for (const draft of state.drafts) {
    if (['draft','deleted'].includes(draft.status)) continue;
    records.set(`post:${draft.id}`, postItem(draft));
  }
  for (const schedule of state.schedules.filter(s => s.enabled)) {
    const run = scheduleRun(schedule,state.drafts,now);
    const pending = run && ['waiting','overdue','missed'].includes(run.status) && !recovered.has(`${schedule.id}:${run.slot}`);
    const date = pending ? run.date : nextOccurrence(schedule,now);
    const key = pending ? `schedule:${schedule.id}:${run.slot}` : `next:${schedule.id}`;
    if (date && !records.has(key)) records.set(key, {kind:'task',id:key,scheduleId:schedule.id,
      slot:pending?run.slot:null,name:schedule.name,type:schedule.type,mode:schedule.mode,
      status:pending?run.status:'scheduled',date,attention:Boolean(pending&&['overdue','missed'].includes(run.status))});
  }
  return [...records.values()].sort((a,b) => new Date(b.date) - new Date(a.date));
}

export function filterActivity(items, filter) {
  if (filter === 'published') return items.filter(item => item.status === 'published');
  if (filter === 'attention') return items.filter(item => item.attention);
  if (filter === 'scheduled') return items.filter(item => ['scheduled','waiting','overdue'].includes(item.status));
  return items;
}
