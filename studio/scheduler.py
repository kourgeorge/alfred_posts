"""Timezone-aware schedules with explicit detection of missed occurrences."""
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo

TYPES = ("image", "video", "question")
LATE_LIMIT = timedelta(hours=24)


def validate_schedule(value):
    name = str(value.get("name", "")).strip()
    if not name or len(name) > 100:
        raise ValueError("Give the schedule a name of 1–100 characters.")
    if value.get("type") not in TYPES:
        raise ValueError("Choose a photo, video, or question.")
    if value.get("mode") not in ("draft", "publish"):
        raise ValueError("Choose whether to prepare a draft or publish automatically.")
    ZoneInfo(value.get("timezone", "Asia/Jerusalem"))
    datetime.strptime(value.get("time", ""), "%H:%M")
    days = value.get("days", [])
    if not days or any(type(d) is not int or d not in range(7) for d in days):
        raise ValueError("Choose at least one weekday.")
    return {"name": name, "type": value["type"], "mode": value["mode"],
            "timezone": value.get("timezone", "Asia/Jerusalem"), "time": value["time"],
            "days": sorted(set(days)), "enabled": bool(value.get("enabled", True))}


def recent_slots(schedule, now=None, days_back=7):
    """Yield eligible local occurrences newest first within the requested history."""
    if not schedule["enabled"]:
        return
    now = now or datetime.now(timezone.utc)
    local = now.astimezone(ZoneInfo(schedule["timezone"]))
    hour, minute = map(int, schedule["time"].split(":"))
    for days_ago in range(days_back + 1):
        target = (local - timedelta(days=days_ago)).replace(hour=hour, minute=minute, second=0, microsecond=0, fold=0)
        if target.weekday() not in schedule["days"]:
            continue
        utc_target = target.astimezone(timezone.utc)
        # A nonexistent spring-forward time must not become a different local time.
        if utc_target.astimezone(local.tzinfo).replace(tzinfo=None) != target.replace(tzinfo=None):
            continue
        starts_at = schedule.get("starts_at") or schedule.get("created_at")
        if starts_at and utc_target < datetime.fromisoformat(starts_at):
            continue
        if utc_target <= now:
            yield f"{target.date()}@{schedule['time']}", utc_target


def due_slot(schedule, now=None):
    now = now or datetime.now(timezone.utc)
    latest = next(recent_slots(schedule, now), None)
    if latest:
        slot, target = latest
        if (now - target <= LATE_LIMIT and slot > schedule.get("last_slot", "")
                and slot > schedule.get("last_missed_slot", "")):
            return slot
    return None


def missed_slot(schedule, now=None):
    now = now or datetime.now(timezone.utc)
    for slot, target in recent_slots(schedule, now):
        if (now - target > LATE_LIMIT and slot > schedule.get("last_slot", "")
                and slot > schedule.get("last_missed_slot", "")):
            return slot
    return None


def parse_future(value, now=None):
    try:
        result = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except (ValueError, AttributeError):
        raise ValueError("Choose a valid publication date and time.") from None
    if result.tzinfo is None or result <= (now or datetime.now(timezone.utc)):
        raise ValueError("Publication time must be in the future and include a timezone.")
    return result.astimezone(timezone.utc).isoformat()
