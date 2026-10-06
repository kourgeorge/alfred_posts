# Alfred Studio & Facebook posting scripts

**[Open Alfred Studio](https://kourgeorge.github.io/alfred_posts/)** — preview and edit
photo, video, question, and news posts; choose caption styles; publish on demand; schedule one-time and recurring
posts; edit AI prompts; choose a shared OpenAI model from a freshly retrieved list;
update API credentials. See **[STUDIO.md](STUDIO.md)** for access-key setup,
private GitHub Actions automation, deployment, and development.

The original command-line workflow remains available below.

Python replacement for the n8n workflows `AlfredPostFBImageMain.json`,
`AlfredFBPostVideoMain.json`, and `AlfredPostFBQuestionMain.json` +
`GetRandomQuestionfromGoogleForm.json`: picks a random image, video, or driving-theory
quiz question, writes a Hebrew Facebook post for it with OpenAI, and publishes it to a
Facebook Page.

## Files

- `post_to_facebook.py` — CLI entry point; dispatches to the right post type.
- `config.py` — `.env` loading into a `Config` object.
- `drive.py` — Google Drive listing/downloading, and Google Forms fetching for
  question posts.
- `content.py` — the three Hebrew personas and the OpenAI call that generates post text.
- `facebook.py` — the three Graph API publishing calls (photo by bytes, photo by URL,
  video by bytes).
- `history.py` — remembers what's already been posted (`posted_history.json`, created
  automatically) so the same image/video/question isn't picked again until every item
  in that pool has been used at least once.

## Setup

1. `python3 -m venv .venv && source .venv/bin/activate`
2. `pip install -r requirements.txt`
3. Google Drive access — pick one:
   - **Folders are public** ("Anyone with the link") and you only need `image`/`video`
     posts: in Google Cloud Console, enable the Drive API and create an API key
     (APIs & Services > Credentials). Set `GOOGLE_API_KEY`.
   - **Otherwise** (private folders, or you want `question` posts): create a service
     account, download its JSON key, enable both the Drive API and the Google Forms API
     on that project, and share:
     - the image folder (`DRIVE_FOLDER_ID`)
     - the video folder (`DRIVE_FOLDER_ID_VIDEO`)
     - the questions folder (`DRIVE_FOLDER_ID_QUESTIONS`) **and each individual Google
       Form inside it**

     with the service account's `client_email`. Set `GOOGLE_SERVICE_ACCOUNT_FILE` to the
     key's path. The Forms API only supports this kind of auth — never an API key.
4. Get a long-lived Facebook Page access token with `pages_manage_posts` and
   `pages_read_engagement` for the target page.
5. `cp .env.example .env` and fill in `OPENAI_API_KEY`, the Google Drive auth from step 3,
   and `FB_PAGE_ACCESS_TOKEN`.

## Usage

```bash
# Preview the picked content and generated text without posting anything
python post_to_facebook.py image --dry-run
python post_to_facebook.py video --dry-run
python post_to_facebook.py question --dry-run

# Actually post
python post_to_facebook.py image
python post_to_facebook.py video
python post_to_facebook.py question
```

Run it manually whenever you want a new post, or use Alfred Studio's GitHub Actions
scheduler described in [STUDIO.md](STUDIO.md).

Videos are picked from `DRIVE_FOLDER_ID_VIDEO`; anything 50MB or larger is skipped
(matching the n8n workflow's size filter) since the direct Graph API upload used here
isn't chunked.

Question posts pick a random Google Form from `DRIVE_FOLDER_ID_QUESTIONS`, fetch its
questions via the Forms API, and keep only questions that have an attached image
(matching the n8n workflow's filter). If the form picked has none, it retries with a
different random form (up to 10 tries) before giving up. The chosen question's image is
posted straight from its Google-hosted URL — it's never downloaded locally, since that's
how the n8n workflow did it too.

## Local ad-image utilities

Install the optional dependencies with `pip install -r requirements-ads.txt`.

- `python ads_image_pilot.py` generates sample ads through the OpenAI Images API
  using the existing `.env` configuration and saves them to `ad_pilot_output/`.
  Review the generated Hebrew text before using an image.
- `python create_ad.py` composes a teacher ad from
  `drive_inspect/teacher_candidate_2.jpg` and `drive_inspect/logo_candidate.jpg`.
- `python create_ad_product.py` composes a course ad from
  `drive_inspect/course_success_3.jpg` and the same logo.

The two composition scripts read local assets and save PNGs to `ads_output/`.
They default to the macOS Hebrew font at `/System/Library/Fonts/SFHebrew.ttf`;
adjust `HEBREW_FONT_BOLD` for another system. Local assets and generated images
are ignored by Git. These utilities do not publish posts or change posting history.
