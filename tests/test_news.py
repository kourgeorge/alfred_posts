import copy
from datetime import datetime, timedelta, timezone
import hashlib
import io
import json
from types import SimpleNamespace
from unittest import TestCase
from unittest.mock import Mock, patch

from PIL import Image

import content
from studio.media import MediaService
from studio.news import NewsService, article_key, fetch_public, media_preview, public_url
from studio.scheduler import validate_schedule
from studio.service import Studio
from studio.store import MemoryStore


class NewsTest(TestCase):
    def setUp(self):
        self.config = SimpleNamespace(tavily_api_key="private-tavily-key", openai_api_key="private-ai-key",
            openai_model_image="test-model", timezone="Asia/Jerusalem", fb_graph_version="v23.0",
            fb_page_id="page", fb_page_access_token="private-facebook-key")
        self.date = datetime.now(timezone.utc).isoformat()
        self.story = {"title": "New bus service announced", "url": "https://www.ynet.co.il/transport/article/test",
            "published_date": self.date, "content": "The transport authority announced a new bus service today. " * 5,
            "images": [{"url": "https://images.example.com/bus.jpg", "description": "A bus at a stop"}]}
        self.preview = {"preview": "data:image/jpeg;base64,/9j/2Q==", "image_url": "https://images.example.com/bus.jpg",
            "image_description": "A bus at a stop", "media_kind": "image"}

    def api(self, url, **kwargs):
        if url != "https://api.tavily.com/search":
            self.fail("Generation must not publish to Facebook")
        self.assertEqual(kwargs["headers"], {"Authorization": "Bearer private-tavily-key"})
        self.assertEqual(kwargs["json"]["time_range"], "week")
        self.assertTrue(kwargs["json"]["include_images"])
        self.assertTrue(kwargs["json"]["filter_by_published_date"])
        result = copy.deepcopy(self.story)
        if "reuters.com" in kwargs["json"]["include_domains"]:
            result["url"] = "https://www.reuters.com/world/new-bus-service"
        return Mock(status_code=200, json=lambda: {"results": [result]})

    def test_searches_both_regions_filters_old_untrusted_and_repeated_articles(self):
        def response(url, **kwargs):
            good = self.api(url, **kwargs).json()["results"][0]
            variants = [good, {**good, "url": good["url"] + "?utm_source=email#top"},
                {**good, "url": good["url"] + "-old", "published_date": (datetime.now(timezone.utc) - timedelta(days=12)).isoformat()},
                {**good, "url": good["url"] + "-undated", "published_date": None},
                {**good, "url": "https://127.0.0.1/private"}, {**good, "url": "https://untrusted.example/news"}]
            return Mock(status_code=200, json=lambda: {"results": variants})
        with patch("studio.news.requests.post", side_effect=response) as search:
            candidates = NewsService(self.config).candidates([])
        self.assertEqual(search.call_count, 4)
        self.assertEqual({item["region"] for item in candidates}, {"israel", "world"})
        self.assertEqual(len(candidates), 2)
        with patch("studio.news.requests.post", side_effect=response):
            self.assertEqual(NewsService(self.config).candidates([item["key"] for item in candidates]), [])

    def test_news_draft_is_grounded_attributed_styled_and_publishes_only_the_reviewed_link(self):
        store = MemoryStore()
        store.state["posted"].pop("news", None)  # Existing installations have only the older formats.
        store.state["prompts"] = {"news": "My saved news voice, in Hebrew."}
        app = Studio(store, lambda: MediaService(self.config))
        app.command({"id": "save-news-selection", "action": "save_prompt", "type": "news_selection",
                     "prompt": "Prioritize public transport in Israel.", "revision": 0})
        with patch("studio.news.requests.post", side_effect=self.api), \
                patch("studio.news.media_preview", return_value=self.preview), patch("content.OpenAI") as ai:
            ai.return_value.chat.completions.create.side_effect = [
                SimpleNamespace(choices=[SimpleNamespace(message=SimpleNamespace(content='{"ranked_ids":[0,1]}'))]),
                SimpleNamespace(choices=[SimpleNamespace(message=SimpleNamespace(content="דיווח חדש על קו אוטובוס"))]),
            ]
            command = {"id": "news-generation-001", "action": "generate", "type": "news", "caption_style": "funny"}
            app.command(command)
            app.command(command)
        self.assertEqual(ai.return_value.chat.completions.create.call_count, 2)
        ranking = ai.return_value.chat.completions.create.call_args_list[0].kwargs["messages"][0]["content"]
        self.assertTrue(ranking.startswith("Prioritize public transport in Israel."))
        self.assertIn('"ranked_ids"', ranking)
        self.assertNotIn("Caption style for this draft", ranking)
        messages = ai.return_value.chat.completions.create.call_args.kwargs["messages"]
        self.assertIn("My saved news voice", messages[0]["content"])
        self.assertIn("Caption style for this draft: Funny", messages[0]["content"])
        self.assertIn("NEWS ACCURACY RULES override all tone instructions", messages[0]["content"])
        self.assertIn("The transport authority", messages[1]["content"])
        self.assertEqual(store.state["prompts"], {"news": "My saved news voice, in Hebrew.",
            "news_selection": "Prioritize public transport in Israel."})
        draft = store.state["drafts"][0]
        self.assertEqual(draft["caption_style"], "funny")
        self.assertEqual(draft["status"], "draft")
        self.assertTrue(draft["text"].endswith(self.story["url"]))
        self.assertIn(self.story["title"], draft["text"])
        self.assertEqual(draft["preview"], self.preview["preview"])
        with patch("facebook.requests.post", return_value=Mock(ok=True, json=lambda: {"id": "page_post"})) as publish:
            app.command({"id": "news-publish-001", "action": "publish", "draft_id": draft["id"],
                         "revision": 1, "text": "My reviewed news caption"})
        self.assertEqual(publish.call_count, 1)
        self.assertTrue(publish.call_args.args[0].endswith("/page/feed"))
        self.assertEqual(publish.call_args.kwargs["data"]["link"], self.story["url"])
        self.assertEqual(publish.call_args.kwargs["data"]["message"], "My reviewed news caption")
        self.assertNotIn("files", publish.call_args.kwargs)
        self.assertEqual(store.state["posted"]["news"], [article_key(self.story["url"])])

    def test_failed_searches_are_clear_and_never_expose_the_api_key(self):
        for status in (401, 403, 429, 432, 433):
            with self.subTest(status=status), patch("studio.news.requests.post", return_value=Mock(status_code=status)):
                with self.assertRaises(ValueError) as error:
                    NewsService(self.config).search("news", [])
                self.assertNotIn(self.config.tavily_api_key, str(error.exception))
        self.config.tavily_api_key = None
        with patch("studio.news.requests.post") as search, self.assertRaisesRegex(ValueError, "Settings"):
            NewsService(self.config).search("news", [])
        search.assert_not_called()

    def test_invalid_selection_or_missing_media_never_creates_a_draft(self):
        for selection in ('{}', '{"ranked_ids":[99]}', '{"ranked_ids":[true]}', '{"ranked_ids":[]}', 'not json'):
            with self.subTest(selection=selection), patch("studio.news.requests.post", side_effect=self.api), \
                    patch("content._complete", return_value=selection), patch("studio.news.media_preview") as media:
                with self.assertRaises(ValueError):
                    NewsService(self.config).prepare([])
                media.assert_not_called()
        with patch("studio.news.requests.post", side_effect=self.api), \
                patch("content._complete", return_value='{"ranked_ids":[0]}') as ai, \
                patch("studio.news.media_preview", return_value=None):
            with self.assertRaisesRegex(ValueError, "preview image"):
                NewsService(self.config).prepare([])
            self.assertEqual(ai.call_count, 1)

    def test_news_is_manual_and_source_changes_fail_before_publication(self):
        with self.assertRaisesRegex(ValueError, "photo, video, or question"):
            validate_schedule({"name": "News", "type": "news"})
        source = {"url": self.story["url"], "sha256": hashlib.sha256(self.story["url"].encode()).hexdigest()}
        media = MediaService(self.config)
        self.assertEqual(media.download({"type": "news", "source": source}), self.story["url"].encode())
        source["url"] += "-different"
        with self.assertRaisesRegex(ValueError, "changed"):
            media.download({"type": "news", "source": source})

    def test_preview_uses_publisher_image_and_recognizes_video_without_reuploading_it(self):
        buf = io.BytesIO()
        Image.new("RGB", (640, 360), (120, 150, 180)).save(buf, format="JPEG")
        def fetch(url, *, image=False):
            if not image:
                return b'<meta property="og:image" content="/hero.jpg"><meta property="og:video" content="/video.mp4">'
            self.assertEqual(url, "https://www.ynet.co.il/hero.jpg")
            return buf.getvalue()
        with patch("studio.news.fetch_public", side_effect=fetch):
            result = media_preview({**self.story, "images": []})
        self.assertTrue(result["preview"].startswith("data:image/jpeg;base64,"))
        self.assertEqual(result["media_kind"], "video")
        self.assertEqual(result["image_url"], "https://www.ynet.co.il/hero.jpg")

    def test_download_checks_and_pins_public_addresses_and_rejects_private_redirects(self):
        for url in ("http://example.com", "https://localhost", "https://127.0.0.1/file", "https://x.local/file",
                    "https://user:password@example.com", "https://example.com:8000", "https://169.254.169.254/"):
            self.assertIsNone(public_url(url))
        with patch("studio.news.socket.getaddrinfo", return_value=[(0, 0, 0, "", ("127.0.0.1", 443))]), \
                patch("studio.news.urllib3.HTTPSConnectionPool") as pool:
            with self.assertRaisesRegex(ValueError, "not public"):
                fetch_public("https://example.com/preview")
            pool.assert_not_called()
        response = Mock(status=302, headers={"Location": "https://127.0.0.1/private"})
        with patch("studio.news.socket.getaddrinfo", return_value=[(0, 0, 0, "", ("93.184.216.34", 443))]), \
                patch("studio.news.urllib3.HTTPSConnectionPool") as pool:
            pool.return_value.urlopen.return_value = response
            with self.assertRaisesRegex(ValueError, "not public"):
                fetch_public("https://example.com/preview")
            self.assertEqual(pool.call_count, 1)
            self.assertEqual(pool.call_args.args[0], "93.184.216.34")
            self.assertEqual(pool.call_args.kwargs["assert_hostname"], "example.com")
            self.assertNotIn("Authorization", pool.return_value.urlopen.call_args.kwargs["headers"])
