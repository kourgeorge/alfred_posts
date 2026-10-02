"""Commands shared by manual dispatches and the scheduled worker.

Every state mutation uses compare-and-swap. A publication is reserved durably
before sending bytes to Facebook; an ambiguous result is never retried blindly.
"""
import copy
import hashlib
import re
from datetime import datetime, timezone

from studio.scheduler import TYPES, due_slot, parse_future, validate_schedule
from studio.store import now_iso


def safe_error(error):
    if isinstance(error, ValueError):
        return str(error)
    # The legacy Facebook wrapper embeds JSON in its error. Extract a numeric
    # provider code only, never persist the raw response or authenticated URLs.
    match = re.search(r'"code"\s*:\s*(\d+)', str(error))
    if match and "Facebook" in str(error):
        code = match.group(1)
        if code == "190":
            return "Facebook access token is invalid or expired. Update it in Settings."
        return f"Facebook rejected the request (code {code}). Check page permissions and credentials."
    return "The operation failed. Check credentials and the workflow log, then refresh the dashboard."


def find_draft(state, draft_id):
    draft = next((d for d in state["drafts"] if d["id"] == draft_id), None)
    if not draft:
        raise ValueError("This draft no longer exists.")
    return draft


def edit_draft(state, command):
    draft = find_draft(state, command["draft_id"])
    if draft["status"] not in ("draft", "scheduled", "failed"):
        raise ValueError("This post is already being published or has been published.")
    if command.get("revision") != draft["revision"]:
        raise ValueError("This draft changed in another session. Refresh before editing.")
    text = str(command.get("text", draft["text"])).strip()
    if not text or len(text) > 12000:
        raise ValueError("The caption must contain 1–12,000 characters.")
    draft.update(text=text, revision=draft["revision"] + 1, error=None)
    return draft


