import copy
from datetime import datetime, timezone
import unittest
from unittest.mock import patch
from types import SimpleNamespace

import content

from studio.media import MediaService, digest
from studio.scheduler import due_slot, parse_future, validate_schedule
from studio.service import Studio
from studio.store import MemoryStore


class FakeMedia:
    def __init__(self):
        self.posts = []
        self.fail = False
        self.changed = False
        self.ready = False

    def prepare(self, kind, used):
        return {"text": "Original caption", "source": {"key": f"{kind}-source", "name": "A source", "sha256": digest(b"original")}, "preview": "sample"}

    def download(self, draft):
        if self.changed:
            raise ValueError("Source changed")
        return b"original"

    def publish(self, draft, data):
        self.posts.append((copy.deepcopy(draft), data))
        if self.fail:
            raise TimeoutError("Ambiguous result")
        return {"id": "12345", "post_id": None if draft["type"] == "video" else "page_12345"}

    def video_status(self, video_id):
        return {"status": {"publishing_phase": {"publish_status": "published" if self.ready else "pending"}}, "permalink_url": f"/reel/{video_id}/"}


class StudioTest(unittest.TestCase):
    def setUp(self):
        self.store = MemoryStore()
        self.media = FakeMedia()
        self.app = Studio(self.store, lambda: self.media)

    def generate(self, kind="image", request_id="generate-001"):
        self.app.command({"action": "generate", "type": kind, "id": request_id})
        return self.store.state["drafts"][0]

    def publish(self, draft, request_id="publish-001", **extra):
        return self.app.command({"id": request_id, "action": "publish", "draft_id": draft["id"], "revision": draft["revision"], **extra})

    def test_preview_creates_draft_without_publishing_or_marking_history(self):
        d = self.generate()
        self.assertEqual(d["status"], "draft")
        self.assertEqual(self.media.posts, [])
        self.assertEqual(self.store.state["posted"]["image"], [])

    def test_all_three_formats_generate(self):
        for kind in ("image", "video", "question"):
            self.assertEqual(self.generate(kind, "generate-" + kind)["type"], kind)

    def test_publish_uses_edited_caption_and_same_source(self):
        d = self.generate()
        self.publish(d, text="My edited Hebrew caption שלום")
        sent, data = self.media.posts[0]
        self.assertEqual(sent["text"], "My edited Hebrew caption שלום")
        self.assertEqual(sent["source"], d["source"])
        self.assertEqual(data, b"original")
        self.assertEqual(self.store.state["posted"]["image"], ["image-source"])

    def test_replayed_request_does_not_publish_twice(self):
        d = self.generate()
        self.publish(d)
        self.publish(d)
        self.assertEqual(len(self.media.posts), 1)

    def test_new_request_cannot_republish_published_draft(self):
        d = self.generate()
        self.publish(d)
        with self.assertRaises(RuntimeError):
            self.publish(d, "publish-002")
        self.assertEqual(len(self.media.posts), 1)

    def test_stale_edit_is_rejected(self):
        d = self.generate()
        self.app.command({"id": "save-00001", "action": "save_draft", "draft_id": d["id"], "revision": 1, "text": "Changed"})
        with self.assertRaises(RuntimeError):
            self.publish(d)
        self.assertEqual(self.media.posts, [])

    def test_empty_caption_is_rejected(self):
        d = self.generate()
        with self.assertRaises(RuntimeError):
            self.publish(d, text="  ")
        self.assertEqual(self.media.posts, [])

    def test_timeout_is_uncertain_and_never_retried(self):
        d = self.generate()
        self.media.fail = True
        with self.assertRaises(RuntimeError):
            self.publish(d)
        self.assertEqual(self.store.state["drafts"][0]["status"], "uncertain")
        with self.assertRaises(RuntimeError):
            self.publish(self.store.state["drafts"][0], "retry-00001")
        self.assertEqual(len(self.media.posts), 1)

    def test_source_change_fails_before_facebook_call(self):
        d = self.generate()
        self.media.changed = True
        with self.assertRaises(RuntimeError):
            self.publish(d)
        self.assertEqual(self.media.posts, [])
        self.assertEqual(self.store.state["drafts"][0]["status"], "failed")

    def test_media_checksum_verification(self):
        service = MediaService(None)
        draft = {"type": "image", "source": {"id": "source", "sha256": digest(b"old")}}
        with patch("drive.download_drive_file", return_value=b"changed"):
            with self.assertRaisesRegex(ValueError, "changed after preview"):
                service.download(draft)

    def test_video_status_is_not_published_until_confirmed(self):
        d = self.generate("video")
        self.publish(d)
        self.assertEqual(self.store.state["drafts"][0]["status"], "processing")
        self.media.ready = True
        self.app.refresh_videos()
        self.assertEqual(self.store.state["drafts"][0]["status"], "published")
        self.assertEqual(self.store.state["drafts"][0]["facebook_url"], "https://www.facebook.com/reel/12345/")

    def test_one_time_schedule_survives_ticks_and_publishes_once(self):
        d = self.generate()
        self.app.command({"id": "schedule-001", "action": "schedule_draft", "draft_id": d["id"], "revision": 1,
                          "scheduled_at": "2099-01-05T07:00:00+00:00", "text": "Scheduled caption"})
        self.app.tick(datetime(2099, 1, 5, 7, 30, tzinfo=timezone.utc))
        self.app.tick(datetime(2099, 1, 5, 8, 0, tzinfo=timezone.utc))
        self.assertEqual(len(self.media.posts), 1)
        self.assertEqual(self.media.posts[0][0]["text"], "Scheduled caption")

    def test_cancel_schedule_returns_post_to_drafts(self):
        d = self.generate()
        self.app.command({"id": "schedule-001", "action": "schedule_draft", "draft_id": d["id"], "revision": 1, "scheduled_at": "2099-01-05T07:00:00+00:00"})
        self.app.command({"id": "cancel-00001", "action": "cancel_draft", "draft_id": d["id"], "revision": 2})
        self.app.tick(datetime(2099, 1, 5, 7, 30, tzinfo=timezone.utc))
        self.assertEqual(self.media.posts, [])
        self.assertEqual(self.store.state["drafts"][0]["status"], "draft")

    def test_saving_caption_preserves_scheduled_publication(self):
        d = self.generate()
        date = "2099-01-05T07:00:00+00:00"
        self.app.command({"id": "schedule-001", "action": "schedule_draft", "draft_id": d["id"], "revision": 1, "scheduled_at": date})
        self.app.command({"id": "save-edit-001", "action": "save_draft", "draft_id": d["id"], "revision": 2, "text": "Updated caption"})
        saved = self.store.state["drafts"][0]
        self.assertEqual((saved["status"], saved["scheduled_at"]), ("scheduled", date))
        self.app.tick(datetime(2099, 1, 5, 7, 30, tzinfo=timezone.utc))
        self.assertEqual(self.media.posts[0][0]["text"], "Updated caption")

    def test_recurring_schedule_only_claims_slot_once(self):
        self.store.state["schedules"] = [{"id": "schedule-one", "name": "Morning", "time": "09:00", "days": [0,1,2,3,4,5,6], "timezone": "Asia/Jerusalem", "type": "question", "mode": "publish", "enabled": True}]
        when = datetime(2026, 10, 2, 6, 10, tzinfo=timezone.utc)
        self.app.tick(when)
        self.app.tick(when)
        self.assertEqual(len(self.media.posts), 1)
        self.assertEqual(self.media.posts[0][0]["type"], "question")

    def test_draft_schedule_never_publishes(self):
        self.store.state["schedules"] = [{"id": "schedule-one", "name": "Morning", "time": "09:00", "days": [4], "timezone": "Asia/Jerusalem", "type": "video", "mode": "draft", "enabled": True}]
        self.app.tick(datetime(2026, 10, 2, 6, 10, tzinfo=timezone.utc))
        self.assertEqual(len(self.store.state["drafts"]), 1)
        self.assertEqual(self.media.posts, [])


