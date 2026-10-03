"""Compose a Facebook ad for the COURSE PRODUCT itself (not the teacher),
using a real photo of a happy student who just passed the test plus the real
course logo. Same recipe as create_ad.py: a fresh Hebrew headline rendered
locally with Pillow (correct spelling guaranteed) on a brand-colored banner,
with the real photo and real logo pasted in unchanged.

Standalone and local-only — does not touch Facebook or Drive history. Saves
the result to ./ads_output/.

Usage:
    python create_ad_product.py
"""

from pathlib import Path

from bidi.algorithm import get_display
from PIL import Image, ImageDraw, ImageFont

PHOTO_PATH = Path("drive_inspect/course_success_3.jpg")
LOGO_PATH = Path("drive_inspect/logo_candidate.jpg")
OUTPUT_DIR = Path("ads_output")

HEBREW_FONT_BOLD = "/System/Library/Fonts/SFHebrew.ttf"

BRAND_TEAL = (117, 191, 178)
BANNER_HEIGHT = 300
LOGO_WIDTH = 150

HEADLINE = "קורס תיאוריה דיגיטלי מההתחלה ועד ההצלחה"
SUBLINE = "לומדים בכל מקום ובכל זמן, בקצב שלכם"


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
    headline_font = ImageFont.truetype(HEBREW_FONT_BOLD, 38)
    subline_font = ImageFont.truetype(HEBREW_FONT_BOLD, 32)

    logo_reserved = LOGO_WIDTH + 40
    text_center_x = (canvas_width - logo_reserved) // 2
    _draw_centered_rtl(draw, HEADLINE, headline_font, text_center_x, 100, fill=(255, 255, 255))
    _draw_centered_rtl(draw, SUBLINE, subline_font, text_center_x, 195, fill=(255, 255, 255))

    out_path = OUTPUT_DIR / "ad_course_product.png"
    canvas.save(out_path)
    print(f"Saved -> {out_path} ({canvas.size[0]}x{canvas.size[1]})")


if __name__ == "__main__":
    main()
