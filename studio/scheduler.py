"""Timezone-aware schedules. Late recurring runs expire after two hours."""
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo

TYPES = ("image", "video", "question")


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


def due_slot(schedule, now=None):
    if not schedule["enabled"]:
        return None
    now = now or datetime.now(timezone.utc)
    local = now.astimezone(ZoneInfo(schedule["timezone"]))
    if local.weekday() not in schedule["days"]:
        return None
    hour, minute = map(int, schedule["time"].split(":"))
    target = local.replace(hour=hour, minute=minute, second=0, microsecond=0)
    if schedule.get("starts_at") and target.astimezone(timezone.utc) < datetime.fromisoformat(schedule["starts_at"]):
        return None
    age = now - target.astimezone(timezone.utc)
    slot = f"{local.date()}@{schedule['time']}"
    if timedelta(0) <= age <= timedelta(hours=2) and slot != schedule.get("last_slot"):
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
