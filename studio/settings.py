"""Expose an allowlisted snapshot of non-secret worker configuration."""
import os

from studio.store import now_iso


VISIBLE_SETTINGS = (
    "FB_PAGE_ID", "DRIVE_FOLDER_ID", "DRIVE_FOLDER_ID_VIDEO", "DRIVE_FOLDER_ID_QUESTIONS",
    "OPENAI_MODEL", "OPENAI_MODEL_VIDEO", "OPENAI_MODEL_QUESTION",
)


def capture_settings(state, environ=None):
    environ = os.environ if environ is None else environ
    # Never copy an environment/config object wholesale: it contains credentials.
    values = {name: environ.get(name, "").strip() for name in VISIBLE_SETTINGS}
    for name in VISIBLE_SETTINGS:
        if name.startswith("OPENAI_MODEL") and not values[name]:
            values[name] = "gpt-4.1-mini"
    run_number = int(environ.get("GITHUB_RUN_NUMBER") or 0)
    previous = state.get("connection_settings", {})
    if run_number < previous.get("run_number", 0):
        return  # A delayed older job must not replace a newer settings snapshot.
    state["connection_settings"] = {"values": values, "updated_at": now_iso(), "run_number": run_number}
