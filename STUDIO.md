# Alfred Studio

A single-user Facebook publishing dashboard. The static website runs on GitHub
Pages; GitHub Actions runs the existing Python scripts. Drafts and schedules are
JSON files in a private Git branch. A small serverless gateway checks the studio
password and connects to GitHub. There is no database.

## Repositories

- **Website and source:** `kourgeorge/alfred_posts` (public)
- **Private worker and state:** `kourgeorge/alfred_posts_automation`
- **Website:** https://kourgeorge.github.io/alfred_posts/

Only `dist/` is deployed to Pages. The website includes sample demo content but
never includes service credentials or real drafts. The private worker checks out
the Python code from the public source repository's `main` branch. Keep write
access to that repository restricted to people you trust to run the automation.

## Open the studio

Use the language selector on the sign-in page or in the top bar to choose
**English**, **עברית**, or **العربية**. Hebrew and Arabic use a right-to-left layout,
with translated controls, dialogs, feedback, and dates. The initial language follows
the browser when supported. A selected language is stored as the public
`alfred-ui-language` preference; authentication stays in memory only.
Switching languages preserves in-progress edits and selected uploads. It changes
the interface language; captions, saved writing instructions, filenames, credentials,
and scheduling timezones keep their values.

Open the website, enter your studio password, and select **Open studio**. No GitHub
access key or GitHub sign-in is needed in the dashboard. The password is configured
as the gateway's `STUDIO_PASSWORD` runtime secret; it is never embedded in the public
website, configuration file, or source repository.

A successful login creates a signed session valid for up to eight hours. The browser
holds it only in memory: refreshing, closing the tab, or choosing **Lock studio**
clears it. No session is stored in localStorage, sessionStorage, or cookies. Expired
sessions return to the login screen. Locking clears this browser's copy; already
issued tokens expire at their original deadline. Changing the server password or
session signing secret invalidates all sessions.

The public shell and sample demo contain no private drafts. All real data, commands,
and credential updates require gateway authentication. The gateway accepts only
specific studio operations against the fixed private automation repository, with
CORS restricted to the website origin. Login attempts are limited per running Worker
instance; this is best-effort protection, not a global rate limiter.

## Password gateway

The gateway is hosted at https://alfred-studio-gateway.gkour.chatgpt.site using Sites.
Its source is `gateway/worker.js`; the associated project ID is in
`.openai/hosting.json`. Runtime secrets are managed in that site's environment settings:

- `STUDIO_PASSWORD`: the one password used to open the dashboard.
- `SESSION_SECRET`: a random server-side signing secret (at least 32 random bytes).
- `GITHUB_TOKEN`: the server's GitHub connection, never returned to a browser.

To change the login password, update `STUDIO_PASSWORD` in the gateway's environment
settings and redeploy its saved version. Facebook/OpenAI credentials are changed
inside the dashboard's **Settings** page as before.

For a new installation, use a fine-grained GitHub token restricted to the private
automation repository with **Actions: read/write**, **Contents: read/write**, and
**Secrets: read/write**. The current installation uses the owner's existing GitHub
connection stored as a runtime secret. The gateway cannot proxy arbitrary GitHub
URLs, repositories, branches, workflows, or secret names.

To package a gateway update, run `python3 scripts/package_gateway.py`. The archive
contains only the Worker entrypoint (`index.js`) and hosting metadata. Commit
and push the exact source state to the Sites source repository, save that version
with the archive, then deploy it. The Sites audience is public so the GitHub Pages
client can reach the API; the application password protects every private endpoint.
The gateway can also run as a standard Cloudflare Worker with these three secrets.

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
media stays on Google Drive/Forms. Published posts retain their captions and previews;
**Activity → Published** shows every post published through Alfred Studio, with its
saved content, full-post view, and Facebook link. Posts created directly on Facebook
are not imported. Video playback uses an embedded Drive preview
and may require your Google account to have access. Source checksums are verified
before publishing; if a file or question changed after preview, create a fresh draft.

### Upload your own photo or video

In **Create a post**, choose **Upload image or video**, select or drop a file, and
describe it in a few words. **Generate caption** combines this description with
your saved Photo or Video writing instructions. The AI receives text only; it
does not inspect images, video frames, or audio. Review the caption and original
media, then publish or schedule the draft as usual. **Existing resources** keeps
the Drive/Forms generation flow available.

Supported uploads: still JPG, PNG, or WebP images up to 10 MiB, and MP4 or MOV
videos up to 50 MiB. Descriptions can contain up to 2,000 characters. Browser video
playback depends on the file's codec; the preview also offers a download link.

Original files are saved as 2 MiB parts and an immutable manifest under
`uploads/<id>/` on the private `studio-state` branch, outside `state.json`. The
gateway needs Contents write permission for uploads. A failed transfer can be
retried during the same session without replacing parts already saved. Incomplete
uploads remain private and are not published. Files and private Git history are
retained when drafts are deleted, just like existing state history; large upload
libraries will grow the repository and may eventually need dedicated media storage.

Every part is stored before caption generation is requested. The worker checks the
file type, size, and whole-file checksum before generating a caption and checks the
checksum again before publication. Scheduled uploads therefore work after the browser
is closed. Video playback reads authenticated parts; object URLs and the current
file selection are cleared when the studio is locked. Demo uploads stay in the browser.

Deploy both `gateway/worker.js` and the frontend/Python source for this feature.
The private workflow already checks out the current Python source and needs no
new secrets or workflow changes. Uploaded posts do not require Drive credentials.

## Recurring schedules

Choose the format, weekdays, preferred time, timezone, and action:

