#!/usr/bin/env python3
"""OpenClaw media gateway helpers for Lobster Stage 4 generation.

This module keeps OAuth/subscription-backed provider handling out of Aries. Aries
sends media tool requests to the OpenClaw gateway, then copies a returned media
locator into the existing Lobster artifact paths.
"""

from __future__ import annotations

import json
import os
import re
import shutil
import tempfile
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any

TRUE_VALUES = {"1", "true", "yes", "on"}
IMAGE_EXTENSIONS = {".png", ".jpg", ".jpeg", ".webp", ".gif"}
VIDEO_EXTENSIONS = {".mp4", ".mov", ".webm", ".m4v"}
DEFAULT_TIMEOUT_SECONDS = 300
MAX_MEDIA_BYTES = 200 * 1024 * 1024


class MediaGatewayError(RuntimeError):
    """Safe, redacted media gateway failure."""


def env_bool(name: str, default: bool = False) -> bool:
    raw = os.environ.get(name)
    if raw is None:
        return default
    return raw.strip().lower() in TRUE_VALUES


def media_gateway_configured() -> bool:
    return bool(os.environ.get("OPENCLAW_GATEWAY_URL", "").strip() and os.environ.get("OPENCLAW_GATEWAY_TOKEN", "").strip())


def media_gateway_requested() -> bool:
    return env_bool("LOBSTER_MEDIA_GATEWAY_ENABLED")


def media_gateway_enabled() -> bool:
    return media_gateway_requested() and media_gateway_configured()


def strict_gateway_mode() -> bool:
    # Production should fail closed whenever gateway mode is explicitly
    # requested, including misconfiguration where URL/token are missing. A
    # separate escape hatch exists for local development.
    if not media_gateway_requested():
        return False
    return not env_bool("LOBSTER_MEDIA_GATEWAY_ALLOW_DIRECT_FALLBACK")


def _candidate_secret_values() -> list[str]:
    names = [
        "OPENCLAW_GATEWAY_TOKEN",
        "GEMINI_API_KEY",
        "OPENAI_API_KEY",
        "ANTHROPIC_API_KEY",
        "GOOGLE_API_KEY",
    ]
    values = []
    for name in names:
        value = os.environ.get(name, "").strip()
        if value:
            values.append(value)
    return values


def redact_sensitive(value: Any, prompt: str | None = None) -> str:
    text = value if isinstance(value, str) else json.dumps(value, sort_keys=True, default=str)
    for secret in _candidate_secret_values():
        if secret:
            text = text.replace(secret, "[REDACTED_SECRET]")
    if prompt and prompt.strip():
        text = text.replace(prompt.strip(), "[REDACTED_PROMPT]")
    # Redact common signed URL query strings and bearer-ish parameters.
    text = re.sub(r"([?&](?:X-Goog-[^=&]+|X-Amz-[^=&]+|token|signature|sig|key|access_token)=)[^\s&]+", r"\1[REDACTED]", text, flags=re.IGNORECASE)
    text = re.sub(r"Bearer\s+[A-Za-z0-9._~+/=-]+", "Bearer [REDACTED]", text, flags=re.IGNORECASE)
    return text


def _gateway_url() -> str:
    base = os.environ.get("OPENCLAW_GATEWAY_URL", "").strip().rstrip("/")
    if not base:
        raise MediaGatewayError("media_gateway_unconfigured:OPENCLAW_GATEWAY_URL_missing")
    return f"{base}/tools/invoke"


def _gateway_token() -> str:
    token = os.environ.get("OPENCLAW_GATEWAY_TOKEN", "").strip()
    if not token:
        raise MediaGatewayError("media_gateway_unconfigured:OPENCLAW_GATEWAY_TOKEN_missing")
    return token


