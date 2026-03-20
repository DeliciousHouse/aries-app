#!/usr/bin/env python3
import json
import os
import re
import sys
import tempfile
import urllib.parse
import urllib.request
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from _canonical_outputs import write_stage_log


def utc_now() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat()


def read_stdin_json() -> Any:
    raw = sys.stdin.read().strip()
    if not raw:
        return {}
    try:
        return json.loads(raw)
    except json.JSONDecodeError as exc:
        raise SystemExit(f"invalid JSON on stdin: {exc}") from exc


def emit_json(payload: Any) -> None:
    json.dump(payload, sys.stdout, indent=2, sort_keys=True)
    sys.stdout.write("\n")


def slugify(value: str) -> str:
    slug = re.sub(r"[^a-z0-9]+", "-", (value or "").lower()).strip("-")
    return slug or "client-brand"


def make_run_id(seed: str) -> str:
    return f"{slugify(seed)}-{uuid.uuid4().hex[:8]}"


def ensure_run_id(existing_run_id: str, *seeds: str) -> str:
    cleaned = (existing_run_id or "").strip()
    if cleaned:
        return cleaned
    for seed in seeds:
        if (seed or "").strip():
            return make_run_id(seed)
    return make_run_id("stage2")


def cache_root() -> Path:
    root = Path(os.environ.get("LOBSTER_STAGE2_CACHE_DIR", Path(tempfile.gettempdir()) / "lobster-stage2-cache"))
    root.mkdir(parents=True, exist_ok=True)
    return root


def run_dir(run_id: str) -> Path:
    path = cache_root() / run_id
    path.mkdir(parents=True, exist_ok=True)
    return path


def save_step(run_id: str, step_name: str, payload: Any) -> None:
    path = run_dir(run_id) / f"{step_name}.json"
    path.write_text(json.dumps(payload, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    write_stage_log(run_id, "stage-2-strategy", step_name, payload)


def load_step(run_id: str, step_name: str) -> Any:
    path = run_dir(run_id) / f"{step_name}.json"
    if not path.exists():
        return None
    return json.loads(path.read_text(encoding="utf-8"))


def normalize_research_model(model: str) -> str:
    trimmed = (model or "").strip()
    return trimmed or "gemini/gemini-3-flash-preview"


def gemini_api_model_name(model: str) -> str:
    normalized = normalize_research_model(model)
    if "/" in normalized:
        _provider, model_name = normalized.split("/", 1)
        return model_name
    return normalized


def parse_domain(url: str) -> str:
    if not url:
        return ""
    parsed = urllib.parse.urlparse(url)
    return (parsed.netloc or "").lower().removeprefix("www.")


def fetch_text(url: str, timeout: float = 20.0, headers: dict[str, str] | None = None) -> str:
    req = urllib.request.Request(url, headers=headers or {})
    with urllib.request.urlopen(req, timeout=timeout) as response:
        return response.read().decode("utf-8", errors="replace")


def summarize_with_gemini(prompt: str, research_model: str) -> dict[str, Any]:
    api_key = os.environ.get("GEMINI_API_KEY", "").strip()
    model_name = gemini_api_model_name(research_model)
    if not api_key:
        return {
            "live": False,
            "provider": "gemini",
            "model": model_name,
            "text": "",
            "error": "GEMINI_API_KEY not set",
        }
    body = {
        "contents": [
            {
                "role": "user",
                "parts": [{"text": prompt}],
            }
        ]
    }
    url = (
        f"https://generativelanguage.googleapis.com/v1beta/models/{urllib.parse.quote(model_name)}:"
        f"generateContent?key={urllib.parse.quote(api_key)}"
    )
    try:
        req = urllib.request.Request(
            url,
            data=json.dumps(body).encode("utf-8"),
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        with urllib.request.urlopen(req, timeout=30.0) as response:
            parsed = json.loads(response.read().decode("utf-8", errors="replace"))
        candidates = parsed.get("candidates", [])
        if not candidates:
            return {
                "live": False,
                "provider": "gemini",
                "model": model_name,
                "text": "",
                "error": "empty candidates",
            }
        parts = candidates[0].get("content", {}).get("parts", [])
        text = "\n".join(part.get("text", "") for part in parts if part.get("text"))
        return {"live": True, "provider": "gemini", "model": model_name, "text": text.strip(), "error": ""}
    except Exception as exc:
        return {
            "live": False,
            "provider": "gemini",
            "model": model_name,
            "text": "",
            "error": f"{type(exc).__name__}: {exc}",
        }


def mock_brand_profile_store_path() -> Path:
    return cache_root() / "mock_brand_profiles.json"


def upsert_mock_brand_profile(record: dict[str, Any]) -> dict[str, Any]:
    path = mock_brand_profile_store_path()
    if path.exists():
        try:
            store = json.loads(path.read_text(encoding="utf-8"))
        except json.JSONDecodeError:
            store = {}
    else:
        store = {}
    slug = slugify(record.get("brand_slug", "client-brand"))
    existing = store.get(slug, {})
    revision = int(existing.get("revision", 0)) + 1
    stored = {**existing, **record, "brand_slug": slug, "revision": revision, "updated_at": utc_now()}
    if not existing:
        stored["created_at"] = stored["updated_at"]
    else:
        stored["created_at"] = existing.get("created_at", stored["updated_at"])
    store[slug] = stored
    path.write_text(json.dumps(store, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    return stored
