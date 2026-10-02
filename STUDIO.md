# Alfred Studio

A single-user Facebook publishing dashboard. The static website runs on GitHub
Pages; GitHub Actions runs the existing Python scripts. Drafts and schedules are
JSON files in a private Git branch. There is no database or application server.

## Repositories

- **Website and source:** `kourgeorge/alfred_posts` (public)
- **Private worker and state:** `kourgeorge/alfred_posts_automation`
- **Website:** https://kourgeorge.github.io/alfred_posts/

Only `dist/` is deployed to Pages. The website includes sample demo content but
never includes service credentials or real drafts. The private worker checks out
the Python code from the public source repository's `main` branch. Keep write
access to that repository restricted to people you trust to run the automation.

## Open the studio

1. Create a [fine-grained GitHub personal access token](https://github.com/settings/personal-access-tokens/new).
2. Select **Only select repositories → alfred_posts_automation**.
3. Give it these repository permissions:
   - **Actions: Read and write** — run posting and scheduling commands.
   - **Contents: Read-only** — read your drafts and schedules.
   - **Secrets: Read and write** — update Facebook/OpenAI/Google credentials.
4. Copy the token and enter it in the website's **Access key** field.

This token is your single studio access key. It stays in memory, not localStorage,
sessionStorage, cookies, the URL, or source code. Refreshing/closing the tab or
pressing **Lock studio** clears the session. Store the key in your password manager.
The website shell and demo are public; real data and all actions require GitHub
authorization. A browser-only shared password would not protect those APIs.

## Create, review, and publish

- **Photo:** selects a Drive image and generates a Hebrew caption.
- **Video:** selects a Drive video under 50 MB and generates a matching caption.
- **Question:** selects an illustrated question from Google Forms. The original
  question and every answer option are inserted exactly; AI writes only the introduction.
- Generate a draft, edit its caption, and review the Facebook preview.
- **Save draft** keeps the edited text without publishing.
- **Publish now** publishes that draft after the in-app confirmation.
- **Schedule post** schedules that exact caption and selected source for one time.
- Drafts are limited to 30 unfinished items; delete or publish old drafts to make room.

Photo/question previews are small JPEG thumbnails kept in private state. Original
media stays on Google Drive/Forms. Video playback uses an embedded Drive preview
and may require your Google account to have access. Source checksums are verified
before publishing; if a file or question changed after preview, create a fresh draft.

## Recurring schedules

Choose the format, weekdays, preferred time, timezone, and action:

- **Prepare a draft:** creates a preview to review later.
- **Publish automatically:** generates new content and posts without manual review.

Pause, edit, or remove schedules from the dashboard. Schedules only apply to future
slots when created, edited, or resumed. The worker checks twice an hour at minutes
7 and 37. Times are the earliest intended publication time, not a precise SLA;
GitHub can delay or occasionally drop scheduled workflow starts. Recurring slots
more than two hours late are skipped to avoid a backlog of auto-generated posts.
One-time posts are retained until the next successful check, even if it is later.

The default timezone is `Asia/Jerusalem`; daylight saving is handled by IANA timezone
rules. The calendar displays each recurring task's chosen local time. Individual
post dates in the dashboard are shown in Israel time.

## Credentials

Settings can replace the Facebook Page token, Page ID, OpenAI API key/model, Google
service account JSON, and source folder IDs. Blank fields leave existing values in
place. Existing secret values cannot be retrieved through the website.

The browser uses GitHub's public encryption key and libsodium sealed boxes to
encrypt each replacement before sending it to the GitHub Secrets API. Credentials
are only available to the private Actions worker at execution time. Running jobs
retain the credentials they started with.

Initial installation from the existing local `.env`:

```bash
.venv/bin/python scripts/configure_automation.py kourgeorge/alfred_posts_automation
```

This uploads configuration and the existing posted-content history without printing
credential values, then installs `deployment/studio.yml` into the private repo.
The local `.env`, service-account files, and posted history are ignored by Git.
The helper requires an authenticated `gh` CLI and the target repo must be private.
History is imported when the private state branch is first initialized. Subsequent
command-line runs maintain their own local history independently of the dashboard.

## How state and retries work

The worker initializes an orphan `studio-state` branch containing `state.json`.
GitHub Contents API commits use the current blob SHA for compare-and-swap writes.
Conflicts reload state and retry the mutation. No single workflow concurrency group
is used: GitHub's single-pending-job behavior could otherwise discard user commands.

Commands have unique IDs and receipts. Before a Facebook API call, the draft is
durably reserved. A replay or another request cannot publish that draft again.
Source-download failures leave a failed draft for review. An ambiguous publication
error leaves **Check Facebook** status and is never retried automatically. Video
uploads remain **Processing** until Facebook confirms publishing is complete.

If a runner is interrupted while a post is Preparing/Publishing, inspect its Actions
run and the Facebook page before intervening. The receipt is logged when available.
Do not reset state and retry a publication whose outcome is unknown. State and
operation logs are private, and old versions remain in the private Git history.

## Costs

Public Pages hosting and standard public repository build runners are free. The
private worker uses the account's Actions allowance (GitHub Free includes 2,000
minutes/month). Twice-hourly checks consume roughly 1,440–1,488 one-minute runs per
month **before** manual requests, generation time, and other account usage. Longer
runs consume more minutes. Change the cron in the private workflow to `17 * * * *`
for hourly checks if needed; update the dashboard timing copy to match. OpenAI API
usage is billed separately. GitHub billing settings control any overage spending.

## Development and verification

```bash
npm install
npm run dev
npm run build
.venv/bin/python -m unittest discover -s tests -p 'test_*.py'
npm run test:browser
```

Browser checks use locally installed Chrome and exercise the demo plus mocked
GitHub API calls. They verify sealed-box credential encryption, auth, exact-caption
publishing, schedules, and desktop/mobile layouts without making a real post.
Python tests cover timezone rules, source verification, state transitions,
idempotency, and ambiguous Facebook results. CI runs Python tests and builds the site.
`Publish website` deploys the built static assets on relevant pushes to `main`.

For a different installation, change `web/public/config.json`, the checkout source
in `deployment/studio.yml`, and the repository condition in the Pages workflow.