def invoke_media_tool(tool: str, args: dict[str, Any], *, prompt: str | None = None, timeout_seconds: int | None = None) -> dict[str, Any]:
    payload = {
        "tool": tool,
        "sessionKey": os.environ.get("OPENCLAW_SESSION_KEY", "lobster-media").strip() or "lobster-media",
        "args": args,
    }
    request = urllib.request.Request(
        _gateway_url(),
        data=json.dumps(payload).encode("utf-8"),
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {_gateway_token()}",
        },
        method="POST",
    )
    timeout = timeout_seconds or int(os.environ.get("LOBSTER_MEDIA_GATEWAY_TIMEOUT_SECONDS", str(DEFAULT_TIMEOUT_SECONDS)))
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            raw = response.read().decode("utf-8", errors="replace")
    except urllib.error.HTTPError as exc:
        body = exc.read().decode("utf-8", errors="replace")
        raise MediaGatewayError(f"media_gateway_http_error:{exc.code}:{redact_sensitive(body, prompt=prompt)[:500]}") from exc
    except Exception as exc:  # noqa: BLE001
        raise MediaGatewayError(f"media_gateway_unreachable:{type(exc).__name__}:{redact_sensitive(str(exc), prompt=prompt)[:300]}") from exc

    try:
        body = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise MediaGatewayError(f"media_gateway_invalid_json:{redact_sensitive(raw, prompt=prompt)[:300]}") from exc

    if not body.get("ok"):
        raise MediaGatewayError(f"media_gateway_error:{redact_sensitive(body.get('error') or body, prompt=prompt)[:500]}")
    result = body.get("result")
    if not isinstance(result, dict):
        raise MediaGatewayError("media_gateway_invalid_response:missing_result")
    details = result.get("details")
    if isinstance(details, dict):
        return details
    return result


def _allowed_roots() -> list[Path]:
    raw = os.environ.get("LOBSTER_MEDIA_GATEWAY_SHARED_ROOTS", "").strip()
    if raw:
        return [Path(part).expanduser().resolve() for part in raw.split(os.pathsep) if part.strip()]
    # Permit the system temp dir by default for local same-host gateways and tests.
    return [Path(tempfile.gettempdir()).resolve()]


def _is_under(path: Path, root: Path) -> bool:
    try:
        path.relative_to(root)
        return True
    except ValueError:
        return False


def _validate_local_media_path(source: Path, expected_kind: str) -> None:
    resolved = source.expanduser().resolve()
    if not any(_is_under(resolved, root) for root in _allowed_roots()):
        raise MediaGatewayError("unsafe_media_path:outside_allowed_roots")
    if not resolved.exists() or not resolved.is_file():
        raise MediaGatewayError("missing_media_path")
    if resolved.stat().st_size <= 0:
        raise MediaGatewayError("empty_media")
    suffixes = IMAGE_EXTENSIONS if expected_kind == "image" else VIDEO_EXTENSIONS
    if resolved.suffix.lower() not in suffixes:
        raise MediaGatewayError(f"unexpected_media_extension:{resolved.suffix}")


def _write_atomic(destination: Path, data: bytes) -> None:
    if not data:
        raise MediaGatewayError("empty_media")
    destination.parent.mkdir(parents=True, exist_ok=True)
    fd, temp_name = tempfile.mkstemp(prefix=f".{destination.name}.", suffix=".tmp", dir=str(destination.parent))
    try:
        with os.fdopen(fd, "wb") as handle:
            handle.write(data)
        Path(temp_name).replace(destination)
    except Exception:
        try:
            Path(temp_name).unlink(missing_ok=True)
        finally:
            raise


def _download_media(url: str, expected_kind: str) -> bytes:
    parsed = urllib.parse.urlparse(url)
    if parsed.scheme != "https":
        raise MediaGatewayError("unsafe_media_url:scheme_must_be_https")
    allowed_hosts = {host.strip().lower() for host in os.environ.get("LOBSTER_MEDIA_GATEWAY_ALLOWED_HOSTS", "").split(",") if host.strip()}
    if allowed_hosts and (parsed.hostname or "").lower() not in allowed_hosts:
        raise MediaGatewayError("unsafe_media_url:host_not_allowed")
    req = urllib.request.Request(url, method="GET")
    with urllib.request.urlopen(req, timeout=300) as response:
        content_type = response.headers.get("content-type", "").split(";", 1)[0].strip().lower()
        if expected_kind == "image" and content_type and not content_type.startswith("image/"):
            raise MediaGatewayError(f"unexpected_media_content_type:{content_type}")
        if expected_kind == "video" and content_type and not content_type.startswith("video/") and content_type != "application/octet-stream":
            raise MediaGatewayError(f"unexpected_media_content_type:{content_type}")
        data = response.read(MAX_MEDIA_BYTES + 1)
    if len(data) > MAX_MEDIA_BYTES:
        raise MediaGatewayError("media_too_large")
    if not data:
        raise MediaGatewayError("empty_media")
    return data


