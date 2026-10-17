"""Tell the Telegram bot's chat how an approved command ended. Never fails the run."""
import os
from datetime import datetime
from zoneinfo import ZoneInfo

import requests

MESSAGES = {
    "en": {"draft": "Saved as a draft in Alfred Studio.", "scheduled": "Scheduled for {time}.",
           "published": "Published on Facebook: {url}", "processing": "Sent to Facebook. The video is still processing: {url}",
           "unscheduled": "Unscheduled. The post is back in your drafts.", "failed": "That did not work: {error}"},
    "he": {"draft": "נשמר כטיוטה ב-Alfred Studio.", "scheduled": "תוזמן ל-{time}.",
           "published": "פורסם בפייסבוק: {url}", "processing": "נשלח לפייסבוק. הסרטון עדיין בעיבוד: {url}",
           "unscheduled": "התזמון בוטל. הפוסט חזר לטיוטות.", "failed": "זה לא הצליח: {error}"},
}


def message(command, state, error=None):
    text = MESSAGES.get(command.get("notify_language"), MESSAGES["en"])
    if error:
        return text["failed"].format(error=error)
    if command.get("action") == "cancel_draft":
        return text["unscheduled"]
    draft_id = command.get("draft_id") or command["id"]
    draft = next((d for d in state["drafts"] if d["id"] == draft_id), None)
    if not draft:
        return text["failed"].format(error="The post could not be found. Check Alfred Studio.")
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
