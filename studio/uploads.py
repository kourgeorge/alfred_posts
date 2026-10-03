"""Read immutable uploads from the private state branch, outside state.json."""
import hashlib
import io
import json
import math
import re

from PIL import Image

CHUNK_SIZE = 2 * 1024 * 1024
LIMITS = {"image": 10 * 1024 * 1024, "video": 50 * 1024 * 1024}
FORMATS = {"image/jpeg": ("image", ("jpg", "jpeg")), "image/png": ("image", ("png",)),
           "image/webp": ("image", ("webp",)), "video/mp4": ("video", ("mp4",)),
           "video/quicktime": ("video", ("mov",))}
ID_PATTERN = r"[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}"


def validate_id(value):
    if not isinstance(value, str) or not re.fullmatch(ID_PATTERN, value):
        raise ValueError("Choose a valid uploaded file.")
    return value


def validate_description(value):
    if not isinstance(value, str) or not 1 <= len(value.strip()) <= 2000:
        raise ValueError("Describe your image or video in 1–2,000 characters.")
    return value.strip()


def validate_manifest(item, upload_id):
    if not isinstance(item, dict) or item.get("id") != validate_id(upload_id):
        raise ValueError("The uploaded file details are invalid. Upload the file again.")
    name, kind, mime, size = (item.get(k) for k in ("name", "type", "mime", "size"))
    fmt = FORMATS.get(mime)
    if (not fmt or fmt[0] != kind or not isinstance(name, str) or not 1 <= len(name) <= 180
            or re.search(r"[\x00-\x1f/\\]", name) or name.rsplit(".", 1)[-1].lower() not in fmt[1]):
        raise ValueError("Use a JPG, PNG, WebP, MP4, or MOV file.")
    if type(size) is not int or not 0 < size <= LIMITS[kind]:
        raise ValueError("Images must be under 10 MB and videos under 50 MB.")
    if type(item.get("parts")) is not int or item["parts"] != math.ceil(size / CHUNK_SIZE):
        raise ValueError("The upload is incomplete. Upload the file again.")
    if not isinstance(item.get("sha256"), str) or not re.fullmatch(r"[0-9a-f]{64}", item["sha256"]):
        raise ValueError("The uploaded file checksum is invalid.")
    return item


class Uploads:
    def __init__(self, store):
        self.store = store

    def read(self, upload_id):
        validate_id(upload_id)
        raw = self.store.read_file(f"uploads/{upload_id}/manifest.json", 8192)
        item = validate_manifest(json.loads(raw), upload_id)
        data = bytearray()
        for index in range(item["parts"]):
            part = self.store.read_file(f"uploads/{upload_id}/part-{index:02d}.bin", CHUNK_SIZE)
            expected = min(CHUNK_SIZE, item["size"] - index * CHUNK_SIZE)
            if len(part) != expected:
                raise ValueError("The upload is incomplete. Upload the file again.")
            data.extend(part)
        if hashlib.sha256(data).hexdigest() != item["sha256"]:
            raise ValueError("The uploaded file changed. Upload the original file again.")
        return item, bytes(data)


def validate_media(item, data):
    if item["type"] == "image":
        try:
            with Image.open(io.BytesIO(data)) as image:
                if Image.MIME.get(image.format) != item["mime"] or getattr(image, "n_frames", 1) != 1:
                    raise ValueError("Choose a still JPG, PNG, or WebP image.")
                image.verify()
        except (OSError, Image.DecompressionBombError):
            raise ValueError("This image could not be opened. Choose a valid JPG, PNG, or WebP file.") from None
    else:
        # Check the container signature only. No frames or audio go to the AI.
        brand = data[8:12]
        brands = (b"qt  ",) if item["mime"] == "video/quicktime" else (b"isom", b"iso2", b"iso4", b"iso5", b"iso6", b"mp41", b"mp42", b"avc1", b"M4V ", b"MSNV")
        if len(data) < 32 or data[4:8] != b"ftyp" or brand not in brands:
            raise ValueError("Choose a valid MP4 or MOV video.")
