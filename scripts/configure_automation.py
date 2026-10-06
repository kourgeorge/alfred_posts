"""Install the private workflow and upload local credentials without printing them.

Usage: .venv/bin/python scripts/configure_automation.py owner/private-repository
Requires an authenticated gh CLI with admin access to the private repository.
"""
import argparse
import base64
import json
from pathlib import Path
import subprocess
import sys
import tempfile

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from config import Config
import history


def gh_api(endpoint, payload=None):
    args = ["gh", "api", endpoint]
    if payload is not None:
        args += ["--method", "PUT", "--input", "-"]
    result = subprocess.run(args, input=json.dumps(payload) if payload is not None else None,
                            text=True, capture_output=True, check=True)
    return json.loads(result.stdout) if result.stdout.strip() else {}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("repository")
    parser.add_argument("--workflow-only", action="store_true", help="Install the worker without replacing existing secrets")
    args = parser.parse_args()
    repo = gh_api(f"repos/{args.repository}")
    if not repo["private"]:
        raise SystemExit("Automation repository must be private.")
    c = Config.from_env()
    values = {
        "OPENAI_API_KEY": c.openai_api_key,
        "OPENAI_MODEL": c.openai_model_image,
        "OPENAI_MODEL_VIDEO": c.openai_model_video,
        "OPENAI_MODEL_QUESTION": c.openai_model_question,
        "FB_PAGE_ACCESS_TOKEN": c.fb_page_access_token,
        "FB_PAGE_ID": c.fb_page_id,
        "FB_GRAPH_VERSION": c.fb_graph_version,
        "DRIVE_FOLDER_ID": c.drive_folder_id_image,
        "DRIVE_FOLDER_ID_VIDEO": c.drive_folder_id_video,
        "DRIVE_FOLDER_ID_QUESTIONS": c.drive_folder_id_questions,
        "INITIAL_POSTED_HISTORY": json.dumps(history.load()),
    }
    if c.google_service_account_file:
        values["GOOGLE_SERVICE_ACCOUNT_JSON"] = Path(c.google_service_account_file).read_text()
    if c.google_api_key:
        values["GOOGLE_API_KEY"] = c.google_api_key
    if c.tavily_api_key:
        values["TAVILY_API_KEY"] = c.tavily_api_key
    for name, value in ([] if args.workflow_only else values.items()):
        subprocess.run(["gh", "secret", "set", name, "--repo", args.repository],
                       input=value, text=True, check=True, capture_output=True)
        print(f"Configured {name}")
    # SSH uses the repository's normal git authorization; some gh OAuth tokens
    # intentionally lack the separate REST workflow-file editing scope.
    with tempfile.TemporaryDirectory(prefix="alfred-studio-") as directory:
        checkout = Path(directory) / "worker"
        subprocess.run(["git", "clone", "--depth", "1", repo["ssh_url"], str(checkout)], check=True)
        path = checkout / ".github/workflows/studio.yml"
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes((ROOT / "deployment/studio.yml").read_bytes())
        subprocess.run(["git", "add", ".github/workflows/studio.yml"], cwd=checkout, check=True)
        if subprocess.run(["git", "diff", "--cached", "--quiet"], cwd=checkout).returncode:
            subprocess.run(["git", "commit", "-m", "Install Alfred Studio worker"], cwd=checkout, check=True)
            subprocess.run(["git", "push", "origin", "HEAD"], cwd=checkout, check=True)
    print("Private automation workflow installed.")


if __name__ == "__main__":
    main()
