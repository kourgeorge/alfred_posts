"""The shared cases in tests/parity/cases.json hold the Python worker's answers.

tests/server/parity.test.js checks the Cloudflare (JavaScript) worker against the
same file, so both servers stay identical. If a Python change makes this test fail
on purpose, regenerate the expected values and update the JavaScript worker too.
"""
import json
from datetime import datetime
from pathlib import Path
import unittest

from content import caption_prompt
from studio.news import article_key, public_url
from studio.scheduler import due_slot, recent_slots, validate_schedule
from studio.service import safe_error

CASES = json.loads((Path(__file__).parent / "parity/cases.json").read_text(encoding="utf-8"))


class ParityTest(unittest.TestCase):
    def test_urls(self):
        for case in CASES["urls"]:
            with self.subTest(url=case["url"]):
                self.assertEqual(public_url(case["url"]), case["public_url"])
                if case["public_url"]:
                    self.assertEqual(article_key(case["public_url"]), case["article_key"])

    def test_schedules(self):
        for case in CASES["schedules"]:
            with self.subTest(case=case):
                now = datetime.fromisoformat(case["now"])
                self.assertEqual(due_slot(case["schedule"], now), case["due_slot"])
                slots = [[slot, t.isoformat()] for slot, t in recent_slots(case["schedule"], now, 9)]
                self.assertEqual(slots, case["slots"])

    def test_validate_schedule(self):
        for case in CASES["validate_schedule"]:
            with self.subTest(case=case):
                if "error" in case:
                    with self.assertRaises(ValueError) as error:
                        validate_schedule(case["input"])
                    self.assertEqual(str(error.exception), case["error"])
                else:
                    self.assertEqual(validate_schedule(case["input"]), case["value"])

    def test_caption_prompt_and_safe_error(self):
        for case in CASES["caption_prompt"]:
            self.assertEqual(caption_prompt(case["type"], case["prompt"], case["style"]), case["result"])
        for case in CASES["safe_error"]:
            self.assertEqual(safe_error(Exception(case["message"])), case["result"])


if __name__ == "__main__":
    unittest.main()
