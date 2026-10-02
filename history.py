"""Tracks which images/videos/questions have already been posted, so a run
doesn't pick the same one again until every item in that pool has been used.
"""

import json
from pathlib import Path

HISTORY_FILE = Path(__file__).parent / "posted_history.json"
POST_TYPES = ("image", "video", "question")


def load() -> dict:
    if not HISTORY_FILE.exists():
        return {post_type: [] for post_type in POST_TYPES}
    with open(HISTORY_FILE, encoding="utf-8") as f:
        data = json.load(f)
    return {post_type: data.get(post_type, []) for post_type in POST_TYPES}


def record(history: dict, post_type: str, key: str) -> None:
    history[post_type].append(key)
    with open(HISTORY_FILE, "w", encoding="utf-8") as f:
        json.dump(history, f, ensure_ascii=False, indent=2)
