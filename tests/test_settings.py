import json
import os
import unittest
from unittest.mock import patch

from studio import runner
from studio.settings import VISIBLE_SETTINGS, capture_settings
from studio.store import MemoryStore


class SettingsTest(unittest.TestCase):
    def test_snapshot_contains_only_non_secret_configuration(self):
        environ = {name: f"value-{name}" for name in VISIBLE_SETTINGS}
        environ.update(OPENAI_API_KEY="private-openai-key", FB_PAGE_ACCESS_TOKEN="private-facebook-token",
                       GOOGLE_SERVICE_ACCOUNT_JSON='{"private_key":"private-google-key"}',
                       GITHUB_TOKEN="private-github-token", GITHUB_RUN_NUMBER="12")
        state = {"prompts": {"image": "Keep my prompt"}}
        capture_settings(state, environ)
        self.assertEqual(state["connection_settings"]["values"], {name: environ[name] for name in VISIBLE_SETTINGS})
        self.assertEqual(state["prompts"]["image"], "Keep my prompt")
        for name in ("OPENAI_API_KEY", "FB_PAGE_ACCESS_TOKEN", "GOOGLE_SERVICE_ACCOUNT_JSON", "GITHUB_TOKEN"):
            self.assertNotIn(name, json.dumps(state))
            self.assertNotIn(environ[name], json.dumps(state))

    def test_old_job_cannot_replace_newer_values_and_blank_fields_are_current(self):
        state = {}
        capture_settings(state, {"GITHUB_RUN_NUMBER":"12", "FB_PAGE_ID":"123", "DRIVE_FOLDER_ID":"photo-folder"})
        capture_settings(state, {"GITHUB_RUN_NUMBER":"11", "FB_PAGE_ID":"456"})
        self.assertEqual(state["connection_settings"]["values"]["FB_PAGE_ID"], "123")
        capture_settings(state, {"GITHUB_RUN_NUMBER":"13", "FB_PAGE_ID":"789"})
        self.assertEqual(state["connection_settings"]["values"]["DRIVE_FOLDER_ID"], "")
        self.assertEqual(state["connection_settings"]["values"]["OPENAI_MODEL_VIDEO"], "gpt-4.1-mini")

    def test_refresh_records_saved_values_without_initializing_posting_services(self):
        store = MemoryStore()
        store.initialize = lambda: None
        environ = {"STUDIO_COMMAND":json.dumps({"id":"settings-refresh-001", "action":"refresh"}),
                   "FB_PAGE_ID":"123456", "OPENAI_MODEL":"example-model", "OPENAI_API_KEY":"private-key"}
        with patch.dict(os.environ, environ, clear=True), patch.object(runner, "GitHubStore", return_value=store), \
                patch.object(runner, "MediaService", side_effect=AssertionError("No posting service needed")):
            runner.main()
        self.assertEqual(store.state["connection_settings"]["values"]["FB_PAGE_ID"], "123456")
        self.assertEqual(store.state["operations"][0]["status"], "complete")
        self.assertNotIn("private-key", json.dumps(store.state))