- **Prepare a draft:** creates a preview to review later.
- **Publish automatically:** generates new content and posts without manual review.

Pause, edit, or remove schedules from the dashboard. Schedules only apply to future
slots when created, edited, or resumed. The worker checks twice an hour at minutes
7 and 37. Times are the earliest intended publication time, not a precise SLA;
GitHub can delay or occasionally drop scheduled workflow starts. The latest eligible
recurring slot catches up at the next successful check for up to 24 hours, even if
that is the following local day. Only the latest slot runs after an outage, so a
backlog does not publish all at once. Older expired slots are recorded as missed
in Activity and need manual review. One-time posts are retained until the next
successful check, even if it is later.

The dashboard keeps a waiting or overdue occurrence visible until a worker claims
it. Schedule cards show the latest run result, and the schedule page shows the
last completed check. A missed occurrence is visible even before the next worker
starts; once a worker returns, it saves the missed run in a persistent list separate
from the bounded command log. Missed runs survive schedule edits and deletion.
Editing or pausing a schedule also preserves any unclaimed occurrence already due.
The 30-minute interval is a request to GitHub, not a promise of on-time execution.
The catch-up fix uses the existing private workflow without another hosting service.
Increasing cron frequency alone cannot guarantee exact-minute publishing.

To start a check yourself, open **Schedule → Run due tasks now**, review the list,
and select **Run due tasks**. This dispatches the GitHub worker immediately instead
of waiting for cron; GitHub still needs to start and finish the job. Due one-time
posts publish their saved captions, recurring publish tasks generate and publish,
and draft-only tasks prepare drafts. Future, paused, expired, and already-claimed
recurring slots are not forced to run. The button stays disabled while the request
is pending, then the dashboard shows completion and updated results. Posting
errors remain visible in Schedule and Activity. Demo mode only simulates the check.

While a request is pending, a notice stays visible as you scroll. It shows whether
the request is being sent, waiting for GitHub, or running, plus elapsed time and a
link to GitHub Actions. Longer waits get an updated message automatically. Keep
the tab open to receive the result; the elapsed time is not a completion estimate.

**Activity → Needs attention** includes overdue tasks, missed runs, failures, and
recovered drafts awaiting review. Upcoming posts and tasks waiting within the normal
30-minute check interval appear under **Scheduled**. One-time posts also become
overdue after that interval. Rescheduling a recovered draft moves it back to Scheduled. Select
**Prepare missed draft** to recover a missed occurrence for review; this never
publishes automatically, even if its original schedule used automatic publication.
Repeated recovery opens the same draft. Publish it explicitly after reviewing its
caption and preview. An uncertain Facebook result is never reset or retried by
recovery. GitHub delays can still happen; these records keep work visible for recovery.

The default timezone is `Asia/Jerusalem`; daylight saving is handled by IANA timezone
rules. The calendar displays each recurring task's chosen local time. Individual
post dates in the dashboard are shown in Israel time.

## AI prompts

Open **Settings → AI prompts**, choose **Photo**, **Video**, or **Question**, edit
the instructions, and select **Save prompt**. Each format is saved separately.
The save runs through the automation worker; wait for the saved confirmation.
Prompts can contain up to 8,000 characters and support Hebrew and other languages.

**Restore default** loads the original instructions into the editor; select
**Save prompt** to apply them. **Discard changes** reloads the current saved
instructions. Unsaved edits survive switching formats or dashboard pages during
the session. Locking or refreshing the studio clears unsaved edits.

Saved prompts apply to the next manual or recurring generation. Existing drafts
and one-time scheduled captions keep their reviewed text. A generation already
in progress uses the prompt it started with. Use **Preview a new post** to open
the composer, then generate a draft to review the result.

The date and media details are supplied automatically. The question prompt controls
the introduction; the original question, all answer choices, and course links are
assembled separately. The existing accuracy instructions are still appended.

Custom prompts and per-format revisions live in private `state.json`, without a
database. Concurrent edits to the same format are rejected instead of overwriting
newer instructions. Defaults in `prompts.json` are shared by the editor and Python
generator. Standalone command-line posting uses those defaults; dashboard overrides
apply to the private automation worker.

## Credentials

Settings can replace the Facebook Page token, Page ID, OpenAI API key/model, Google
service account JSON, and source folder IDs. Blank fields leave existing values in
place. Existing secret values cannot be retrieved through the website.

The browser uses GitHub's public encryption key and libsodium sealed boxes to
encrypt each replacement before sending it through the gateway to the GitHub Secrets API. Credentials
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

The serverless password gateway uses the Sites hosting account and its limits.
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
npx playwright install webkit
npm run dev
npm run build
.venv/bin/python -m unittest discover -s tests -p 'test_*.py'
npm run test:browser
npm run test:gateway
```

Browser checks use locally installed Chrome plus Playwright WebKit for mobile
coverage and exercise the demo plus mocked gateway API calls. They verify sealed-box
credential encryption, auth, exact-caption publishing, schedules, and desktop/mobile
layouts without making a real post. Touch checks cover 320–844 px screens, portrait
and landscape layouts, uploads, dialogs, and preserving edits when using the mobile menu.
Gateway tests cover authentication, session expiry, origin checks, endpoint restrictions,
and safe upstream failures. Python tests cover timezone rules, source verification, state transitions,
idempotency, and ambiguous Facebook results. CI runs Python and gateway tests and builds the site.
`Publish website` deploys the built static assets on relevant pushes to `main`.

For a different installation, change the gateway repository/origin constants,
`web/public/config.json`, the CSP origin in `web/index.html`, the checkout source
in `deployment/studio.yml`, and the repository condition in the Pages workflow.
