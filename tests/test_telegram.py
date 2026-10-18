from datetime import datetime, timezone
from unittest import TestCase
from unittest.mock import patch

import test_uploads
from test_uploads import UPLOAD_ID
from studio import telegram


class TelegramDraftTest(TestCase):
    setUp = test_uploads.UploadTest.setUp  # The same uploaded photo, without repeating the upload tests.

    def command(self, **extra):
        return {"id": "telegram-1111-2222", "action": "create_upload_draft", "type": "image", "upload_id": UPLOAD_ID,
                "text": "  Caption approved in Telegram  ", "notify_chat_id": "42", **extra}

    def test_approved_caption_is_saved_without_calling_the_ai_and_scheduled(self):
        with patch("content._complete") as complete:
            self.app.command(self.command(scheduled_at="2099-01-01T10:00:00Z", description="Parking practice"))
            self.app.command(self.command(scheduled_at="2099-01-01T10:00:00Z"))
        complete.assert_not_called()
        self.assertEqual(len(self.store.state["drafts"]), 1)
        draft = self.store.state["drafts"][0]
        self.assertEqual((draft["status"], draft["text"], draft["scheduled_at"]),
                         ("scheduled", "Caption approved in Telegram", "2099-01-01T10:00:00+00:00"))
        self.assertEqual((draft["source"]["origin"], draft["source"]["description"]), ("telegram", "Parking practice"))
        self.assertTrue(draft["preview"].startswith("data:image/jpeg;base64,"))
        self.assertIn("2099", telegram.message(self.command(), self.store.state))
        with patch("studio.media.facebook.post_photo_to_page", return_value={"id": "receipt"}) as publish:
            self.app.tick(datetime(2099, 1, 1, 10, 30, tzinfo=timezone.utc))
        publish.assert_called_once_with(self.config, self.data, "Caption approved in Telegram")

    def test_publish_now_and_draft(self):
        self.app.command(self.command(id="telegram-draft-0001"))
        self.assertEqual(self.store.state["drafts"][0]["status"], "draft")
        self.assertEqual(telegram.message(self.command(id="telegram-draft-0001"), self.store.state),
                         "Saved as a draft in Alfred Studio.")
        with patch("studio.media.facebook.post_photo_to_page", return_value={"id": "1_2"}):
            self.app.command(self.command(publish=True))
        draft = next(d for d in self.store.state["drafts"] if d["id"] == "telegram-1111-2222")
        self.assertEqual(draft["status"], "published")
        self.assertIn("facebook.com", telegram.message(self.command(), self.store.state))

    def test_invalid_requests_are_rejected_before_media_is_read(self):
        for extra in ({"type": "question"}, {"text": "  "}, {"text": "x" * 12001}, {"upload_id": "../state.json"},
                      {"scheduled_at": "2000-01-01T10:00:00Z"}, {"scheduled_at": "2099-01-01T10:00:00Z", "publish": True}):
            with self.subTest(extra=extra), self.assertRaises(RuntimeError):
                self.app.command(self.command(id=f"telegram-bad-{len(str(extra))}-{list(extra)[0]}", **extra))
        self.assertEqual(self.store.state["drafts"], [])

    def test_changed_upload_is_refused(self):
        self.store.files[f"uploads/{UPLOAD_ID}/part-00.bin"] = b"x" * len(self.data)
        with self.assertRaises(RuntimeError):
            self.app.command(self.command())
        self.assertEqual(self.store.state["drafts"], [])

    def test_messages_for_changes_approved_in_the_bot(self):
        self.app.command(self.command(scheduled_at="2099-01-01T10:00:00Z"))
        draft = self.store.state["drafts"][0]
        moved = {"id": "telegram-move-0001", "action": "schedule_draft", "draft_id": draft["id"], "revision": 1,
                 "scheduled_at": "2099-02-03T16:00:00Z", "notify_language": "he"}
        self.app.command(moved)
        self.assertEqual(telegram.message(moved, self.store.state), "תוזמן ל-03/02/2099 18:00.")
        self.app.command({"id": "telegram-save-0001", "action": "save_schedule", "schedule": {"name": "Morning tips", "type": "image",
                          "mode": "draft", "days": [0], "time": "09:00", "timezone": "Asia/Jerusalem"}})
        schedule = self.store.state["schedules"][0]
        cases = [({"action": "delete_draft", "draft_id": draft["id"]}, "The post was deleted."),
                 ({"id": "telegram-save-0001", "action": "save_schedule", "schedule": {"name": "Morning tips"}}, 'The schedule "Morning tips" was saved.'),
                 ({"action": "toggle_schedule", "schedule_id": schedule["id"], "enabled": False}, 'The schedule "Morning tips" is paused.'),
                 ({"action": "toggle_schedule", "schedule_id": schedule["id"], "enabled": True}, 'The schedule "Morning tips" is on again.'),
                 ({"action": "delete_schedule", "schedule_id": "gone"}, "The schedule was deleted."),
                 ({"action": "run_due"}, "The schedule check finished."),
                 ({"action": "recover_missed", "missed_id": "nope"}, "The post could not be found. Check Alfred Studio.")]
        for command, expected in cases:
            with self.subTest(command=command["action"]):
                self.assertEqual(telegram.message({"id": "telegram-x-0001", **command}, self.store.state), expected)

    def test_notification_reports_errors_and_never_breaks_the_run(self):
        with patch.dict("os.environ", {"TELEGRAM_BOT_TOKEN": "bot-token"}), \
                patch("studio.telegram.requests.post", side_effect=OSError("https://api.telegram.org/botbot-token")) as post, \
                patch("builtins.print") as printed:
            telegram.notify(self.command(notify_language="he"), self.store, "Facebook rejected the request")
        self.assertEqual(post.call_args.kwargs["json"], {"chat_id": "42", "text": "זה לא הצליח: Facebook rejected the request"})
        self.assertNotIn("bot-token", str(printed.call_args))
        with patch("studio.telegram.requests.post") as post:
            telegram.notify({"id": "x", "action": "publish"}, self.store)
        post.assert_not_called()
