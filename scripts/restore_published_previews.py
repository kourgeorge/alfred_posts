"""Restore Studio thumbnails from private Git history; never publish to Facebook.

Defaults to a dry run. Use --apply to restore matching missing previews and save
legacy missed runs. Requires an authenticated gh CLI; credentials stay in memory.
"""
import argparse
import base64
import json
import os
from pathlib import Path
import subprocess
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from studio.missed import capture_missed
from studio.store import GitHubStore


def restore(store, apply=False):
    repo = store.api("GET", "")
    repo.raise_for_status()
    if not repo.json().get("private"):
        raise ValueError("Preview restoration requires a private state repository.")
    current, _ = store.read()
    missing = [d for d in current["drafts"] if d["status"] == "published"
               and d["type"] in ("image", "question") and not d.get("preview")]
    previews, history = {}, {}
    for draft in missing:
        response = store.api("GET", "/commits", params={"sha": "studio-state", "path": "state.json",
                             "until": draft["published_at"], "per_page": 30})
        response.raise_for_status()
        for commit in response.json():
            sha = commit["sha"]
            if sha not in history:
                response = store.api("GET", "/contents/state.json", params={"ref": sha})
                response.raise_for_status()
                entry = response.json()
                if entry.get("encoding") != "base64":
                    response = store.api("GET", f"/git/blobs/{entry['sha']}")
                    response.raise_for_status()
                    entry = response.json()
                history[sha] = json.loads(base64.b64decode(entry["content"]))
            previous = next((d for d in history[sha]["drafts"] if d["id"] == draft["id"]
                             and d["source"].get("sha256") == draft["source"].get("sha256")), None)
            if previous and str(previous.get("preview", "")).startswith("data:image/jpeg;base64,"):
                previews[draft["id"]] = (draft["source"]["sha256"], previous["preview"])
                break

    def update(state):
        restored = 0
        for draft in state["drafts"]:
            saved = previews.get(draft["id"])
            if saved and draft["status"] == "published" and not draft.get("preview") and draft["source"].get("sha256") == saved[0]:
                draft["preview"] = saved[1]
                restored += 1
        before = len(state.get("missed_runs", []))
        capture_missed(state)
        return {"previews_restored": restored, "missed_runs_saved": len(state.get("missed_runs", [])) - before}

    result = store.change(update) if apply else update(current)
    print(json.dumps({"applied": apply, "missing_previews": len(missing), **result}))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("repository", help="Private owner/repository containing studio-state")
    parser.add_argument("--apply", action="store_true")
    args = parser.parse_args()
    try:
        token = subprocess.run(["gh", "auth", "token"], check=True, capture_output=True, text=True).stdout.strip()
        os.environ.update(GITHUB_REPOSITORY=args.repository, GITHUB_TOKEN=token)
        restore(GitHubStore(), args.apply)
    except Exception as error:
        # Never print authenticated requests or private provider response bodies.
        print(f"Restoration stopped ({type(error).__name__}). No Facebook action was taken.", file=sys.stderr)
        sys.exit(1)
