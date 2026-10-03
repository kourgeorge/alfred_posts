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

    def prepare(self, kind, used, prompt=None):
        self.last_prompt = prompt
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

    def test_saved_prompts_are_independent_and_only_change_future_generation(self):
        existing = copy.deepcopy(self.generate())
        for kind in ("image", "video", "question"):
            prompt = f"Custom {kind} instructions בעברית"
            self.app.command({"id": f"save-prompt-{kind}", "action": "save_prompt", "type": kind, "prompt": prompt, "revision": 0})
            self.generate(kind, "custom-" + kind)
            self.assertEqual(self.media.last_prompt, prompt)
        self.assertEqual(next(d for d in self.store.state["drafts"] if d["id"] == existing["id"]), existing)
        self.assertEqual(self.store.state["prompt_revisions"], {"image": 1, "video": 1, "question": 1})

    def test_stale_prompt_edit_is_rejected_without_overwriting_saved_instructions(self):
        self.app.command({"id": "prompt-save-1", "action": "save_prompt", "type": "image", "prompt": "First save", "revision": 0})
        with self.assertRaisesRegex(RuntimeError, "another session"):
            self.app.command({"id": "prompt-save-2", "action": "save_prompt", "type": "image", "prompt": "Stale save", "revision": 0})
        self.assertEqual(self.store.state["prompts"]["image"], "First save")

    def test_bad_prompt_settings_do_not_save_or_require_provider_credentials(self):
        app = Studio(self.store, lambda: self.fail("Saving prompts must not initialize provider clients"))
        for i, prompt in enumerate([None, 123, "  ", "x" * 8001]):
            with self.subTest(prompt_type=type(prompt)), self.assertRaises(RuntimeError):
                app.command({"id": f"invalid-prompt-{i}", "action": "save_prompt", "type": "image", "prompt": prompt, "revision": 0})
        self.assertNotIn("prompts", self.store.state)
        app.command({"id": "valid-prompt-1", "action": "save_prompt", "type": "video", "prompt": "  Write clearly.  ", "revision": 0})
        self.assertEqual(self.store.state["prompts"]["video"], "Write clearly.")

    def test_recurring_generation_uses_latest_saved_prompt(self):
        self.store.state["schedules"] = [{"id": "scheduled-prompt", "name": "Morning", "type": "image", "mode": "draft",
            "days": [4], "time": "09:00", "timezone": "Asia/Jerusalem", "enabled": True}]
        self.app.command({"id": "scheduled-prompt-save", "action": "save_prompt", "type": "image", "prompt": "Scheduled instructions", "revision": 0})
        self.app.tick(datetime(2026, 10, 2, 6, 37, tzinfo=timezone.utc))
        self.assertEqual(self.media.last_prompt, "Scheduled instructions")
        self.assertEqual(self.media.posts, [])

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

    def saturday_schedule(self, **extra):
        schedule = {"id": "saturday-1010", "name": "sat", "time": "10:10", "days": [5],
                    "timezone": "Asia/Jerusalem", "type": "image", "mode": "publish", "enabled": True,
                    "starts_at": "2026-10-03T07:06:46+00:00", **extra}
        self.store.state["schedules"] = [schedule]
        return schedule

    def test_delayed_github_check_catches_up_saturday_post_once(self):
        self.saturday_schedule()
        # The live incident: 10:10 Israel time, next check at 13:19.
        when = datetime(2026, 10, 3, 10, 19, tzinfo=timezone.utc)
        self.app.tick(when)
        self.app.tick(when)
        self.assertEqual(len(self.media.posts), 1)
        self.assertEqual(self.media.posts[0][0]["schedule_id"], "saturday-1010")
        self.assertEqual(self.store.state["schedules"][0]["last_status"], "published")
        self.assertIn("last_finished_at", self.store.state["scheduler"])

    def test_delayed_draft_only_schedule_still_requires_review(self):
        self.saturday_schedule(mode="draft")
        self.app.tick(datetime(2026, 10, 3, 10, 19, tzinfo=timezone.utc))
        self.assertEqual(len(self.store.state["drafts"]), 1)
        self.assertEqual(self.media.posts, [])
        self.assertEqual(self.store.state["schedules"][0]["last_status"], "draft")

    def test_expired_recurring_run_is_reported_once_without_publishing(self):
        self.saturday_schedule()
        when = datetime(2026, 10, 4, 7, 11, tzinfo=timezone.utc)
        self.app.tick(when)
        self.app.tick(when)
        self.assertEqual(self.media.posts, [])
        issues = [op for op in self.store.state["operations"] if op["action"] == "missed_schedule"]
        self.assertEqual(len(issues), 1)
        self.assertEqual(issues[0]["slot"], "2026-10-03@10:10")
        self.assertIn("24 hours", issues[0]["error"])

    def test_long_outage_only_publishes_latest_daily_slot(self):
        self.saturday_schedule(days=list(range(7)))
        when = datetime(2026, 10, 6, 7, 30, tzinfo=timezone.utc)
        self.app.tick(when)
        self.app.tick(when)
        self.assertEqual(len(self.media.posts), 1)
        schedule = self.store.state["schedules"][0]
        self.assertEqual(schedule["last_slot"], "2026-10-06@10:10")
        self.assertEqual(schedule["last_missed_slot"], "2026-10-05@10:10")

    def test_failed_catch_up_is_visible_and_ambiguous_posts_are_not_retried(self):
        self.saturday_schedule()
        self.media.fail = True
        when = datetime(2026, 10, 3, 10, 19, tzinfo=timezone.utc)
        self.app.tick(when)
        self.app.tick(when)
        self.assertEqual(len(self.media.posts), 1)
        self.assertEqual(self.store.state["schedules"][0]["last_status"], "uncertain")
        self.assertTrue(self.store.state["schedules"][0]["last_error"])

    def test_paused_or_resumed_schedule_does_not_catch_up_old_slots(self):
        for extra in [{"enabled": False}, {"starts_at": "2026-10-03T11:00:00+00:00"}]:
            with self.subTest(extra=extra):
                self.saturday_schedule(**extra)
                self.app.tick(datetime(2026, 10, 3, 11, 30, tzinfo=timezone.utc))
        self.assertEqual(self.media.posts, [])
        self.assertFalse(any(op["action"] == "missed_schedule" for op in self.store.state["operations"]))