class ScheduleTest(unittest.TestCase):
    def setUp(self):
        self.schedule = {"name": "Morning", "time": "09:00", "days": [0,1,2,3,4], "timezone": "Asia/Jerusalem", "type": "image", "mode": "draft", "enabled": True}

    def test_israel_summer_and_winter_offsets(self):
        self.assertIsNotNone(due_slot(self.schedule, datetime(2026, 10, 2, 6, 10, tzinfo=timezone.utc)))
        self.assertIsNone(due_slot(self.schedule, datetime(2026, 12, 2, 6, 10, tzinfo=timezone.utc)))
        self.assertIsNotNone(due_slot(self.schedule, datetime(2026, 12, 2, 7, 10, tzinfo=timezone.utc)))

    def test_weekend_disabled_and_late_runs(self):
        self.assertIsNone(due_slot(self.schedule, datetime(2026, 10, 3, 6, 10, tzinfo=timezone.utc)))
        self.assertIsNone(due_slot(self.schedule, datetime(2026, 10, 2, 8, 1, tzinfo=timezone.utc)))
        self.schedule["enabled"] = False
        self.assertIsNone(due_slot(self.schedule, datetime(2026, 10, 2, 6, 10, tzinfo=timezone.utc)))

    def test_new_schedule_does_not_publish_a_past_slot(self):
        self.schedule["starts_at"] = "2026-10-02T06:05:00+00:00"
        self.assertIsNone(due_slot(self.schedule, datetime(2026, 10, 2, 6, 10, tzinfo=timezone.utc)))

    def test_duplicate_date_slot(self):
        self.schedule["last_slot"] = "2026-10-02@09:00"
        self.assertIsNone(due_slot(self.schedule, datetime(2026, 10, 2, 6, 10, tzinfo=timezone.utc)))

    def test_late_night_slot_runs_after_midnight_on_the_original_weekday(self):
        self.schedule.update(time="23:55", days=[4])
        self.assertEqual(due_slot(self.schedule, datetime(2026, 10, 2, 21, 7, tzinfo=timezone.utc)), "2026-10-02@23:55")
        self.schedule["last_slot"] = "2026-10-02@23:55"
        self.assertIsNone(due_slot(self.schedule, datetime(2026, 10, 2, 21, 37, tzinfo=timezone.utc)))

    def test_invalid_weekdays_rejected(self):
        self.schedule["days"] = [True, 8]
        with self.assertRaises(ValueError):
            validate_schedule(self.schedule)

    def test_ambiguous_or_past_one_time_dates_rejected(self):
        for value in ["2020-01-01T09:00:00Z", "2099-01-01T09:00", "invalid"]:
            with self.subTest(value=value), self.assertRaises(ValueError):
                parse_future(value)


class QuestionContentTest(unittest.TestCase):
    def test_every_original_choice_is_preserved_without_model_rewriting(self):
        question = {"form_title": "Traffic signs", "question": {"text": "מה פירוש התמרור?"},
                    "answers": ["תשובה ראשונה.", "תשובה שנייה.", "תשובה שלישית.", "תשובה רביעית."]}
        config = SimpleNamespace(openai_model_question="test-model", timezone="Asia/Jerusalem")
        with patch("content._complete", return_value="בואו נתרגל יחד.") as complete:
            text = content.generate_question_post_text(config, question)
        self.assertIn(question["question"]["text"], text)
        for i, answer in enumerate(question["answers"], 1):
            self.assertIn(f"{i}. {answer}", text)
            self.assertEqual(text.count(answer), 1)
        # The generator never sees answer choices, so it cannot pick a solution.
        self.assertNotIn(question["answers"][0], complete.call_args.args[3])


if __name__ == "__main__":
    unittest.main()
