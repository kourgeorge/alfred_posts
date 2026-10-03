"""Keep missed occurrences outside the bounded command log until resolved."""
import hashlib
from datetime import datetime, timezone
from zoneinfo import ZoneInfo

from studio.scheduler import LATE_LIMIT, recent_slots


def run_id(schedule_id, slot):
    return hashlib.sha256(f"{schedule_id}:{slot}".encode()).hexdigest()[:32]


def remember(state, schedule, slot, now):
    records = state.setdefault("missed_runs", [])
    key = run_id(schedule["id"], slot)
    existing = next((r for r in records if r["id"] == key), None)
    if existing:
        return existing
    day, time = slot.split("@")
    date = datetime.fromisoformat(f"{day}T{time}").replace(tzinfo=ZoneInfo(schedule["timezone"]), fold=0)
    records.append({"id": key, "schedule_id": schedule["id"], "slot": slot,
                    "name": schedule["name"], "type": schedule["type"], "mode": schedule["mode"],
                    "timezone": schedule["timezone"], "scheduled_at": date.astimezone(timezone.utc).isoformat(),
                    "created_at": now.isoformat(), "status": "missed"})
    return records[-1]


def capture_missed(state, now=None, only_schedule=None, retiring=False):
    now = now or datetime.now(timezone.utc)
    schedules = [only_schedule] if only_schedule else state["schedules"]
    # Import older receipts before their bounded log can roll over. Store a
    # snapshot, so editing or deleting a recurring rule cannot erase its backlog.
    for schedule in schedules:
        legacy = {op["slot"] for op in state["operations"] if op.get("action") == "missed_schedule"
                  and op.get("schedule_id") == schedule["id"] and op.get("slot")}
        if schedule.get("last_missed_slot"):
            legacy.add(schedule["last_missed_slot"])
        for slot in sorted(legacy):
            remember(state, schedule, slot, now)
        if (schedule.get("last_status") == "failed" and schedule.get("last_slot")
                and not any(d["id"] == schedule.get("last_draft_id") for d in state["drafts"])):
            failed = remember(state, schedule, schedule["last_slot"], now)
            failed.update(status="failed", error=schedule.get("last_error"))
        starts = schedule.get("starts_at") or schedule.get("created_at")
        days_back = max(7, (now - datetime.fromisoformat(starts)).days + 2) if starts else 7
        slots = list(recent_slots(schedule, now, days_back))
        latest_slot = slots[0][0] if slots else None
        expired = [(slot, target) for slot, target in slots
                   if (retiring or now - target > LATE_LIMIT or slot != latest_slot)
                   and slot > schedule.get("last_slot", "")
                   and slot > schedule.get("last_missed_slot", "")]
        for slot, _ in reversed(expired):
            remember(state, schedule, slot, now)
        if expired:
            slot = expired[0][0]
            schedule.update(last_missed_slot=slot, last_missed_at=now.isoformat())
            state["operations"].insert(0, {
                "id": f"missed-{schedule['id']}-{slot}", "action": "missed_schedule", "status": "failed",
                "created_at": now.isoformat(), "finished_at": now.isoformat(),
                "schedule_id": schedule["id"], "slot": slot,
                "error": f"{schedule['name']}: {len(expired)} unclaimed run(s) are saved in Needs attention for recovery.",
            })
            state["operations"] = state["operations"][:150]


def find_missed(state, key):
    item = next((r for r in state.get("missed_runs", []) if r["id"] == key), None)
    if not item:
        raise ValueError("This missed run is not available. Refresh Activity and try again.")
    return item
