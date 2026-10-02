from types import SimpleNamespace
from unittest import TestCase
from unittest.mock import patch

import content
from studio.media import MediaService


class PromptGenerationTest(TestCase):
    def setUp(self):
        self.config = SimpleNamespace(openai_api_key="test-key", openai_model_image="photo-model",
            openai_model_video="video-model", openai_model_question="question-model", timezone="Asia/Jerusalem")
        self.question = {"form_id": "form", "form_title": "Road signs", "question_id": "question",
            "question": {"text": "Original question?", "image": "https://example.googleusercontent.com/image"},
            "answers": ["First option", "Second option", "Third option", "Fourth option"]}

    def test_each_media_format_forwards_custom_prompt_and_preserves_source_context(self):
        for kind in ("image", "video", "question"):
            with self.subTest(kind=kind), patch("content._complete", return_value="Generated introduction") as complete, \
                    patch("studio.media.drive.pick_image", return_value={"id": "image", "name": "Photo filename"}), \
                    patch("studio.media.drive.pick_video", return_value={"id": "video", "name": "Video filename"}), \
                    patch("studio.media.drive.pick_question", return_value=self.question), \
                    patch("studio.media.drive.download_drive_file", return_value=b"image bytes"), \
                    patch("studio.media.google_image", return_value=b"image bytes"):
                prepared = MediaService(self.config).prepare(kind, [], prompt=f"Custom {kind} prompt")
                self.assertEqual(complete.call_args.args[2], f"Custom {kind} prompt")
                context = {"image": "Photo filename", "video": "Video filename", "question": "Road signs"}[kind]
                self.assertIn(context, complete.call_args.args[3])
                if kind == "question":
                    for answer in self.question["answers"]:
                        self.assertEqual(prepared["text"].count(answer), 1)
                        self.assertNotIn(answer, complete.call_args.args[3])

    def test_cli_and_existing_installations_keep_original_defaults(self):
        with patch("content._complete", return_value="Caption") as complete:
            content.generate_image_post_text(self.config, "id", "name")
            self.assertEqual(complete.call_args.args[2], content.DEFAULT_PROMPTS["image"])
            content.generate_video_post_text(self.config, "name")
            self.assertEqual(complete.call_args.args[2], content.DEFAULT_PROMPTS["video"])
            content.generate_question_post_text(self.config, self.question)
            self.assertEqual(complete.call_args.args[2], content.DEFAULT_PROMPTS["question"])

    def test_custom_instructions_reach_model_with_existing_accuracy_rules(self):
        with patch("content.OpenAI") as client:
            client.return_value.chat.completions.create.return_value = SimpleNamespace(
                choices=[SimpleNamespace(message=SimpleNamespace(content="Caption"))])
            content.generate_video_post_text(self.config, "Example.mp4", system_prompt="My writing style")
        call = client.return_value.chat.completions.create.call_args.kwargs
        self.assertEqual(call["model"], "video-model")
        self.assertTrue(call["messages"][0]["content"].startswith("My writing style"))
        self.assertIn("כללי דיוק מחייבים", call["messages"][0]["content"])
        self.assertIn("Example.mp4", call["messages"][1]["content"])
