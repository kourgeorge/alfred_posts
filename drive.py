"""Google Drive + Forms access: listing files, downloading media, and picking
the source content for each post type.

Question posts read Google Forms (from a Drive folder full of forms) via the
Forms API. That API only supports OAuth2/service-account auth, never an API
key — share both the questions folder AND the individual form files with the
service account's client_email, the same way you share the image/video folders.
"""

import io
import random

from google.oauth2 import service_account
from googleapiclient.discovery import build
from googleapiclient.http import MediaIoBaseDownload

from config import Config, WorkflowError

DRIVE_SCOPES = [
    "https://www.googleapis.com/auth/drive.readonly",
    "https://www.googleapis.com/auth/forms.body.readonly",
]
MAX_VIDEO_SIZE_BYTES = 50 * 1024 * 1024
MAX_QUESTION_FORM_ATTEMPTS = 10


def build_drive_service(config: Config):
    if config.google_api_key:
        return build("drive", "v3", developerKey=config.google_api_key)
    credentials = service_account.Credentials.from_service_account_file(
        config.google_service_account_file, scopes=DRIVE_SCOPES
    )
    return build("drive", "v3", credentials=credentials)


def build_forms_service(config: Config):
    if not config.google_service_account_file:
        raise WorkflowError(
            "Question posts need GOOGLE_SERVICE_ACCOUNT_FILE — the Forms API doesn't "
            "support GOOGLE_API_KEY auth."
        )
    credentials = service_account.Credentials.from_service_account_file(
        config.google_service_account_file, scopes=DRIVE_SCOPES
    )
    return build("forms", "v1", credentials=credentials)


def list_drive_files(config: Config, folder_id: str, mime_clause: str, extra_fields: str = "") -> list[dict]:
    service = build_drive_service(config)

    fields = f"nextPageToken, files(id, name, mimeType{extra_fields})"
    files = []
    page_token = None
    query = f"'{folder_id}' in parents and {mime_clause} and trashed = false"
    while True:
        response = (
            service.files()
            .list(q=query, fields=fields, pageToken=page_token)
            .execute()
        )
        files.extend(response.get("files", []))
        page_token = response.get("nextPageToken")
        if not page_token:
            break

    if not files:
        raise WorkflowError(
            f"No files found in Drive folder {folder_id}. "
            "Check the folder ID and, if using a service account, that the folder is shared with it."
        )
    return files


def download_drive_file(config: Config, file_id: str) -> bytes:
    service = build_drive_service(config)

    request = service.files().get_media(fileId=file_id)
    buffer = io.BytesIO()
    downloader = MediaIoBaseDownload(buffer, request)
    done = False
    while not done:
        _, done = downloader.next_chunk()
    return buffer.getvalue()


def _unposted(files: list[dict], posted_ids: set[str]) -> list[dict]:
    """Prefer files not yet posted; once everything in the pool has been used, allow repeats again."""
    fresh = [f for f in files if f["id"] not in posted_ids]
    return fresh or files


def pick_image(config: Config, posted_ids: set[str] = frozenset()) -> dict:
    files = list_drive_files(config, config.drive_folder_id_image, "mimeType contains 'image/'")
    return random.choice(_unposted(files, posted_ids))


def pick_video(config: Config, posted_ids: set[str] = frozenset()) -> dict:
    files = list_drive_files(
        config, config.drive_folder_id_video, "mimeType contains 'video/'", extra_fields=", size"
    )
    small_enough = [f for f in files if int(f.get("size", 0)) < MAX_VIDEO_SIZE_BYTES]
    if not small_enough:
        raise WorkflowError(
            f"No videos under {MAX_VIDEO_SIZE_BYTES // (1024 * 1024)}MB found in Drive folder "
            f"{config.drive_folder_id_video}."
        )
    return random.choice(_unposted(small_enough, posted_ids))


def _questions_with_images(form: dict) -> list[dict]:
    """Mirror the n8n `format json` node: keep only choice-question items that
    have both a title and a non-empty image."""
    questions = []
    for item in form.get("items", []):
        question_item = item.get("questionItem") or {}
        question = question_item.get("question")
        image_uri = (question_item.get("image") or {}).get("contentUri")
        if not question or not item.get("title") or not isinstance(image_uri, str) or not image_uri.strip():
            continue
        options = (question.get("choiceQuestion") or {}).get("options", [])
        questions.append(
            {
                "question_id": question.get("questionId"),
                "question": {"text": item["title"], "image": image_uri},
                "answers": [opt.get("value") for opt in options],
            }
        )
    return questions


def question_key(question: dict) -> str:
    """History key for a question — unique across forms since it includes the form id."""
    return f"{question['form_id']}:{question['question_id']}"


def pick_question(config: Config, posted_ids: set[str] = frozenset()) -> dict:
    """Pick a random Google Form from the questions folder, fetch its content via
    the Forms API, and return one random question that has an image. Retries with
    a different random form if the one picked has no qualifying questions —
    mirrors the "If no questions with image retry" loop in the n8n workflow.
    Prefers a question not already in posted_ids; falls back to a repeat only if
    every qualifying question found during the search has already been posted."""
    forms = list_drive_files(
        config,
        config.drive_folder_id_questions,
        "mimeType = 'application/vnd.google-apps.form'",
    )
    forms_service = build_forms_service(config)

    tried_ids = set()
    fallback = None
    attempts = min(MAX_QUESTION_FORM_ATTEMPTS, len(forms))
    for _ in range(attempts):
        remaining = [f for f in forms if f["id"] not in tried_ids]
        form_file = random.choice(remaining)
        tried_ids.add(form_file["id"])

        form = forms_service.forms().get(formId=form_file["id"]).execute()
        form_title = form.get("info", {}).get("title", "Untitled Form")
        questions = _questions_with_images(form)
        if not questions:
            continue
        for question in questions:
            question["form_id"] = form_file["id"]

        fresh = [q for q in questions if question_key(q) not in posted_ids]
        if fresh:
            return {"form_title": form_title, **random.choice(fresh)}
        if fallback is None:
            fallback = {"form_title": form_title, **random.choice(questions)}

    if fallback:
        return fallback

    raise WorkflowError(
        f"No question with an image found after checking {len(tried_ids)} form(s) in Drive "
        f"folder {config.drive_folder_id_questions}."
    )
