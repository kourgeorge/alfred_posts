from dataclasses import fields, replace
import json
import os
import subprocess
import unittest
from unittest.mock import Mock, patch

import content
from config import Config
from studio import runner
from studio.models import apply_model, fetch_models
from studio.service import Studio
from studio.store import MemoryStore


class ModelsTest(unittest.TestCase):
    def setUp(self):
        self.store = MemoryStore()
        self.app = Studio(self.store, lambda: self.fail("Model settings must not initialize media or Facebook"))
        self.catalog = {"ids": ["gpt-4.1-mini", "gpt-5-mini"], "refreshed_at": "2026-10-06T00:00:00Z"}

    def test_refresh_replaces_catalog_and_failure_keeps_previous_catalog_and_model(self):
        self.store.state["ai_settings"] = {"model": "gpt-4.1-mini", "revision": 1}
        with patch("studio.service.fetch_models", return_value=self.catalog):
            self.app.execute({"action": "refresh_models"})
        with patch("studio.service.fetch_models", side_effect=ValueError("Could not load models")):
            with self.assertRaises(ValueError):
                self.app.execute({"action": "refresh_models"})
        self.assertEqual(self.store.state["model_catalog"], self.catalog)
        self.assertEqual(self.store.state["ai_settings"]["model"], "gpt-4.1-mini")

    def test_save_is_validated_versioned_and_leaves_existing_drafts_untouched(self):
        self.store.state["drafts"] = [{"id": "reviewed", "text": "Reviewed caption"}]
        command = {"action": "save_model", "model": "gpt-5-mini", "revision": 0}
        with patch("studio.models.fetch_models", return_value=self.catalog) as fetch:
            self.app.execute(command)
            fetch.assert_called_once_with("gpt-5-mini")
            with self.assertRaisesRegex(ValueError, "another session"):
                self.app.execute(command)
            fetch.assert_called_once()
        self.assertEqual(self.store.state["ai_settings"], {"model": "gpt-5-mini", "revision": 1})
        self.assertEqual(self.store.state["drafts"], [{"id": "reviewed", "text": "Reviewed caption"}])
        with patch("studio.models.fetch_models", side_effect=ValueError("Unavailable")):
            with self.assertRaises(ValueError):
                self.app.execute({**command, "model": "gpt-4.1-mini", "revision": 1})
        self.assertEqual(self.store.state["ai_settings"]["model"], "gpt-5-mini")

    def test_concurrent_model_update_is_not_overwritten_after_provider_check(self):
        def checked(model):
            self.store.state["ai_settings"] = {"model": "another-model", "revision": 1}
            return self.catalog
        with patch("studio.models.fetch_models", side_effect=checked):
            with self.assertRaisesRegex(ValueError, "another session"):
                self.app.execute({"action": "save_model", "model": "gpt-5-mini", "revision": 0})
        self.assertEqual(self.store.state["ai_settings"]["model"], "another-model")

    def test_subprocess_errors_never_copy_credentials_or_provider_output(self):
        for error in (subprocess.CalledProcessError(1, "node", stderr="private-api-key"),
                      subprocess.TimeoutExpired("node", 100, output="private-api-key"), OSError("private-api-key")):
            with patch("studio.models.subprocess.run", side_effect=error):
                with self.assertRaises(ValueError) as result:
                    fetch_models()
                self.assertNotIn("private-api-key", str(result.exception))

    def test_shared_model_reaches_all_caption_calls_and_legacy_config_is_preserved(self):
        config = Config(**{field.name: "unused" for field in fields(Config)})
        config = replace(config, timezone="UTC", openai_model_image="photo", openai_model_video="video", openai_model_question="question")
        self.assertIs(apply_model(config, {}), config)
        shared = apply_model(config, {"ai_settings": {"model": "gpt-5-mini"}})
        question = {"form_title": "Road signs", "question": {"text": "Question?"}, "answers": ["A", "B"]}
        with patch("content._complete", return_value="Caption") as complete:
            content.generate_image_post_text(shared, "id", "name")
            content.generate_video_post_text(shared, "name")
            content.generate_question_post_text(shared, question)
            for kind in ("image", "video"):
                content.generate_upload_post_text(shared, kind, "description")
        self.assertEqual([call.args[1] for call in complete.call_args_list], ["gpt-5-mini"] * 5)
        self.assertEqual(config.openai_model_video, "video")

    def test_worker_generation_loads_persisted_shared_model(self):
        self.store.initialize = lambda: None
        self.store.state["ai_settings"] = {"model": "gpt-5-mini", "revision": 1}
        config = Config(**{field.name: "unused" for field in fields(Config)})
        media = Mock()
        media.prepare.return_value = {"text": "Caption", "source": {"key": "source"}}
        with patch.dict(os.environ, {"STUDIO_COMMAND": json.dumps({"id": "model-test-draft", "action": "generate", "type": "news"})}, clear=True), \
                patch.object(runner, "GitHubStore", return_value=self.store), \
                patch.object(runner.Config, "from_env", return_value=config), \
                patch.object(runner, "MediaService", return_value=media) as factory:
            runner.main()
        shared = factory.call_args.args[0]
        self.assertEqual((shared.openai_model_image, shared.openai_model_video, shared.openai_model_question), ("gpt-5-mini",) * 3)
        self.assertEqual(self.store.state["drafts"][0]["text"], "Caption")
