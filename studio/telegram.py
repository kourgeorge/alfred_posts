"""Tell the Telegram bot's chat how an approved command ended. Never fails the run."""
import os
from datetime import datetime
from zoneinfo import ZoneInfo

import requests

MESSAGES = {
    "en": {"draft": "Saved as a draft in Alfred Studio.", "scheduled": "Scheduled for {time}.",
           "published": "Published on Facebook: {url}", "processing": "Sent to Facebook. The video is still processing: {url}",
           "unscheduled": "Unscheduled. The post is back in your drafts.", "failed": "That did not work: {error}",
           "deleted": "The post was deleted.", "saved_schedule": "The schedule \"{name}\" was saved.",
           "paused": "The schedule \"{name}\" is paused.", "resumed": "The schedule \"{name}\" is on again.",
           "deleted_schedule": "The schedule was deleted.", "ran_due": "The schedule check finished.",
           "missing": "The post could not be found. Check Alfred Studio."},
    "he": {"draft": "נשמר כטיוטה ב-Alfred Studio.", "scheduled": "תוזמן ל-{time}.",
           "published": "פורסם בפייסבוק: {url}", "processing": "נשלח לפייסבוק. הסרטון עדיין בעיבוד: {url}",
           "unscheduled": "התזמון בוטל. הפוסט חזר לטיוטות.", "failed": "זה לא הצליח: {error}",
           "deleted": "הפוסט נמחק.", "saved_schedule": "התזמון \"{name}\" נשמר.",
           "paused": "התזמון \"{name}\" הושהה.", "resumed": "התזמון \"{name}\" פועל שוב.",
           "deleted_schedule": "התזמון נמחק.", "ran_due": "בדיקת התזמונים הסתיימה.",
           "missing": "הפוסט לא נמצא. בדקו ב-Alfred Studio."},
}


def message(command, state, error=None):
    text = MESSAGES.get(command.get("notify_language"), MESSAGES["en"])
    action = command.get("action")
    if error:
        return text["failed"].format(error=error)
    if action == "cancel_draft":
        return text["unscheduled"]
    if action == "delete_draft":
        return text["deleted"]
    if action == "run_due":
        return text["ran_due"]
    if action == "delete_schedule":
        return text["deleted_schedule"]
    if action in ("save_schedule", "toggle_schedule"):
        schedule_id = command.get("schedule_id") or command["id"]
        schedule = next((s for s in state["schedules"] if s["id"] == schedule_id), None)
        name = schedule["name"] if schedule else command.get("schedule", {}).get("name", "")
        if action == "toggle_schedule":
            return text["resumed" if command.get("enabled") else "paused"].format(name=name)
        return text["saved_schedule"].format(name=name)
    if action == "recover_missed":
        missed = next((r for r in state.get("missed_runs", []) if r["id"] == command.get("missed_id")), None)
        draft_id = missed and (missed.get("draft_id") or missed["id"])
    else:
        draft_id = command.get("draft_id") or command["id"]
    draft = next((d for d in state["drafts"] if d["id"] == draft_id), None)
    if not draft:
        return text["missing"]
    if draft["status"] in ("published", "processing"):
        return text[draft["status"]].format(url=draft.get("facebook_url", ""))
    if draft["status"] == "scheduled":
        local = datetime.fromisoformat(draft["scheduled_at"]).astimezone(ZoneInfo("Asia/Jerusalem"))
        return text["scheduled"].format(time=local.strftime("%d/%m/%Y %H:%M"))
    return text["draft"]


def notify(command, store, error=None):
    chat_id, token = command.get("notify_chat_id"), os.environ.get("TELEGRAM_BOT_TOKEN")
    if not chat_id or not token:
        return
    try:
        state, _ = store.read()
        requests.post(f"https://api.telegram.org/bot{token}/sendMessage",
                      json={"chat_id": chat_id, "text": message(command, state, error)}, timeout=20)
    except Exception:
        # The URL contains the bot token: never print the error.
        print("Telegram notification failed.", flush=True)
