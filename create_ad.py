"""Compose a Facebook ad image from the REAL brand assets in Google Drive
(a real photo of Alfred Kour + the real course logo) instead of AI-generated
imagery. Adds a fresh Hebrew headline rendered locally with Pillow, so the
text is always spelled correctly (no AI hallucination risk).

Standalone and local-only — does not touch Facebook or Drive history. Saves
the result to ./ads_output/.

Usage:
    python create_ad.py
"""

from pathlib import Path

from bidi.algorithm import get_display
from PIL import Image, ImageDraw, ImageFont

PHOTO_PATH = Path("drive_inspect/teacher_candidate_2.jpg")
LOGO_PATH = Path("drive_inspect/logo_candidate.jpg")
OUTPUT_DIR = Path("ads_output")

HEBREW_FONT_BOLD = "/System/Library/Fonts/SFHebrew.ttf"

BRAND_TEAL = (117, 191, 178)
BANNER_HEIGHT = 300
LOGO_WIDTH = 150

HEADLINE = "השאלה הכי חשובה במבחן התיאוריה"
SUBLINE = "יש לה תשובה אחת נכונה. בואו נלמד אותה ביחד"


def _rtl(text: str) -> str:
    return get_display(text)


def _draw_centered_rtl(draw: ImageDraw.ImageDraw, text: str, font: ImageFont.FreeTypeFont, center_x: int, y: int, fill) -> None:
    visual = _rtl(text)
    bbox = draw.textbbox((0, 0), visual, font=font)
    width = bbox[2] - bbox[0]
    draw.text((center_x - width / 2, y), visual, font=font, fill=fill)


def main() -> None:
    OUTPUT_DIR.mkdir(exist_ok=True)

    photo = Image.open(PHOTO_PATH).convert("RGB")
    logo = Image.open(LOGO_PATH).convert("RGB")

    canvas_width = photo.width
    canvas = Image.new("RGB", (canvas_width, BANNER_HEIGHT + photo.height), BRAND_TEAL)
    canvas.paste(photo, (0, BANNER_HEIGHT))

    logo_ratio = LOGO_WIDTH / logo.width
    logo_small = logo.resize((LOGO_WIDTH, int(logo.height * logo_ratio)))
    canvas.paste(logo_small, (canvas_width - LOGO_WIDTH - 20, 20))

    draw = ImageDraw.Draw(canvas)
    headline_font = ImageFont.truetype(HEBREW_FONT_BOLD, 56)
    subline_font = ImageFont.truetype(HEBREW_FONT_BOLD, 36)

    logo_reserved = LOGO_WIDTH + 40
    text_center_x = (canvas_width - logo_reserved) // 2
    _draw_centered_rtl(draw, HEADLINE, headline_font, text_center_x, 100, fill=(255, 255, 255))
    _draw_centered_rtl(draw, SUBLINE, subline_font, text_center_x, 195, fill=(255, 255, 255))

    out_path = OUTPUT_DIR / "ad_alfred_teacher_2.png"
    canvas.save(out_path)
    print(f"Saved -> {out_path} ({canvas.size[0]}x{canvas.size[1]})")


if __name__ == "__main__":
    main()
