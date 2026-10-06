"""Facebook Graph API publishing."""

import requests

from config import Config, WorkflowError


def post_link_to_page(config: Config, link: str, message: str) -> dict:
    """Share the publisher's article/video and its Facebook link preview."""
    response = requests.post(
        f"https://graph.facebook.com/{config.fb_graph_version}/{config.fb_page_id}/feed",
        data={"message": message, "link": link, "access_token": config.fb_page_access_token}, timeout=60,
    )
    if not response.ok:
        raise WorkflowError(f"Facebook post failed ({response.status_code}): {response.text}")
    return response.json()


def post_photo_to_page(config: Config, image_bytes: bytes, message: str) -> dict:
    """Publish a photo post from raw bytes (used for images downloaded from Drive)."""
    url = f"https://graph.facebook.com/{config.fb_graph_version}/{config.fb_page_id}/photos"
    response = requests.post(
        url,
        data={
            "message": message,
            "access_token": config.fb_page_access_token,
        },
        files={"source": ("image.jpg", image_bytes)},
        timeout=60,
    )
    if not response.ok:
        raise WorkflowError(f"Facebook post failed ({response.status_code}): {response.text}")
    return response.json()


def post_photo_url_to_page(config: Config, image_url: str, message: str) -> dict:
    """Publish a photo post by URL (used for question images, which live on
    Google's forms CDN rather than in our own Drive folder)."""
    url = f"https://graph.facebook.com/{config.fb_graph_version}/{config.fb_page_id}/photos"
    response = requests.post(
        url,
        data={
            "url": image_url,
            "message": message,
            "access_token": config.fb_page_access_token,
        },
        timeout=60,
    )
    if not response.ok:
        raise WorkflowError(f"Facebook post failed ({response.status_code}): {response.text}")
    return response.json()


def post_video_to_page(config: Config, video_bytes: bytes, message: str) -> dict:
    url = f"https://graph-video.facebook.com/{config.fb_graph_version}/{config.fb_page_id}/videos"
    response = requests.post(
        url,
        data={
            "description": message,
            "access_token": config.fb_page_access_token,
        },
        files={"source": ("video.mp4", video_bytes)},
        timeout=300,
    )
    if not response.ok:
        raise WorkflowError(f"Facebook video post failed ({response.status_code}): {response.text}")
    return response.json()
