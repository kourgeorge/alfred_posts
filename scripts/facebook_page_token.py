"""Turn a short-lived Facebook user token into a non-expiring Page token and save it to .env.

Usage: .venv/bin/python scripts/facebook_page_token.py
Asks for the app ID, app secret and a short-lived user token from the Graph API
Explorer (with pages_show_list, pages_read_engagement and pages_manage_posts).
Nothing secret is printed; the Page token is written to .env as FB_PAGE_ACCESS_TOKEN.
"""
from getpass import getpass
import os
from pathlib import Path

from dotenv import load_dotenv, set_key
import requests

ROOT = Path(__file__).resolve().parents[1]
ENV_FILE = ROOT / ".env"


def graph(version, path, **params):
    response = requests.get(f"https://graph.facebook.com/{version}/{path}", params=params, timeout=60)
    body = response.json()
    if not response.ok:
        raise SystemExit(f"Facebook error on /{path}: {body.get('error', {}).get('message', response.text)}")
    return body


def main():
    load_dotenv(ENV_FILE)
    version = os.environ.get("FB_GRAPH_VERSION", "v23.0")
    page_id = os.environ.get("FB_PAGE_ID", "")
    app_id = input("App ID: ").strip()
    app_secret = getpass("App secret (hidden): ").strip()
    short_token = getpass("Short-lived user token (hidden): ").strip()

    long_token = graph(version, "oauth/access_token", grant_type="fb_exchange_token", client_id=app_id,
                       client_secret=app_secret, fb_exchange_token=short_token)["access_token"]
    pages = graph(version, "me/accounts", access_token=long_token, fields="id,name,access_token", limit=100)["data"]
    if not pages:
        raise SystemExit("No Pages found. Make sure you ticked your Page and pages_show_list in the Explorer.")

    page = next((p for p in pages if p["id"] == page_id), None)
    if page is None:
        for number, p in enumerate(pages, 1):
            print(f"{number}. {p['name']} ({p['id']})")
        page = pages[int(input("Which Page? Enter its number: ")) - 1]

    info = graph(version, "debug_token", input_token=page["access_token"],
                 access_token=f"{app_id}|{app_secret}")["data"]
    expires = "never" if not info.get("expires_at") else f"at unix time {info['expires_at']}"
    print(f"Page: {page['name']} ({page['id']})")
    print(f"Token expires: {expires}")
    print(f"Permissions: {', '.join(info.get('scopes', []))}")

    set_key(ENV_FILE, "FB_PAGE_ID", page["id"])
    set_key(ENV_FILE, "FB_PAGE_ACCESS_TOKEN", page["access_token"])
    print(f"Saved FB_PAGE_ID and FB_PAGE_ACCESS_TOKEN to {ENV_FILE.name}.")


if __name__ == "__main__":
    main()
