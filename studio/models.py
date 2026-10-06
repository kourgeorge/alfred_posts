"""Model discovery in server-side JavaScript, and one private Studio setting."""
from dataclasses import replace
import json
from pathlib import Path
import re
import subprocess


def fetch_models(model=None):
    args = ["node", str(Path(__file__).resolve().parents[1] / "scripts/openai-models.mjs")]
    if model is not None:
        args.append(model)
    try:
        result = subprocess.run(args, capture_output=True, text=True, timeout=100, check=True)
        return json.loads(result.stdout)
    except (OSError, subprocess.SubprocessError, ValueError):
        raise ValueError("OpenAI model request failed. Check your API key, model access and billing, then try again.") from None


def save_model(store, command):
    model, revision = command.get("model"), command.get("revision")
    if not isinstance(model, str) or not re.fullmatch(r"[a-zA-Z0-9._-]{1,150}", model):
        raise ValueError("Choose a model from the refreshed OpenAI list.")

    def check(state):
        if type(revision) is not int or revision != state.get("ai_settings", {}).get("revision", 0):
            raise ValueError("The model changed in another session. Discard your change and choose again.")

    check(store.read()[0])
    catalog = fetch_models(model)  # Fresh availability and a small caption-endpoint check.

    def save(state):
        check(state)
        state["ai_settings"] = {"model": model, "revision": revision + 1}
        state["model_catalog"] = catalog
    return store.change(save)


def apply_model(config, state):
    model = state.get("ai_settings", {}).get("model")
    if not model:
        return config  # Preserve existing installations until the user saves a choice.
    return replace(config, openai_model_image=model, openai_model_video=model, openai_model_question=model)
