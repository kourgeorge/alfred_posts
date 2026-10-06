"""Prepare content using the existing scripts, then publish the same source."""
import base64
import hashlib
import io
from urllib.parse import urlparse

import requests
from PIL import Image, ImageOps

import content
import drive
import facebook
from studio.uploads import Uploads, validate_description, validate_media
from studio.news import NewsService, public_url


def digest(data):
    return hashlib.sha256(data).hexdigest()


def google_image(url):
    parsed = urlparse(url)
    if parsed.scheme != "https" or not parsed.hostname or not any(parsed.hostname.endswith(suffix) for suffix in
                                           (".googleusercontent.com", ".ggpht.com", ".google.com")):
        raise ValueError("The question image must come from Google Forms.")
    response = requests.get(url, timeout=60)
    response.raise_for_status()
    if len(response.content) > 20 * 1024 * 1024:
        raise ValueError("The question image is too large.")
    return response.content


def thumbnail(data):
    try:
        img = ImageOps.exif_transpose(Image.open(io.BytesIO(data))).convert("RGB")
        img.thumbnail((720, 480))
        buf = io.BytesIO()
        img.save(buf, format="JPEG", quality=65)
        return "data:image/jpeg;base64," + base64.b64encode(buf.getvalue()).decode()
    except (OSError, ValueError):
        return None


class MediaService:
    def __init__(self, config, uploads=None):
        self.config = config
        self.uploads = Uploads(uploads) if uploads else None

    def prepare_upload(self, post_type, upload_id, description, prompt=None):
        description = validate_description(description)
        item, data = self.uploads.read(upload_id)
        if item["type"] != post_type:
            raise ValueError("The uploaded file does not match the selected post format.")
        validate_media(item, data)
        preview = thumbnail(data) if post_type == "image" else None
        if post_type == "image" and not preview:
            raise ValueError("This image could not be previewed. Choose a different image.")
        text = content.generate_upload_post_text(self.config, post_type, description, system_prompt=prompt)
        return {"source": {"key": f"upload:{upload_id}", "upload_id": upload_id, "name": item["name"],
                           "sha256": item["sha256"], "size": item["size"], "mime": item["mime"],
                           "parts": item["parts"], "description": description}, "text": text, "preview": preview}

    def prepare(self, post_type, posted, prompt=None):
        c = self.config
        if post_type == "news":
            return NewsService(c).prepare(posted, prompt=prompt)
        if post_type == "question":
            item = drive.pick_question(c, posted_ids=set(posted))
            data = google_image(item["question"]["image"])
            source = {"key": drive.question_key(item), "form_id": item["form_id"],
                      "question_id": item["question_id"], "name": item["form_title"],
                      "question": item["question"]["text"], "answers": item["answers"],
                      "url": f"https://docs.google.com/forms/d/{item['form_id']}/edit"}
            text = content.generate_question_post_text(c, item, system_prompt=prompt)
        else:
            item = (drive.pick_video if post_type == "video" else drive.pick_image)(c, posted_ids=set(posted))
            data = drive.download_drive_file(c, item["id"])
            source = {"key": item["id"], "id": item["id"], "name": item["name"],
                      "url": f"https://drive.google.com/file/d/{item['id']}/view"}
            text = (content.generate_video_post_text(c, item["name"], system_prompt=prompt) if post_type == "video"
                    else content.generate_image_post_text(c, item["id"], item["name"], system_prompt=prompt))
        source["sha256"] = digest(data)
        return {"source": source, "text": text, "preview": None if post_type == "video" else thumbnail(data)}

    def download(self, draft):
        source = draft["source"]
        if draft["type"] == "news":
            if not public_url(source.get("url")):
                raise ValueError("The news source URL is invalid. Generate a new draft.")
            data = source["url"].encode()
        elif source.get("upload_id"):
            item, data = self.uploads.read(source["upload_id"])
            if item["type"] != draft["type"]:
                raise ValueError("The uploaded file does not match this draft.")
        elif draft["type"] == "question":
            form = drive.build_forms_service(self.config).forms().get(formId=source["form_id"]).execute()
            item = next((x for x in drive._questions_with_images(form)
                         if x["question_id"] == source["question_id"]), None)
            if not item or item["question"]["text"] != source["question"] or item["answers"] != source["answers"]:
                raise ValueError("This question changed in Google Forms. Please generate a new draft.")
            data = google_image(item["question"]["image"])
        else:
            data = drive.download_drive_file(self.config, source["id"])
        if digest(data) != source["sha256"]:
            raise ValueError("The source media changed after preview. Please generate a new draft.")
        return data

    def publish(self, draft, data):
        if draft["type"] == "news":
            return facebook.post_link_to_page(self.config, draft["source"]["url"], draft["text"])
        if draft["type"] == "video":
            return facebook.post_video_to_page(self.config, data, draft["text"])
        return facebook.post_photo_to_page(self.config, data, draft["text"])

    def video_status(self, video_id):
        c = self.config
        r = requests.get(f"https://graph.facebook.com/{c.fb_graph_version}/{video_id}",
                         headers={"Authorization": "Bearer " + c.fb_page_access_token},
                         params={"fields": "id,permalink_url,status"}, timeout=30)
        r.raise_for_status()
        return r.json()
