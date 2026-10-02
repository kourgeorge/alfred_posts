"""CLI entry point: pick source content for the chosen post type, write a Hebrew
Facebook post for it with an LLM, and publish it to a Facebook Page.

Python port of AlfredPostFBImageMain.json (image), AlfredFBPostVideoMain.json
(video), and AlfredPostFBQuestionMain.json + GetRandomQuestionfromGoogleForm.json
(question). See config.py, drive.py, facebook.py, and content.py for the pieces.
"""

import argparse
import sys

import content
import drive
import facebook
import history
from config import Config, WorkflowError


def _print_text(post_text: str) -> None:
    print("\nGenerated post text:\n" + "-" * 40)
    print(post_text)
    print("-" * 40 + "\n")


def run_image(config: Config, dry_run: bool) -> None:
    post_history = history.load()
    chosen = drive.pick_image(config, posted_ids=set(post_history["image"]))
    print(f"Selected image: {chosen['id']} — {chosen['name']}")

    post_text = content.generate_image_post_text(config, chosen["id"], chosen["name"])
    _print_text(post_text)
    if dry_run:
        print("Dry run — stopping before download/post.")
        return

    image_bytes = drive.download_drive_file(config, chosen["id"])
    result = facebook.post_photo_to_page(config, image_bytes, post_text)
    print(f"Posted to Facebook. ID: {result.get('id')}, Post ID: {result.get('post_id')}")
    history.record(post_history, "image", chosen["id"])


def run_video(config: Config, dry_run: bool) -> None:
    post_history = history.load()
    chosen = drive.pick_video(config, posted_ids=set(post_history["video"]))
    print(f"Selected video: {chosen['id']} — {chosen['name']}")

    post_text = content.generate_video_post_text(config, chosen["name"])
    _print_text(post_text)
    if dry_run:
        print("Dry run — stopping before download/post.")
        return

    video_bytes = drive.download_drive_file(config, chosen["id"])
    result = facebook.post_video_to_page(config, video_bytes, post_text)
    print(f"Posted to Facebook. ID: {result.get('id')}, Post ID: {result.get('post_id')}")
    history.record(post_history, "video", chosen["id"])


def run_question(config: Config, dry_run: bool) -> None:
    post_history = history.load()
    question = drive.pick_question(config, posted_ids=set(post_history["question"]))
    print(f"Selected question from \"{question['form_title']}\": {question['question']['text']}")

    post_text = content.generate_question_post_text(config, question)
    _print_text(post_text)
    if dry_run:
        print("Dry run — stopping before post.")
        return

    result = facebook.post_photo_url_to_page(config, question["question"]["image"], post_text)
    print(f"Posted to Facebook. ID: {result.get('id')}, Post ID: {result.get('post_id')}")
    history.record(post_history, "question", drive.question_key(question))


RUNNERS = {"image": run_image, "video": run_video, "question": run_question}


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("post_type", choices=sorted(RUNNERS), help="What to post.")
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Pick content and generate post text, but don't download or post to Facebook.",
    )
    args = parser.parse_args()

    config = Config.from_env()
    RUNNERS[args.post_type](config, args.dry_run)


if __name__ == "__main__":
    try:
        main()
    except WorkflowError as exc:
        print(f"Error: {exc}", file=sys.stderr)
        sys.exit(1)