class ScheduleTest(unittest.TestCase):
    def setUp(self):
        self.schedule = {"name": "Morning", "time": "09:00", "days": [0,1,2,3,4], "timezone": "Asia/Jerusalem", "type": "image", "mode": "draft", "enabled": True}

    def test_israel_summer_and_winter_offsets(self):
        self.schedule["days"] = [4]
        self.assertIsNotNone(due_slot(self.schedule, datetime(2026, 10, 2, 6, 10, tzinfo=timezone.utc)))
        self.schedule["days"] = [2]
        self.assertIsNone(due_slot(self.schedule, datetime(2026, 12, 2, 6, 10, tzinfo=timezone.utc)))
        self.assertIsNotNone(due_slot(self.schedule, datetime(2026, 12, 2, 7, 10, tzinfo=timezone.utc)))

    def test_weekend_disabled_and_late_runs(self):
        self.assertIsNone(due_slot(self.schedule, datetime(2026, 10, 3, 6, 10, tzinfo=timezone.utc)))
        self.assertEqual(due_slot(self.schedule, datetime(2026, 10, 2, 8, 1, tzinfo=timezone.utc)), "2026-10-02@09:00")
        self.schedule["enabled"] = False
        self.assertIsNone(due_slot(self.schedule, datetime(2026, 10, 2, 6, 10, tzinfo=timezone.utc)))

    def test_catch_up_window_is_inclusive_at_24_hours(self):
        self.schedule["days"] = [4]
        self.assertEqual(due_slot(self.schedule, datetime(2026, 10, 3, 6, 0, tzinfo=timezone.utc)), "2026-10-02@09:00")
        self.assertIsNone(due_slot(self.schedule, datetime(2026, 10, 3, 6, 0, 1, tzinfo=timezone.utc)))

    def test_out_of_order_worker_does_not_revisit_an_older_slot(self):
        self.schedule["last_slot"] = "2026-10-02@09:00"
        self.assertIsNone(due_slot(self.schedule, datetime(2026, 10, 1, 7, 0, tzinfo=timezone.utc)))

    def test_dst_gap_is_skipped_and_repeated_hour_runs_only_once(self):
        self.schedule.update(timezone="America/New_York", days=[6], time="02:30")
        self.assertIsNone(due_slot(self.schedule, datetime(2026, 3, 8, 8, 0, tzinfo=timezone.utc)))
        self.schedule["time"] = "01:30"
        self.assertEqual(due_slot(self.schedule, datetime(2026, 11, 1, 5, 35, tzinfo=timezone.utc)), "2026-11-01@01:30")
        self.schedule["last_slot"] = "2026-11-01@01:30"
        self.assertIsNone(due_slot(self.schedule, datetime(2026, 11, 1, 6, 35, tzinfo=timezone.utc)))

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
