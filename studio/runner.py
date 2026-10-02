"""Entrypoint for GitHub Actions; reads commands as data, never shell code."""
import json
import os
from pathlib import Path
import tempfile

from config import Config
from studio.media import MediaService
from studio.service import Studio
from studio.store import GitHubStore


def main():
    key = os.environ.get("GOOGLE_SERVICE_ACCOUNT_JSON")
    key_path = None
    try:
        if key:
            parsed = json.loads(key)
            with tempfile.NamedTemporaryFile(mode="w", suffix=".json", delete=False) as f:
                json.dump(parsed, f)
                key_path = f.name
            os.chmod(key_path, 0o600)
            os.environ["GOOGLE_SERVICE_ACCOUNT_FILE"] = key_path
        store = GitHubStore()
        store.initialize()
        app = Studio(store, lambda: MediaService(Config.from_env()))
        command = os.environ.get("STUDIO_COMMAND", "").strip()
        if command:
            app.command(json.loads(command))
        else:
            app.tick()
    finally:
        if key_path:
            Path(key_path).unlink(missing_ok=True)


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        # No tracebacks: third-party exceptions can include authenticated URLs.
        print(f"Studio stopped: {type(error).__name__}. Check the dashboard activity and repository secrets.")
        raise SystemExit(1)
