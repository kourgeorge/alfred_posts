"""Environment-driven configuration shared by every post type."""

import os
from dataclasses import dataclass

from dotenv import load_dotenv


class WorkflowError(Exception):
    """Raised for expected failures (bad config, API errors) — reported cleanly, no traceback."""


@dataclass
class Config:
    openai_api_key: str
    openai_model_image: str
    openai_model_video: str
    openai_model_question: str
    google_api_key: str | None
    google_service_account_file: str | None
    drive_folder_id_image: str
    drive_folder_id_video: str
    drive_folder_id_questions: str
    fb_page_id: str
    fb_page_access_token: str
    fb_graph_version: str
    timezone: str
    tavily_api_key: str | None = None

    @classmethod
    def from_env(cls, *, require_google=True) -> "Config":
        load_dotenv()

        def require(name: str) -> str:
            value = os.environ.get(name)
            if not value:
                raise WorkflowError(f"Missing required env var: {name} (see .env.example)")
            return value

        google_api_key = os.environ.get("GOOGLE_API_KEY") or None
        google_service_account_file = os.environ.get("GOOGLE_SERVICE_ACCOUNT_FILE") or None
        if require_google and not google_api_key and not google_service_account_file:
            raise WorkflowError(
                "Set either GOOGLE_API_KEY (for a public Drive folder) or "
                "GOOGLE_SERVICE_ACCOUNT_FILE (see .env.example)"
            )

        return cls(
            openai_api_key=require("OPENAI_API_KEY"),
            openai_model_image=os.environ.get("OPENAI_MODEL", "gpt-4.1-mini"),
            openai_model_video=os.environ.get("OPENAI_MODEL_VIDEO", "gpt-4.1-mini"),
            openai_model_question=os.environ.get("OPENAI_MODEL_QUESTION", "gpt-4.1-mini"),
            google_api_key=google_api_key,
            google_service_account_file=google_service_account_file,
            drive_folder_id_image=os.environ.get(
                "DRIVE_FOLDER_ID", ""
            ),
            drive_folder_id_video=os.environ.get(
                "DRIVE_FOLDER_ID_VIDEO", ""
            ),
            drive_folder_id_questions=os.environ.get(
                "DRIVE_FOLDER_ID_QUESTIONS", ""
            ),
            fb_page_id=require("FB_PAGE_ID"),
            fb_page_access_token=require("FB_PAGE_ACCESS_TOKEN"),
            fb_graph_version=os.environ.get("FB_GRAPH_VERSION", "v23.0"),
            timezone=os.environ.get("TIMEZONE", "Asia/Jerusalem"),
            tavily_api_key=os.environ.get("TAVILY_API_KEY") or None,
        )
