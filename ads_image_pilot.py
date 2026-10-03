"""Pilot: can gpt-image-1 alone produce appealing ad images for Alfred Kour's
driving-theory course, including correct Hebrew text baked into the image?

Standalone and local-only — does not touch Facebook, Drive, or history. Saves a
few sample ads to ./ad_pilot_output/ for manual review.

Usage:
    python ads_image_pilot.py
"""

import base64
from pathlib import Path

from openai import OpenAI

from config import Config

OUTPUT_DIR = Path("ad_pilot_output")

PROMPTS = {
    "no_text_scene": (
        "A bright, modern advertisement photo for an online driving-theory course "
        "in Israel. A friendly male driving instructor in his 40s sits confidently "
        "behind the wheel of a car, smiling at the camera. Clean, professional, "
        "warm afternoon light, shallow depth of field, high-end social media ad "
        "photography style. Leave clear empty space at the top third of the image "
        "for a headline to be added later. No text, no logos, no watermarks."
    ),
    "with_hebrew_text": (
        "A polished Facebook advertisement graphic for an online Israeli "
        "driving-theory course. Bold modern layout, a smiling driving instructor "
        "next to a car, blue and white color scheme. At the top, large bold "
        "Hebrew headline text that reads exactly: 'עברו את מבחן התיאוריה בפעם "
        "הראשונה'. Below it, smaller Hebrew text that reads exactly: "
        "'קורס אונליין עם אלפרד קור'. Clean sans-serif typography, correctly "
        "spelled Hebrew, professional ad design, no extra gibberish text."
    ),
}


def main() -> None:
    config = Config.from_env()
    client = OpenAI(api_key=config.openai_api_key)
    OUTPUT_DIR.mkdir(exist_ok=True)

    for name, prompt in PROMPTS.items():
        print(f"Generating: {name}")
        result = client.images.generate(
            model="gpt-image-1",
            prompt=prompt,
            size="1024x1536",
            quality="high",
            n=1,
        )
        image_bytes = base64.b64decode(result.data[0].b64_json)
        out_path = OUTPUT_DIR / f"{name}.png"
        out_path.write_bytes(image_bytes)
        print(f"  saved -> {out_path}")

    print("\nDone. Open ad_pilot_output/ and check the Hebrew text closely for errors.")


if __name__ == "__main__":
    main()
