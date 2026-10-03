"""Private GitHub branch storage with optimistic, atomic state updates."""
import base64
import copy
import json
import os
import time
from datetime import datetime, timezone

import requests

BRANCH = "studio-state"
FILE = "state.json"


def now_iso():
    return datetime.now(timezone.utc).isoformat()


def empty_state():
    return {"version": 1, "updated_at": now_iso(), "drafts": [], "schedules": [],
            "operations": [], "posted": {"image": [], "video": [], "question": []}}


class GitHubStore:
    def __init__(self):
        self.repo = os.environ["GITHUB_REPOSITORY"]
        self.base = f"https://api.github.com/repos/{self.repo}"
        self.session = requests.Session()
        self.session.headers.update({"Authorization": "Bearer " + os.environ["GITHUB_TOKEN"],
                                     "Accept": "application/vnd.github+json",
                                     "X-GitHub-Api-Version": "2022-11-28"})

    def api(self, method, path, **kwargs):
        response = self.session.request(method, self.base + path, timeout=60, **kwargs)
        if response.status_code not in (404, 409, 422):
            response.raise_for_status()
        return response

    def initialize(self):
        repo = self.api("GET", "").json()
        if not repo.get("private"):
            raise ValueError("The automation repository must be private to protect drafts and history.")
        if self.api("GET", f"/git/ref/heads/{BRANCH}").status_code != 404:
            return
        state = empty_state()
        # Optional import preserves history from the original command-line workflow.
        if os.environ.get("INITIAL_POSTED_HISTORY"):
            state["posted"] = json.loads(os.environ["INITIAL_POSTED_HISTORY"])
        tree = self.api("POST", "/git/trees", json={"tree": [{"path": FILE, "mode": "100644",
                       "type": "blob", "content": json.dumps(state, ensure_ascii=False)}]}).json()
        commit = self.api("POST", "/git/commits", json={"message": "Initialize private studio state",
                          "tree": tree["sha"], "parents": []}).json()
        response = self.api("POST", "/git/refs", json={"ref": f"refs/heads/{BRANCH}", "sha": commit["sha"]})
        if response.status_code == 422 and self.api("GET", f"/git/ref/heads/{BRANCH}").status_code == 200:
            return  # Another worker initialized the branch first.
        response.raise_for_status()

    def read(self):
        response = self.api("GET", f"/contents/{FILE}", params={"ref": BRANCH})
        response.raise_for_status()
        entry = response.json()
        if entry.get("encoding") == "base64":
            state = json.loads(base64.b64decode(entry["content"]))
        else:
            raw = self.api("GET", f"/git/blobs/{entry['sha']}")
            raw.raise_for_status()
            state = json.loads(base64.b64decode(raw.json()["content"]))
        return state, entry["sha"]

    def read_file(self, path, limit):
        response = self.api("GET", f"/contents/{path}", params={"ref": BRANCH})
        if response.status_code == 404:
            raise ValueError("The uploaded file is incomplete or unavailable. Upload it again.")
        response.raise_for_status()
        entry = response.json()
        if not isinstance(entry.get("size"), int) or entry["size"] > limit:
            raise ValueError("The uploaded file is too large.")
        if entry.get("encoding") != "base64":
            response = self.api("GET", f"/git/blobs/{entry['sha']}")
            response.raise_for_status()
            entry = response.json()
        data = base64.b64decode(entry["content"], validate=False)
        if len(data) > limit:
            raise ValueError("The uploaded file is too large.")
        return data

    def change(self, mutate):
        # mutate must only change state, never make external calls: it may be retried.
        for attempt in range(8):
            state, sha = self.read()
            result = mutate(state)
            state["updated_at"] = now_iso()
            payload = base64.b64encode(json.dumps(state, ensure_ascii=False).encode()).decode()
            response = self.api("PUT", f"/contents/{FILE}", json={"branch": BRANCH,
                                "sha": sha, "content": payload, "message": "Update studio state"})
            if response.status_code in (409, 422):
                time.sleep(min(0.4 * (attempt + 1), 2))
                continue
            response.raise_for_status()
            return result
        raise RuntimeError("State is busy. Please try again after the current operation finishes.")


class MemoryStore:
    """Test store; mirrors transaction isolation without network requests."""
    def __init__(self, state=None):
        self.state = state or empty_state()

    def read(self):
        return copy.deepcopy(self.state), "test"

    def change(self, mutate):
        state = copy.deepcopy(self.state)
        result = mutate(state)
        state["updated_at"] = now_iso()
        self.state = state
        return result