def copy_gateway_media_to_destination(locator: str, destination: Path, *, expected_kind: str) -> None:
    cleaned = (locator or "").strip()
    if cleaned.startswith("MEDIA:"):
        cleaned = cleaned[len("MEDIA:") :].strip()
    if not cleaned:
        raise MediaGatewayError("missing_media_locator")
    parsed = urllib.parse.urlparse(cleaned)
    if parsed.scheme in {"http", "https"}:
        _write_atomic(destination, _download_media(cleaned, expected_kind))
        return
    if parsed.scheme and parsed.scheme != "file":
        raise MediaGatewayError(f"unsupported_media_locator:{parsed.scheme}")
    local_path = Path(urllib.request.url2pathname(parsed.path) if parsed.scheme == "file" else cleaned)
    _validate_local_media_path(local_path, expected_kind)
    destination.parent.mkdir(parents=True, exist_ok=True)
    # Copy via temp then replace to avoid partial artifacts.
    fd, temp_name = tempfile.mkstemp(prefix=f".{destination.name}.", suffix=".tmp", dir=str(destination.parent))
    os.close(fd)
    try:
        shutil.copyfile(local_path.resolve(), temp_name)
        if Path(temp_name).stat().st_size <= 0:
            raise MediaGatewayError("empty_media")
        Path(temp_name).replace(destination)
    except Exception:
        Path(temp_name).unlink(missing_ok=True)
        raise


def _iter_strings(value: Any):
    if isinstance(value, str):
        yield value
    elif isinstance(value, list):
        for item in value:
            yield from _iter_strings(item)
    elif isinstance(value, dict):
        for key in ("url", "uri", "path", "mediaUrl", "media_url", "downloadUrl", "download_url"):
            if isinstance(value.get(key), str):
                yield value[key]
        for item in value.values():
            yield from _iter_strings(item)


def extract_media_locator(result: dict[str, Any], *, expected_kind: str) -> str:
    preferred_containers = [
        result.get("media"),
        result.get("paths"),
        result.get("path"),
        result.get("mediaUrls"),
        result.get("media_urls"),
        result.get("content"),
        result,
    ]
    for container in preferred_containers:
        for candidate in _iter_strings(container):
            cleaned = candidate.strip()
            if not cleaned:
                continue
            if "MEDIA:" in cleaned:
                cleaned = cleaned[cleaned.index("MEDIA:") :].splitlines()[0]
            suffix = Path(urllib.parse.urlparse(cleaned.replace("MEDIA:", "")).path).suffix.lower()
            if expected_kind == "image" and (cleaned.startswith(("MEDIA:", "https://", "file://", "/")) or suffix in IMAGE_EXTENSIONS):
                return cleaned
            if expected_kind == "video" and (cleaned.startswith(("MEDIA:", "https://", "file://", "/")) or suffix in VIDEO_EXTENSIONS):
                return cleaned
    raise MediaGatewayError("missing_media_locator")


def generate_image(prompt: str, destination: Path, *, aspect_ratio: str) -> dict[str, Any]:
    args = {
        "prompt": prompt,
        "aspect_ratio": aspect_ratio,
        "aspectRatio": aspect_ratio,
        "resolution": os.environ.get("LOBSTER_IMAGE_RESOLUTION", "1K"),
    }
    result = invoke_media_tool("image_generate", args, prompt=prompt, timeout_seconds=300)
    locator = extract_media_locator(result, expected_kind="image")
    copy_gateway_media_to_destination(locator, destination, expected_kind="image")
    return {
        "executed": True,
        "status": "ok" if destination.exists() else "error",
        "stdout": "",
        "stderr": "",
        "returncode": 0,
        "command": ["openclaw", "image_generate"],
        "output_path": str(destination),
        "provider": "openclaw_media_gateway",
        "gateway_tool": "image_generate",
    }


def generate_video(prompt: str, destination: Path, *, aspect_ratio: str, duration_seconds: int, model: str | None = None) -> dict[str, Any]:
    args = {
        "prompt": prompt,
        "aspect_ratio": aspect_ratio,
        "aspectRatio": aspect_ratio,
        "duration_seconds": duration_seconds,
        "durationSeconds": duration_seconds,
    }
    if model:
        args["model"] = model
    result = invoke_media_tool("video_generate", args, prompt=prompt, timeout_seconds=int(os.environ.get("LOBSTER_VIDEO_GATEWAY_TIMEOUT_SECONDS", "900")))
    locator = extract_media_locator(result, expected_kind="video")
    copy_gateway_media_to_destination(locator, destination, expected_kind="video")
    return {
        "executed": True,
        "status": "ok" if destination.exists() else "error",
        "stdout": "",
        "stderr": "",
        "returncode": 0,
        "command": ["openclaw", "video_generate"],
        "output_path": str(destination),
        "provider": "openclaw_media_gateway",
        "gateway_tool": "video_generate",
    }
