import base64
import hashlib
import io
import json
import os
from datetime import datetime, timezone
from types import SimpleNamespace
from unittest import TestCase
from unittest.mock import patch

from PIL import Image

from config import Config
from studio.media import MediaService
from studio.service import Studio
from studio.store import GitHubStore, MemoryStore
from studio.uploads import CHUNK_SIZE, Uploads, validate_manifest

UPLOAD_ID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"


class FileStore(MemoryStore):
    def __init__(self):
        super().__init__()
        self.files = {}

    def read_file(self, path, limit):
        if path not in self.files:
            raise ValueError("The uploaded file is incomplete.")
        data = self.files[path]
        if len(data) > limit:
            raise ValueError("The uploaded file is too large.")
        return data

    def upload(self, data, kind="image", mime="image/png", name="lesson.png"):
        manifest = {"id": UPLOAD_ID, "name": name, "type": kind, "mime": mime, "size": len(data),
                    "parts": (len(data) + CHUNK_SIZE - 1) // CHUNK_SIZE, "sha256": hashlib.sha256(data).hexdigest()}
        self.files[f"uploads/{UPLOAD_ID}/manifest.json"] = json.dumps(manifest).encode()
        for i in range(manifest["parts"]):
            self.files[f"uploads/{UPLOAD_ID}/part-{i:02d}.bin"] = data[i * CHUNK_SIZE:(i + 1) * CHUNK_SIZE]
        return manifest


class UploadTest(TestCase):
    def setUp(self):
        image = io.BytesIO()
        Image.new("RGB", (32, 20), (85, 130, 105)).save(image, format="PNG")
        self.data = image.getvalue()
        self.store = FileStore()
        self.store.upload(self.data)
        self.config = SimpleNamespace(openai_api_key="test-key", openai_model_image="photo-model",
            openai_model_video="video-model", openai_model_question="question-model", timezone="Asia/Jerusalem")
        self.media = MediaService(self.config, uploads=self.store)
        self.app = Studio(self.store, lambda:self.media)
        self.description = "מתרגלים חניה במקביל עם תלמיד מתחיל"
        self.generate = {"id":"upload-generation-001", "action":"generate_upload", "type":"image",
                         "upload_id":UPLOAD_ID, "description":self.description}

    def test_description_only_reaches_ai_and_scheduled_post_uses_original_media_and_edited_caption(self):
        self.store.state["prompts"] = {"image":"My saved photo instructions"}
        self.generate["caption_style"] = "funny"
        with patch("content.OpenAI") as client, patch("studio.media.drive.download_drive_file") as drive:
            client.return_value.chat.completions.create.return_value = SimpleNamespace(
                choices=[SimpleNamespace(message=SimpleNamespace(content="Generated caption"))])
            self.app.command(self.generate)
            self.app.command(self.generate)
        call = client.return_value.chat.completions.create.call_args.kwargs
        self.assertTrue(all(isinstance(m["content"], str) for m in call["messages"]))
        self.assertIn(self.description, call["messages"][1]["content"])
        self.assertTrue(call["messages"][0]["content"].startswith("My saved photo instructions"))
        self.assertIn("Caption style for this draft: Funny.", call["messages"][0]["content"])
        self.assertIn("כללי דיוק מחייבים", call["messages"][0]["content"])
        self.assertEqual(self.store.state["prompts"], {"image": "My saved photo instructions"})
        self.assertNotIn("lesson.png", call["messages"][1]["content"])
        self.assertNotIn(base64.b64encode(self.data).decode(), json.dumps(call))
        self.assertEqual(client.return_value.chat.completions.create.call_count, 1)
        drive.assert_not_called()
        draft = self.store.state["drafts"][0]
        self.assertEqual(draft["status"], "draft")
        self.assertEqual(draft["caption_style"], "funny")
        self.assertTrue(draft["preview"].startswith("data:image/jpeg;base64,"))
        self.assertEqual(draft["source"]["description"], self.description)
        self.app.command({"id":"upload-schedule-001", "action":"schedule_draft", "draft_id":draft["id"],
                          "revision":1, "text":"My reviewed caption", "scheduled_at":"2099-01-01T10:00:00Z"})
        with patch("studio.media.facebook.post_photo_to_page", return_value={"id":"receipt"}) as publish:
            self.app.tick(datetime(2099, 1, 1, 10, 30, tzinfo=timezone.utc))
            self.app.tick(datetime(2099, 1, 1, 11, tzinfo=timezone.utc))
        publish.assert_called_once_with(self.config, self.data, "My reviewed caption")
        self.assertEqual(self.store.state["drafts"][0]["status"], "published")
        self.assertEqual(self.store.state["drafts"][0]["caption_style"], "funny")

    def test_video_uses_video_prompt_without_sending_frames_or_audio(self):
        video = b"\x00\x00\x00\x20ftypisom" + b"\x00" * 80
        self.store.upload(video, "video", "video/mp4", "lesson.mp4")
        with patch("content._complete", return_value="Video caption") as complete:
            prepared = self.media.prepare_upload("video", UPLOAD_ID, self.description, prompt="Video style")
        self.assertEqual(complete.call_args.args[1], "video-model")
        self.assertTrue(complete.call_args.args[2].startswith("Video style"))
        self.assertIn(self.description, complete.call_args.args[3])
        self.assertIsNone(prepared["preview"])
        self.assertEqual(self.media.download({"type":"video",**prepared}),video)

    def test_incomplete_corrupt_or_disguised_upload_cannot_generate_or_publish(self):
        with patch("content._complete", return_value="Caption"):
            self.app.command(self.generate)
        draft = self.store.state["drafts"][0]
        self.store.files[f"uploads/{UPLOAD_ID}/part-00.bin"] = b"x" * len(self.data)
        with patch("studio.media.facebook.post_photo_to_page") as publish:
            with self.assertRaises(RuntimeError):
                self.app.command({"id":"upload-corrupt-001", "action":"publish", "draft_id":draft["id"], "revision":1})
        publish.assert_not_called()
        self.assertEqual(self.store.state["drafts"][0]["status"], "failed")
        self.store.upload(b"not an image")
        with patch("content._complete") as complete, self.assertRaises(ValueError):
            self.media.prepare_upload("image", UPLOAD_ID, self.description)
        complete.assert_not_called()
        del self.store.files[f"uploads/{UPLOAD_ID}/part-00.bin"]
        with self.assertRaises(ValueError):
            Uploads(self.store).read(UPLOAD_ID)

    def test_required_description_and_format_are_checked_before_ai(self):
        with patch("content._complete") as complete:
            for description in (None, "", "   ", "x" * 2001):
                with self.subTest(description=type(description).__name__), self.assertRaises(ValueError):
                    self.media.prepare_upload("image", UPLOAD_ID, description)
            with self.assertRaises(ValueError):
                self.media.prepare_upload("video", UPLOAD_ID, "Wrong format")
        complete.assert_not_called()

    def test_parts_are_reassembled_and_traversal_or_oversized_manifests_are_rejected(self):
        data = b"a" * CHUNK_SIZE + b"last part"
        manifest = self.store.upload(data)
        self.assertEqual(Uploads(self.store).read(UPLOAD_ID)[1], data)
        for invalid in ({"size":51*1024*1024}, {"name":"../test.png"}, {"parts":26}, {"mime":"image/svg+xml"}):
            with self.assertRaises(ValueError):
                validate_manifest({**manifest,**invalid}, UPLOAD_ID)
        with self.assertRaises(ValueError):
            Uploads(self.store).read("../../state.json")

    def test_uploaded_workflow_can_load_configuration_without_drive_credentials(self):
        with patch.dict(os.environ,{"OPENAI_API_KEY":"key", "FB_PAGE_ID":"page", "FB_PAGE_ACCESS_TOKEN":"token"}, clear=True), patch("config.load_dotenv"):
            self.assertIsNone(Config.from_env(require_google=False).google_service_account_file)

    def test_github_reader_handles_large_part_blob_fallback(self):
        def response(value):
            return SimpleNamespace(status_code=200, json=lambda:value, raise_for_status=lambda:None)
        entry = {"size":len(self.data), "encoding":"none", "sha":"blob-sha"}
        store = GitHubStore.__new__(GitHubStore)
        with patch.object(store, "api", side_effect=[response(entry),response({"content":base64.b64encode(self.data).decode()})]) as api:
            self.assertEqual(store.read_file(f"uploads/{UPLOAD_ID}/part-00.bin",CHUNK_SIZE),self.data)
        self.assertEqual(api.call_args.args,("GET","/git/blobs/blob-sha"))