class Studio:
    def __init__(self, store, media_factory):
        self.store = store
        self.media_factory = media_factory
        self._media = None

    @property
    def media(self):
        if self._media is None:
            self._media = self.media_factory()
        return self._media

    def generate(self, post_type, draft_id, schedule_id=None):
        if post_type not in TYPES:
            raise ValueError("Unknown post type.")
        state, _ = self.store.read()
        existing = next((d for d in state["drafts"] if d["id"] == draft_id), None)
        if existing:
            return existing["id"]
        if sum(d["status"] in ("draft", "scheduled", "failed") for d in state["drafts"]) >= 30:
            raise ValueError("You have 30 unfinished drafts. Publish or delete some before creating more.")
        used = state["posted"].get(post_type, []) + [d["source"]["key"] for d in state["drafts"]
               if d["type"] == post_type and d["status"] != "deleted"]
        prepared = self.media.prepare(post_type, used)
        draft = {"id": draft_id, "type": post_type, "status": "draft", "revision": 1,
                 "created_at": now_iso(), "schedule_id": schedule_id, **prepared}

        def save(state):
            if not any(d["id"] == draft_id for d in state["drafts"]):
                state["drafts"].insert(0, draft)
            return draft_id
        return self.store.change(save)

    def publish(self, command):
        def reserve(state):
            draft = edit_draft(state, command)
            draft.update(status="preparing", scheduled_at=None, attempt_id=command["id"])
            return copy.deepcopy(draft)
        draft = self.store.change(reserve)
        # Download and verify before entering the potentially ambiguous API phase.
        try:
            data = self.media.download(draft)
        except Exception:
            self.store.change(lambda s: find_draft(s, draft["id"]).update(
                status="failed", error="Could not verify the source media. Check Drive/Forms and generate a fresh draft if it changed."))
            raise
        self.store.change(lambda s: find_draft(s, draft["id"]).update(status="publishing"))
        try:
            result = self.media.publish(draft, data)
            if not result.get("id"):
                raise RuntimeError("Facebook did not return a post ID.")
        except Exception:
            self.store.change(lambda s: find_draft(s, draft["id"]).update(
                status="uncertain", error="Facebook did not return a confirmed result. Check the Facebook page before taking any further action. This post will not be retried automatically."))
            raise
        # Include the receipt in the Actions log even if the state API later fails.
        print(f"Facebook receipt for draft {draft['id']}: {result}", flush=True)
        fb_id = str(result.get("post_id") or result["id"])
        url = f"https://www.facebook.com/{fb_id}"

        def finish(state):
            item = find_draft(state, draft["id"])
            item.update(status="processing" if item["type"] == "video" else "published",
                        published_at=now_iso(), facebook_id=str(result["id"]), facebook_url=url, preview=None)
            if item["source"]["key"] not in state["posted"][item["type"]]:
                state["posted"][item["type"]].append(item["source"]["key"])
        self.store.change(finish)
        if draft["type"] == "video":
            self.refresh_videos()
        return draft["id"]

    def refresh_videos(self):
        state, _ = self.store.read()
        for draft in [d for d in state["drafts"] if d["status"] == "processing"]:
            try:
                result = self.media.video_status(draft["facebook_id"])
                status = result.get("status", {})
                published = status.get("publishing_phase", {}).get("publish_status") == "published"
                failed = status.get("video_status") == "error"
                def update(state):
                    item = find_draft(state, draft["id"])
                    if published:
                        item["status"] = "published"
                    elif failed:
                        item.update(status="uncertain", error="Facebook reported a video processing error. Inspect the Facebook video before retrying.")
                    if result.get("permalink_url"):
                        link = result["permalink_url"]
                        item["facebook_url"] = link if link.startswith("https://www.facebook.com/") else "https://www.facebook.com/" + link.lstrip("/")
                self.store.change(update)
            except Exception:
                # The upload receipt is already saved. A later tick checks again.
                continue

    def execute(self, command):
        action = command.get("action")
        if action == "generate":
            return self.generate(command.get("type"), command["id"])
        if action == "publish":
            return self.publish(command)
        if action in ("save_draft", "schedule_draft", "cancel_draft"):
            date = parse_future(command.get("scheduled_at")) if action == "schedule_draft" else None
            def update(state):
                draft = edit_draft(state, command)
                if action == "schedule_draft":
                    draft.update(status="scheduled", scheduled_at=date)
                elif action == "cancel_draft" or draft["status"] == "failed":
                    draft.update(status="draft", scheduled_at=None)
                return draft["id"]
            return self.store.change(update)
        if action == "delete_draft":
            def delete(state):
                draft = edit_draft(state, command)
                draft.update(status="deleted", preview=None, scheduled_at=None)
            return self.store.change(delete)
        if action == "save_schedule":
            value = validate_schedule(command.get("schedule", {}))
            def save(state):
                schedule_id = command.get("schedule_id") or command["id"]
                existing = next((s for s in state["schedules"] if s["id"] == schedule_id), None)
                if existing:
                    existing.update(value, starts_at=now_iso())
                else:
                    if len(state["schedules"]) >= 12:
                        raise ValueError("A maximum of 12 recurring schedules is supported.")
                    state["schedules"].append({"id": schedule_id, "created_at": now_iso(), "starts_at": now_iso(), **value})
                return schedule_id
            return self.store.change(save)
        if action in ("toggle_schedule", "delete_schedule"):
            def change(state):
                item = next((s for s in state["schedules"] if s["id"] == command.get("schedule_id")), None)
                if not item:
                    raise ValueError("This schedule no longer exists.")
                if action == "delete_schedule":
                    state["schedules"].remove(item)
                else:
                    item["enabled"] = bool(command["enabled"])
                    item["starts_at"] = now_iso()
            return self.store.change(change)
        if action == "refresh":
            self.refresh_videos()
            return None
        raise ValueError("Unknown command.")

    def command(self, command):
        request_id = command.get("id", "")
        if not isinstance(request_id, str) or not 8 <= len(request_id) <= 150:
            raise ValueError("A unique request ID is required.")
        def claim(state):
            if any(op["id"] == request_id for op in state["operations"]):
                return False
            state["operations"].insert(0, {"id": request_id, "action": command.get("action"),
                                         "status": "running", "created_at": now_iso()})
            state["operations"] = state["operations"][:150]
            return True
        if not self.store.change(claim):
            return
        def finish(state, status, **extra):
            operation = next(op for op in state["operations"] if op["id"] == request_id)
            operation.update(status=status, finished_at=now_iso(), **extra)
        try:
            result = self.execute(command)
            self.store.change(lambda s: finish(s, "complete", result=result))
            return result
        except Exception as error:
            # Avoid persisting raw provider responses or URLs containing credentials.
            message = safe_error(error)
            self.store.change(lambda s: finish(s, "failed", error=message))
            print(f"Operation failed ({type(error).__name__}). Provider response omitted to protect credentials.", flush=True)
            raise RuntimeError(message) from None

    def tick(self, now=None):
        now = now or datetime.now(timezone.utc)
        self.refresh_videos()
        state, _ = self.store.read()
        for item in state["drafts"]:
            if item["status"] == "scheduled" and datetime.fromisoformat(item["scheduled_at"]) <= now:
                try:
                    self.command({"id": f"scheduled-{item['id']}-{item['revision']}", "action": "publish",
                                  "draft_id": item["id"], "revision": item["revision"]})
                except RuntimeError:
                    continue
        for schedule in state["schedules"]:
            slot = due_slot(schedule, now)
            if not slot:
                continue
            def reserve(state):
                latest = next((s for s in state["schedules"] if s["id"] == schedule["id"]), None)
                if not latest or due_slot(latest, now) != slot:
                    return False
                latest.update(last_slot=slot, last_run=now.isoformat())
                return copy.deepcopy(latest)
            reserved_schedule = self.store.change(reserve)
            if not reserved_schedule:
                continue
            schedule = reserved_schedule
            draft_id = hashlib.sha256(f"{schedule['id']}:{slot}".encode()).hexdigest()[:32]
            try:
                self.command({"id": draft_id, "action": "generate", "type": schedule["type"]})
                if schedule["mode"] == "publish":
                    self.command({"id": f"publish-{draft_id}", "action": "publish", "draft_id": draft_id, "revision": 1})
            except RuntimeError:
                continue
