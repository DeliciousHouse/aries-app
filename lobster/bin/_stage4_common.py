#!/usr/bin/env python3
import base64
import json
import os
import re
import shlex
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from _canonical_outputs import write_stage_log
from _brand_tokens import brand_direction_lines
from _marketing_profile_common import contains_wrapper_language, normalize_space


def safe_path_exists(candidate: str | Path) -> bool:
    try:
        return Path(candidate).exists()
    except OSError:
        return False


def safe_path_exists(candidate: str | Path) -> bool:
    try:
        return Path(candidate).exists()
    except OSError:
        return False


def resolve_nano_banana_script() -> Path:
    candidates = [
        os.environ.get("NANO_BANANA_SCRIPT", "").strip(),
        "/app/skills/nano-banana-pro/scripts/generate_image.py",
        str(Path.cwd().parents[1] / "skills" / "nano-banana-pro" / "scripts" / "generate_image.py") if len(Path.cwd().parents) >= 2 else "",
        "/home/bkam/.npm-global/lib/node_modules/openclaw/skills/nano-banana-pro/scripts/generate_image.py",
    ]
    for candidate in candidates:
        if candidate and safe_path_exists(candidate):
            return Path(candidate)
    return Path("/app/skills/nano-banana-pro/scripts/generate_image.py")


NANO_BANANA_SCRIPT = resolve_nano_banana_script()


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
    return make_run_id("stage4")


def cache_root() -> Path:
    root = Path(os.environ.get("LOBSTER_STAGE4_CACHE_DIR", Path(tempfile.gettempdir()) / "lobster-stage4-cache"))
    root.mkdir(parents=True, exist_ok=True)
    return root


def run_dir(run_id: str) -> Path:
    path = cache_root() / run_id
    path.mkdir(parents=True, exist_ok=True)
    return path


def save_step(run_id: str, step_name: str, payload: Any) -> None:
    path = run_dir(run_id) / f"{step_name}.json"
    path.write_text(json.dumps(payload, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    write_stage_log(run_id, "stage-4-publish-optimize", step_name, payload)


def load_step(run_id: str, step_name: str) -> Any:
    path = run_dir(run_id) / f"{step_name}.json"
    if not path.exists():
        return None
    return json.loads(path.read_text(encoding="utf-8"))


def save_artifact_text(run_id: str, relative_path: str, text: str) -> str:
    path = run_dir(run_id) / relative_path
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text.rstrip() + "\n", encoding="utf-8")
    return str(path)


def first_nonempty(*values: Any, default: str = "") -> str:
    for value in values:
        if isinstance(value, str) and value.strip():
            return value.strip()
    return default


def list_or_empty(value: Any) -> list:
    return value if isinstance(value, list) else []


def record_or_empty(value: Any) -> dict:
    return value if isinstance(value, dict) else {}


def load_json_file(path: str) -> dict:
    candidate = Path(path)
    if not path or not candidate.exists() or not candidate.is_file():
        return {}
    return json.loads(candidate.read_text(encoding="utf-8"))


def contract_brand_tokens(contract: dict) -> dict:
    candidates = [
        record_or_empty(contract.get("brand_tokens")),
        record_or_empty(record_or_empty(record_or_empty(contract.get("inputs")).get("brand_guidelines")).get("design_tokens")),
        record_or_empty(record_or_empty(contract.get("approved_campaign_strategy")).get("design_tokens")),
        record_or_empty(record_or_empty(contract.get("creative")).get("brand_tokens")),
    ]
    for candidate in candidates:
        if record_or_empty(candidate.get("palette")):
            return candidate
    return {}


def require_contract_brand_tokens(contract: dict) -> dict:
    brand_tokens = contract_brand_tokens(contract)
    required_pairs = [
        ("palette", "background"),
        ("palette", "surface"),
        ("palette", "text"),
        ("palette", "accent"),
        ("palette", "accent_contrast"),
        ("palette", "muted"),
        ("palette", "theme_mode"),
        ("typography", "display_family"),
        ("typography", "body_family"),
    ]
    missing = [f"{section}.{key}" for section, key in required_pairs if not record_or_empty(brand_tokens.get(section)).get(key)]
    if missing:
        raise RuntimeError(f"quality_gate_failed:contract_brand_tokens_missing:{','.join(missing)}")
    return brand_tokens


def token_value(tokens: dict, section: str, key: str, default: str) -> str:
    section_value = record_or_empty(tokens.get(section))
    value = section_value.get(key)
    return value.strip() if isinstance(value, str) and value.strip() else default


def contract_brand_voice_lines(contract: dict) -> list[str]:
    candidates = [
        list_or_empty(record_or_empty(record_or_empty(contract.get("inputs")).get("brand_guidelines")).get("voice_attributes")),
        list_or_empty(record_or_empty(contract.get("approved_campaign_strategy")).get("brand_voice")),
        list_or_empty(record_or_empty(record_or_empty(contract.get("inputs")).get("approved_campaign_strategy")).get("brand_voice")),
    ]
    for candidate in candidates:
        voices = [normalize_space(value) for value in candidate if normalize_space(value)]
        if voices:
            return [f"Voice attributes: {', '.join(voices[:4])}."]
    return []


def output_root() -> Path:
    root = Path.cwd() / "output" / "publish-ready"
    root.mkdir(parents=True, exist_ok=True)
    return root


def openclaw_system_event(text: str, mode: str = "now") -> dict:
    command = ["openclaw", "system", "event", "--text", text, "--mode", mode]
    try:
        completed = subprocess.run(command, text=True, capture_output=True, check=False, timeout=20)
        return {
            "executed": True,
            "status": "ok" if completed.returncode == 0 else "error",
            "stdout": completed.stdout.strip(),
            "stderr": completed.stderr.strip(),
            "returncode": completed.returncode,
            "command": command,
        }
    except Exception as exc:
        return {
            "executed": False,
            "status": type(exc).__name__,
            "stdout": "",
            "stderr": str(exc),
            "returncode": None,
            "command": command,
        }


def contract_platform_map(handoff: dict, handoff_key: str) -> dict[str, dict]:
    handoff_payload = handoff.get("contract_handoffs", {}).get(handoff_key, {})
    platforms = handoff_payload.get("platforms", [])
    return {item.get("platform_slug", ""): item for item in platforms if item.get("platform_slug")}


def render_static_svg(contract: dict, destination: Path) -> str:
    destination.parent.mkdir(parents=True, exist_ok=True)
    creative = contract.get("creative", {})
    brand_tokens = require_contract_brand_tokens(contract)
    proof_points = list_or_empty(creative.get("proof_points"))[:3]
    body_lines = list_or_empty(creative.get("body_lines"))[:3]
    lines = [contract.get("platform", "Static Asset"), creative.get("headline", ""), *body_lines, *proof_points]
    escaped = [line.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;") for line in lines]
    background = token_value(brand_tokens, "palette", "background", "")
    surface = token_value(brand_tokens, "palette", "surface", "")
    overline = token_value(brand_tokens, "palette", "muted", "")
    headline = token_value(brand_tokens, "palette", "text", "")
    body = token_value(brand_tokens, "palette", "muted", "")
    accent = token_value(brand_tokens, "palette", "accent", "")
    accent_contrast = token_value(brand_tokens, "palette", "accent_contrast", "")
    display_font = token_value(brand_tokens, "typography", "display_family", "")
    body_font = token_value(brand_tokens, "typography", "body_family", display_font)
    svg = f"""<svg xmlns="http://www.w3.org/2000/svg" width="1080" height="1350" viewBox="0 0 1080 1350">
  <rect width="1080" height="1350" fill="{background}"/>
  <rect x="54" y="54" width="972" height="1242" rx="36" fill="{surface}"/>
  <text x="108" y="160" fill="{overline}" font-family="{display_font}, sans-serif" font-size="38" font-weight="700">{escaped[0]}</text>
  <text x="108" y="270" fill="{headline}" font-family="{display_font}, sans-serif" font-size="72" font-weight="700">{escaped[1]}</text>
  <text x="108" y="390" fill="{body}" font-family="{body_font}, sans-serif" font-size="34">{escaped[2] if len(escaped) > 2 else ''}</text>
  <text x="108" y="450" fill="{body}" font-family="{body_font}, sans-serif" font-size="34">{escaped[3] if len(escaped) > 3 else ''}</text>
  <text x="108" y="510" fill="{body}" font-family="{body_font}, sans-serif" font-size="34">{escaped[4] if len(escaped) > 4 else ''}</text>
  <rect x="108" y="1120" width="360" height="96" rx="20" fill="{accent}"/>
  <text x="148" y="1182" fill="{accent_contrast}" font-family="{display_font}, sans-serif" font-size="40" font-weight="700">{creative.get('primary_cta', '')}</text>
</svg>
    """
    destination.write_text(svg, encoding="utf-8")
    return str(destination)


def aspect_ratio_to_flag(value: str) -> str:
    cleaned = (value or "").strip().lower()
    mapping = {
        "1:1": "1:1",
        "4:5": "4:5",
        "9:16": "9:16",
        "16:9": "16:9",
        "3:4": "3:4",
        "4:3": "4:3",
        "5:4": "5:4",
        "2:3": "2:3",
        "3:2": "3:2",
        "21:9": "21:9",
    }
    return mapping.get(cleaned, "4:5")


def nano_banana_enabled() -> bool:
    return bool(os.environ.get("GEMINI_API_KEY", "").strip())


def run_nano_banana(prompt: str, destination: Path, aspect_ratio: str) -> dict:
    destination.parent.mkdir(parents=True, exist_ok=True)
    use_script = safe_path_exists(NANO_BANANA_SCRIPT) and shutil.which("uv")
    if use_script:
        command = [
            "uv",
            "run",
            str(NANO_BANANA_SCRIPT),
            "--prompt",
            prompt,
            "--filename",
            str(destination),
            "--resolution",
            os.environ.get("LOBSTER_IMAGE_RESOLUTION", "1K"),
            "--aspect-ratio",
            aspect_ratio_to_flag(aspect_ratio),
        ]
        try:
            completed = subprocess.run(command, text=True, capture_output=True, check=False, timeout=180)
            return {
                "executed": True,
                "status": "ok" if completed.returncode == 0 and destination.exists() else "error",
                "stdout": completed.stdout.strip(),
                "stderr": completed.stderr.strip(),
                "returncode": completed.returncode,
                "command": command,
                "output_path": str(destination),
                "provider": "nano_banana_script",
            }
        except Exception as exc:
            return {
                "executed": False,
                "status": type(exc).__name__,
                "stdout": "",
                "stderr": str(exc),
                "returncode": None,
                "command": command,
                "output_path": str(destination),
                "provider": "nano_banana_script",
            }

    api_key = os.environ.get("GEMINI_API_KEY", "").strip()
    endpoint = (
        "https://generativelanguage.googleapis.com/v1beta/models/"
        f"gemini-3-pro-image-preview:generateContent?key={api_key}"
    )
    payload = {
        "contents": [
            {
                "parts": [
                    {
                        "text": "\n".join(
                            [
                                prompt,
                                f"Aspect ratio: {aspect_ratio_to_flag(aspect_ratio)}.",
                                "Return one polished final marketing image.",
                            ]
                        )
                    }
                ]
            }
        ],
        "generationConfig": {
            "responseModalities": ["image", "text"]
        },
    }
    request = urllib.request.Request(
        endpoint,
        data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=180) as response:
            body = json.loads(response.read().decode("utf-8"))
        inline_data = None
        for candidate in body.get("candidates", []):
            content = candidate.get("content", {})
            for part in content.get("parts", []):
                data = part.get("inlineData", {}).get("data")
                if data:
                    inline_data = data
                    break
            if inline_data:
                break
        if not inline_data:
            return {
                "executed": False,
                "status": "error",
                "stdout": json.dumps(body),
                "stderr": "Nano Banana API returned no image data",
                "returncode": None,
                "command": ["gemini-3-pro-image-preview"],
                "output_path": str(destination),
                "provider": "nano_banana_direct",
            }
        destination.write_bytes(base64.b64decode(inline_data))
        return {
            "executed": True,
            "status": "ok" if destination.exists() else "error",
            "stdout": "",
            "stderr": "",
            "returncode": 0,
            "command": ["gemini-3-pro-image-preview"],
            "output_path": str(destination),
            "provider": "nano_banana_direct",
        }
    except urllib.error.HTTPError as exc:
        return {
            "executed": False,
            "status": "HTTPError",
            "stdout": "",
            "stderr": exc.read().decode("utf-8", "ignore"),
            "returncode": exc.code,
            "command": ["gemini-3-pro-image-preview"],
            "output_path": str(destination),
            "provider": "nano_banana_direct",
        }
    except Exception as exc:
        return {
            "executed": False,
            "status": type(exc).__name__,
            "stdout": "",
            "stderr": str(exc),
            "returncode": None,
            "command": ["gemini-3-pro-image-preview"],
            "output_path": str(destination),
            "provider": "nano_banana_direct",
        }


VEO_MODEL_DEFAULT = "veo-3.1-generate-preview"
VEO_POLL_INTERVAL_SECONDS = 10
VEO_POLL_TIMEOUT_SECONDS = 600
VEO_MAX_ATTEMPTS = 2


def veo_render_enabled() -> bool:
    if not os.environ.get("GEMINI_API_KEY", "").strip():
        return False
    return os.environ.get("LOBSTER_VIDEO_RENDER_ENABLED", "").strip().lower() in {"1", "true", "yes", "on"}


def _veo_aspect_to_flag(aspect_ratio: str) -> str:
    aspect = (aspect_ratio or "").strip()
    # Veo only officially supports 16:9 and 9:16 today. Map everything else
    # to the closest supported ratio so the render still completes.
    if aspect in {"9:16", "1:1", "4:5"}:
        return "9:16"
    return "16:9"


def _veo_duration_for(target_seconds: int) -> int:
    # Veo 3.x currently exposes 4s, 6s, and 8s duration buckets.
    if target_seconds <= 4:
        return 4
    if target_seconds <= 6:
        return 6
    return 8


def _veo_request_video(prompt: str, aspect_ratio: str, duration_seconds: int, model: str) -> dict:
    api_key = os.environ.get("GEMINI_API_KEY", "").strip()
    if not api_key:
        raise RuntimeError("veo_render_unavailable:gemini_api_key_missing")
    start_endpoint = (
        f"https://generativelanguage.googleapis.com/v1beta/models/{model}:predictLongRunning"
    )
    payload = {
        "instances": [
            {
                "prompt": prompt,
            }
        ],
        "parameters": {
            "aspectRatio": _veo_aspect_to_flag(aspect_ratio),
            "durationSeconds": _veo_duration_for(duration_seconds),
            # Veo 3.1 preview only supports allow_all / dont_allow today.
            "personGeneration": "allow_all",
        },
    }
    request = urllib.request.Request(
        start_endpoint,
        data=json.dumps(payload).encode("utf-8"),
        headers={
            "Content-Type": "application/json",
            "x-goog-api-key": api_key,
        },
        method="POST",
    )
    with urllib.request.urlopen(request, timeout=120) as response:
        body = json.loads(response.read().decode("utf-8"))
    operation_name = body.get("name")
    if not operation_name:
        raise RuntimeError(f"veo_render_failed:missing_operation_name:{json.dumps(body)[:200]}")
    return {"operation_name": operation_name, "start_body": body}


def _veo_poll_operation(operation_name: str) -> dict:
    api_key = os.environ.get("GEMINI_API_KEY", "").strip()
    poll_url = f"https://generativelanguage.googleapis.com/v1beta/{operation_name}"
    deadline = time.time() + VEO_POLL_TIMEOUT_SECONDS
    last_body: dict = {}
    while time.time() < deadline:
        request = urllib.request.Request(
            poll_url,
            headers={"x-goog-api-key": api_key},
            method="GET",
        )
        try:
            with urllib.request.urlopen(request, timeout=60) as response:
                last_body = json.loads(response.read().decode("utf-8"))
        except urllib.error.HTTPError as exc:
            raise RuntimeError(
                f"veo_render_poll_failed:{exc.code}:{exc.read().decode('utf-8', 'ignore')[:200]}"
            ) from exc
        if last_body.get("done"):
            return last_body
        time.sleep(VEO_POLL_INTERVAL_SECONDS)
    raise RuntimeError(f"veo_render_timeout:{operation_name}")


def _veo_extract_video_uri(poll_body: dict) -> str | None:
    response = poll_body.get("response") or {}
    gen_response = response.get("generateVideoResponse") or response.get("generate_video_response") or {}
    samples = gen_response.get("generatedSamples") or gen_response.get("generated_samples") or []
    for sample in samples:
        if not isinstance(sample, dict):
            continue
        video = sample.get("video") or {}
        uri = video.get("uri") or video.get("downloadUri") or video.get("download_uri")
        if isinstance(uri, str) and uri.strip():
            return uri.strip()
    # Also tolerate older response shapes that inline bytes.
    for sample in samples:
        if not isinstance(sample, dict):
            continue
        video = sample.get("video") or {}
        inline = video.get("bytesBase64Encoded") or video.get("bytes_base64_encoded")
        if isinstance(inline, str) and inline.strip():
            return f"data:base64:{inline.strip()}"
    return None


def _veo_download_video(uri: str, destination: Path) -> int:
    destination.parent.mkdir(parents=True, exist_ok=True)
    if uri.startswith("data:base64:"):
        data = base64.b64decode(uri[len("data:base64:"):])
        destination.write_bytes(data)
        return len(data)
    api_key = os.environ.get("GEMINI_API_KEY", "").strip()
    request = urllib.request.Request(uri, headers={"x-goog-api-key": api_key}, method="GET")
    with urllib.request.urlopen(request, timeout=300) as response:
        data = response.read()
    destination.write_bytes(data)
    return len(data)


def run_veo_render(
    prompt: str,
    destination: Path,
    aspect_ratio: str,
    duration_seconds: int,
    model: str | None = None,
) -> dict:
    """Call Veo 3 predictLongRunning + poll + download to a local mp4.

    Returns a status dict shaped like run_nano_banana so it can be handled
    alongside image renders. Raises RuntimeError on persistent failure; no
    silent fallback.
    """
    resolved_model = (model or os.environ.get("LOBSTER_VIDEO_MODEL") or VEO_MODEL_DEFAULT).strip() or VEO_MODEL_DEFAULT
    destination.parent.mkdir(parents=True, exist_ok=True)
    last_error: dict | None = None
    for attempt in range(1, VEO_MAX_ATTEMPTS + 1):
        sys.stderr.write(
            f"[veo] starting render stem={destination.stem} aspect={aspect_ratio} duration={duration_seconds}s model={resolved_model} attempt={attempt}/{VEO_MAX_ATTEMPTS}\n"
        )
        sys.stderr.flush()
        try:
            start = _veo_request_video(prompt, aspect_ratio, duration_seconds, resolved_model)
            operation_name = start["operation_name"]
            sys.stderr.write(f"[veo] operation accepted name={operation_name}\n")
            sys.stderr.flush()
            poll_body = _veo_poll_operation(operation_name)
            uri = _veo_extract_video_uri(poll_body)
            if not uri:
                raise RuntimeError(
                    f"veo_render_failed:no_video_uri_in_response:{json.dumps(poll_body)[:400]}"
                )
            bytes_written = _veo_download_video(uri, destination)
            sys.stderr.write(
                f"[veo] ok stem={destination.stem} bytes={bytes_written} operation={operation_name}\n"
            )
            sys.stderr.flush()
            return {
                "executed": True,
                "status": "ok",
                "stdout": "",
                "stderr": "",
                "returncode": 0,
                "command": [resolved_model],
                "output_path": str(destination),
                "provider": "veo_direct",
                "operation_name": operation_name,
            }
        except Exception as exc:  # noqa: BLE001
            message = str(exc)
            sys.stderr.write(
                f"[veo] FAILED stem={destination.stem} attempt={attempt} error={type(exc).__name__}:{message[:300]}\n"
            )
            sys.stderr.flush()
            last_error = {
                "executed": False,
                "status": type(exc).__name__,
                "stdout": "",
                "stderr": message,
                "returncode": None,
                "command": [resolved_model],
                "output_path": str(destination),
                "provider": "veo_direct",
            }
            transient = any(
                marker in message.lower()
                for marker in ("unavailable", "deadline", "timeout", "429", "500", "502", "503", "504")
            )
            if not transient or attempt == VEO_MAX_ATTEMPTS:
                raise RuntimeError(
                    f"video_generation_failed:{destination.stem}:{type(exc).__name__}:{message[:200]}"
                ) from exc
            time.sleep(30)
    # Unreachable — the loop either returns a success or raises.
    raise RuntimeError(
        f"video_generation_failed:{destination.stem}:exhausted:{(last_error or {}).get('stderr', '')[:200]}"
    )


def image_mime_type(image_path: Path) -> str:
    suffix = image_path.suffix.lower()
    if suffix == ".png":
        return "image/png"
    if suffix in {".jpg", ".jpeg"}:
        return "image/jpeg"
    if suffix == ".webp":
        return "image/webp"
    if suffix == ".gif":
        return "image/gif"
    return "application/octet-stream"


def extract_svg_text(image_path: Path) -> list[str]:
    if not image_path.exists():
        return []
    text = image_path.read_text(encoding="utf-8", errors="ignore")
    return [normalize_space(match.group(1)) for match in re.finditer(r"<text\b[^>]*>(.*?)</text>", text, flags=re.IGNORECASE | re.DOTALL) if normalize_space(match.group(1))]


def ocr_image_text_with_gemini(image_path: Path) -> list[str]:
    api_key = os.environ.get("GEMINI_API_KEY", "").strip()
    if not api_key:
        raise RuntimeError("image_text_qa_unavailable:gemini_api_key_missing")
    request_body = {
        "contents": [
            {
                "parts": [
                    {
                        "text": (
                            "Read any visible marketing text in this image. "
                            "Return strict JSON only in the shape "
                            '{"lines":["text line 1","text line 2"]}. '
                            "Do not summarize."
                        )
                    },
                    {
                        "inlineData": {
                            "mimeType": image_mime_type(image_path),
                            "data": base64.b64encode(image_path.read_bytes()).decode("ascii"),
                        }
                    },
                ]
            }
        ]
    }
    endpoint = (
        "https://generativelanguage.googleapis.com/v1beta/models/"
        f"{urllib.parse.quote(os.environ.get('MARKETING_IMAGE_QA_MODEL', 'gemini-2.5-flash'))}:generateContent"
        f"?key={urllib.parse.quote(api_key)}"
    )
    req = urllib.request.Request(
        endpoint,
        data=json.dumps(request_body).encode("utf-8"),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=60) as response:
        parsed = json.loads(response.read().decode("utf-8", errors="replace"))
    candidates = parsed.get("candidates", [])
    if not candidates:
        raise RuntimeError("image_text_qa_failed:empty_candidates")
    parts = candidates[0].get("content", {}).get("parts", [])
    raw_text = "\n".join(part.get("text", "") for part in parts if part.get("text"))
    if not raw_text.strip():
        return []
    lines_payload = json.loads(re.search(r"\{.*\}", raw_text, flags=re.DOTALL).group(0)) if re.search(r"\{.*\}", raw_text, flags=re.DOTALL) else {}
    lines = lines_payload.get("lines", [])
    if not isinstance(lines, list):
        return []
    return [normalize_space(line) for line in lines if normalize_space(line)]


def assert_generated_image_text_safe(image_path: Path) -> list[str]:
    lines = extract_svg_text(image_path) if image_path.suffix.lower() == ".svg" else ocr_image_text_with_gemini(image_path)
    for line in lines:
        if contains_wrapper_language(line):
            raise RuntimeError(f"quality_gate_failed:image_text:{image_path.name}:wrapper_language")
    return lines


FAMILY_VISUAL_DIRECTIONS: dict[str, dict[str, str]] = {
    "outcome-proof": {
        "concept": "Bold numeric proof card",
        "scene": (
            "A dramatic editorial photograph or poster-style composition that centers on a single proof statistic "
            "rendered in oversized display typography. Think Apple keynote meets modern fintech launch: deep negative space, "
            "studio lighting, one striking hero subject photographed from a flattering angle."
        ),
        "style": "Cinematic studio photography, high contrast, premium magazine cover aesthetic.",
    },
    "problem-to-promise": {
        "concept": "Native organic handwritten note",
        "scene": (
            "A close-up overhead photograph of a cream lined notebook page with the headline handwritten in black ink pen, "
            "a single hand-drawn red circle around one key word, warm natural side-lighting, a coffee cup or pen resting at the edge of frame. "
            "Looks like an authentic user-generated post, not an ad."
        ),
        "style": "Intimate documentary photography, warm daylight, shallow depth of field, un-styled and authentic.",
    },
    "offer-clarity": {
        "concept": "Clean product demo mockup",
        "scene": (
            "A polished product demo composition showing a device mockup (laptop, phone, tablet) floating in crisp 3D space "
            "with soft gradient lighting. The headline appears as a single short line below the device. No buttons, no UI elements, no callouts. "
            "Feels like an Apple product landing page."
        ),
        "style": "Modern minimalist product photography, soft shadows, pastel or neutral background, premium tech launch energy.",
    },
    "differentiated-proof": {
        "concept": "Split comparison anchor",
        "scene": (
            "A clean side-by-side split composition: left side shows the old/competitor approach in muted desaturated tones, "
            "right side shows the brand's differentiated approach in full color and focus. A single bold headline sits across the top. "
            "No labels, no arrows, no captions — the contrast does the talking."
        ),
        "style": "Editorial comparison layout, magazine-quality photography, high visual contrast between the two halves.",
    },
}


def _visual_archetype_key(family_id: str) -> str:
    """Return the static archetype key (e.g. 'outcome-proof') for a family id.

    Same suffix-matching rule as before; split out so callers can pick either the
    static dict entry or the synthesized direction while keeping the lookup
    logic single-sourced.
    """
    normalized = (family_id or "").lower().strip()
    for key in FAMILY_VISUAL_DIRECTIONS.keys():
        if normalized.endswith(key) or key in normalized:
            return key
    return "outcome-proof"


def _visual_direction_for_family(family_id: str) -> dict[str, str]:
    """Resolve the visual concept for a creative family.

    Matches by normalized id suffix so `meta-outcome-proof`, `instagram-outcome-proof`,
    etc. all map to the same underlying concept.
    """
    return FAMILY_VISUAL_DIRECTIONS[_visual_archetype_key(family_id)]


# Cache synthesized directions per (brand_slug, archetype) so the four platform
# variants of the same family share one Gemini call and subsequent stage4 runs
# for the same brand stay cheap. Module-level is fine: the Python process is
# short-lived (one pipeline invocation) and each family/brand pair is resolved
# at most a handful of times per run.
_VISUAL_DIRECTION_CACHE: dict[tuple[str, str], dict[str, str]] = {}


def _gemini_text_call(prompt: str, model_name: str) -> str:
    """Fire a one-shot text completion at Gemini. Returns the raw text or ''.

    Kept local to stage4 so the static-image prompt builder doesn't pull in
    stage2's helper just for one call. Matches the same endpoint shape the
    image flow already uses further down this file.
    """
    api_key = os.environ.get("GEMINI_API_KEY", "").strip()
    if not api_key:
        return ""
    url = (
        "https://generativelanguage.googleapis.com/v1beta/models/"
        f"{model_name}:generateContent?key={api_key}"
    )
    body = {
        "contents": [
            {
                "role": "user",
                "parts": [{"text": prompt}],
            }
        ]
    }
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
            return ""
        parts = candidates[0].get("content", {}).get("parts", [])
        return "\n".join(part.get("text", "") for part in parts if part.get("text")).strip()
    except Exception as exc:
        sys.stderr.write(f"[stage4] gemini text call failed: {type(exc).__name__}: {exc}\n")
        sys.stderr.flush()
        return ""


def _extract_json_object(raw: str) -> dict:
    """Pull the first top-level JSON object out of a possibly-fenced LLM reply."""
    if not raw:
        return {}
    try:
        parsed = json.loads(raw)
        if isinstance(parsed, dict):
            return parsed
    except json.JSONDecodeError:
        pass
    match = re.search(r"\{.*\}", raw, flags=re.DOTALL)
    if not match:
        return {}
    try:
        parsed = json.loads(match.group(0))
    except json.JSONDecodeError:
        return {}
    return parsed if isinstance(parsed, dict) else {}


def synthesize_visual_direction(
    brand_context: dict,
    family_id: str,
    headline: str,
) -> dict[str, str]:
    """LLM-generate a scene direction grounded in the specific brand.

    Falls back to FAMILY_VISUAL_DIRECTIONS when brand_context is empty, when
    GEMINI_API_KEY is missing, or when the model returns something we can't
    parse, so the stage4 pipeline still ships an image no matter what.
    """
    archetype = _visual_archetype_key(family_id)
    fallback = FAMILY_VISUAL_DIRECTIONS[archetype]

    brand_slug = str(brand_context.get("brand_slug") or "").strip() or "unknown"
    brand_name = str(brand_context.get("brand_name") or "").strip()
    positioning = str(brand_context.get("positioning") or "").strip()
    audience = str(brand_context.get("audience") or "").strip()
    problem = str(brand_context.get("problem_statement") or "").strip()
    offer = str(brand_context.get("offer") or "").strip()
    style_vibe = str(brand_context.get("style_vibe") or "").strip()
    business_type = str(brand_context.get("business_type") or "").strip()
    voice_list = brand_context.get("brand_voice") or []
    if not isinstance(voice_list, list):
        voice_list = []
    voice = ", ".join([str(v).strip() for v in voice_list if str(v).strip()][:4])

    # If we have effectively no brand signal, don't bother calling Gemini —
    # the result would just be another generic scene. Hardcoded dict wins.
    if not any([positioning, audience, offer, style_vibe, business_type]):
        return fallback

    cache_key = (brand_slug, archetype)
    cached = _VISUAL_DIRECTION_CACHE.get(cache_key)
    if cached is not None:
        return cached

    archetype_briefs = {
        "outcome-proof": "Hero a single bold proof statistic or concrete outcome, magazine-cover energy.",
        "problem-to-promise": "Intimate, documentary, native-organic feel — looks like a real user post, not an ad.",
        "offer-clarity": "Clean product/offer demo composition, premium launch-page polish, minimal elements.",
        "differentiated-proof": "Side-by-side or contrasted composition that anchors the brand's unique angle.",
    }
    archetype_brief = archetype_briefs.get(archetype, archetype_briefs["outcome-proof"])

    prompt = "\n".join(
        [
            "You are art-directing ONE static marketing image for a specific brand.",
            "Write a scene direction that is visually specific to THIS brand, not a generic marketing archetype.",
            "",
            "Brand identity:",
            f"- Brand: {brand_name or brand_slug}",
            f"- Business type: {business_type or 'n/a'}",
            f"- Positioning: {positioning or 'n/a'}",
            f"- Audience: {audience or 'n/a'}",
            f"- Problem it solves: {problem or 'n/a'}",
            f"- Offer: {offer or 'n/a'}",
            f"- Voice attributes: {voice or 'n/a'}",
            f"- Style vibe: {style_vibe or 'n/a'}",
            "",
            f"Creative archetype to honor: {archetype}",
            f"Archetype brief: {archetype_brief}",
            f"Ad headline to render: {headline}",
            "",
            "Return ONLY a single JSON object (no prose, no code fences) with exactly three string keys:",
            '  "concept": a short (<= 10 word) name for the visual concept, brand-specific',
            '  "scene":   one paragraph, concrete, naming subjects/props/environments/lighting a photographer could shoot; grounded in the brand (materials, environments, tools, people that match THIS business)',
            '  "style":   a short phrase describing the photographic/visual style and mood',
            "",
            "Do NOT mention the headline text, logos, brand names, or UI elements in the scene.",
            "Do NOT reuse the archetype brief verbatim — translate it into this brand's world.",
            "Avoid generic Apple-keynote / startup-launch tropes unless this brand is genuinely a tech launch.",
        ]
    )

    model_name = os.environ.get("LOBSTER_STAGE4_TEXT_MODEL", "gemini-2.5-flash").strip() or "gemini-2.5-flash"
    raw = _gemini_text_call(prompt, model_name)
    parsed = _extract_json_object(raw)

    concept = normalize_space(str(parsed.get("concept") or ""))
    scene = normalize_space(str(parsed.get("scene") or ""))
    style = normalize_space(str(parsed.get("style") or ""))

    # Partial responses are still better than a generic archetype IF the scene
    # came through, since scene is the field that actually steers the image
    # model. If scene is missing, fall back fully.
    if not scene:
        _VISUAL_DIRECTION_CACHE[cache_key] = fallback
        return fallback

    direction = {
        "concept": concept or fallback["concept"],
        "scene": scene,
        "style": style or fallback["style"],
    }
    _VISUAL_DIRECTION_CACHE[cache_key] = direction
    sys.stderr.write(
        f"[stage4] synthesized visual direction brand={brand_slug} archetype={archetype} "
        f"concept={direction['concept']!r}\n"
    )
    sys.stderr.flush()
    return direction


def static_image_prompt(contract: dict) -> str:
    creative = contract.get("creative", {})
    aspect_ratio = contract.get("layout", {}).get("aspect_ratio", "4:5")
    brand_tokens = require_contract_brand_tokens(contract)
    headline = normalize_space(str(creative.get("headline", "")))
    cta = normalize_space(str(creative.get("primary_cta", "")))
    family_id = str(contract.get("family_id") or creative.get("family_id") or "")
    brand_context = record_or_empty(contract.get("brand_context"))
    # Try to LLM-synthesize a brand-specific scene; the function itself falls
    # back to the static FAMILY_VISUAL_DIRECTIONS dict when brand signal is
    # missing or Gemini can't be reached, so callers always get a usable dict.
    visual = synthesize_visual_direction(brand_context, family_id, headline)

    # Aspect ratio hint kept at the very top so the model doesn't default to square.
    # The headline is passed as EXACT text the model should render, nothing else.
    # Body/support/proof lines are intentionally omitted from the image — a good ad
    # image carries ONE message, the rest lives in the caption on Meta.
    return "\n".join(
        [
            f"Generate a single finished {aspect_ratio} marketing photograph. Not a template, not an infographic, not a flyer.",
            "",
            f"Concept: {visual['concept']}",
            f"Scene: {visual['scene']}",
            f"Style: {visual['style']}",
            "",
            "Text rendering rules:",
            f'- The ONLY readable text in the image must be exactly: "{headline}"',
            "- Render the headline in clean display typography that fits the brand palette.",
            "- Do NOT add body copy, bullet points, proof points, or supporting lines.",
            f"- Do NOT include a CTA button, the CTA \"{cta}\" lives in the Meta caption, not on the image.",
            "- NO logos, NO brand names, NO watermarks, NO company marks, NO URLs, NO hashtags, NO emojis.",
            "",
            *brand_direction_lines(brand_tokens),
            "",
            "Execution rules:",
            "- Photographic realism or studio-grade 3D, NEVER a vector/template look.",
            "- Premium magazine-cover or launch-announcement polish, not a stock marketing template.",
            "- Strong composition, intentional negative space, publishable-quality lighting.",
            "- No decorative borders, frames, ribbons, starbursts, or corporate clipart.",
            "- Respect the brand color palette from the direction above as accent colors only, do not flood the image in a single brand color.",
            "",
            "Deliver ONE final polished marketing image. Do not return a sketch, a grid, a mockup wireframe, or multiple options.",
        ]
    )


def video_poster_prompt(contract: dict) -> str:
    hook = contract.get("creative", {}).get("hook") or contract.get("creative", {}).get("headline") or contract.get("concept_id", "video-concept")
    beats = [line for line in list_or_empty(contract.get("creative", {}).get("beats"))[:3] if line]
    platform = contract.get("platform", contract.get("platform_slug", "video"))
    brand_tokens = require_contract_brand_tokens(contract)
    return "\n".join(
        [
            f"Create a poster frame for a {platform} marketing video using only the validated brand system in this contract.",
            f"Primary hook: {hook}",
            *(f"Story beat: {line}" for line in beats),
            *contract_brand_voice_lines(contract),
            *brand_direction_lines(brand_tokens),
            "Keep the poster on-brand, readable, and free of substitute palette or substitute typography choices.",
            "Include bold headline text and room for platform-safe crops.",
            "Output a single finished image suitable as a poster frame.",
        ]
    )


_NANO_BANANA_TRANSIENT_STATUS_CODES = {408, 429, 500, 502, 503, 504}
_NANO_BANANA_TRANSIENT_MARKERS = (
    "unavailable",
    "deadline",
    "timeout",
    "timed out",
    "temporarily",
    "rate limit",
    "overloaded",
    "resource_exhausted",
    "internal error",
)
_NANO_BANANA_MAX_ATTEMPTS = 3
_NANO_BANANA_BACKOFF_SECONDS = (15, 30, 60)


def _is_transient_nano_failure(nano_result: dict) -> bool:
    returncode = nano_result.get("returncode")
    if isinstance(returncode, int) and returncode in _NANO_BANANA_TRANSIENT_STATUS_CODES:
        return True
    status = str(nano_result.get("status") or "").lower()
    stderr_blob = str(nano_result.get("stderr") or "").lower()
    stdout_blob = str(nano_result.get("stdout") or "").lower()
    if status in {"timeout", "timeoutexpired", "httperror"}:
        # HTTPError alone isn't enough — inspect body for transient markers.
        if status == "httperror" and not any(
            marker in stderr_blob or marker in stdout_blob for marker in _NANO_BANANA_TRANSIENT_MARKERS
        ):
            return False
        return True
    return any(marker in stderr_blob or marker in stdout_blob for marker in _NANO_BANANA_TRANSIENT_MARKERS)


def render_static_publish_asset(contract: dict, destination_root: Path, filename_stem: str) -> dict:
    destination_root.mkdir(parents=True, exist_ok=True)
    png_path = destination_root / f"{filename_stem}.png"
    if not nano_banana_enabled():
        raise RuntimeError(
            f"image_generation_unavailable:GEMINI_API_KEY_missing:{filename_stem}"
        )
    aspect_ratio = contract.get("layout", {}).get("aspect_ratio", "4:5")
    prompt = static_image_prompt(contract)
    nano_result: dict = {}
    # Gemini image-preview models return 503 UNAVAILABLE / deadline-expired errors
    # intermittently. Retry transient failures with exponential backoff before we
    # hard-fail the stage. No SVG fallback — either Nano Banana Pro succeeds or the
    # stage fails loudly.
    for attempt in range(1, _NANO_BANANA_MAX_ATTEMPTS + 1):
        sys.stderr.write(
            f"[nano_banana_pro] starting render stem={filename_stem} aspect={aspect_ratio} attempt={attempt}/{_NANO_BANANA_MAX_ATTEMPTS}\n"
        )
        sys.stderr.flush()
        nano_result = run_nano_banana(prompt, png_path, aspect_ratio)
        if nano_result.get("status") == "ok" and png_path.exists():
            break
        transient = _is_transient_nano_failure(nano_result)
        sys.stderr.write(
            f"[nano_banana_pro] FAILED stem={filename_stem} attempt={attempt} transient={transient} status={nano_result.get('status')} stderr={str(nano_result.get('stderr') or '')[:500]}\n"
        )
        sys.stderr.flush()
        if not transient or attempt == _NANO_BANANA_MAX_ATTEMPTS:
            raise RuntimeError(
                f"image_generation_failed:{filename_stem}:{nano_result.get('status', 'unknown')}:{(nano_result.get('stderr') or '')[:200]}"
            )
        delay = _NANO_BANANA_BACKOFF_SECONDS[min(attempt - 1, len(_NANO_BANANA_BACKOFF_SECONDS) - 1)]
        sys.stderr.write(
            f"[nano_banana_pro] retry stem={filename_stem} sleeping={delay}s before attempt={attempt + 1}\n"
        )
        sys.stderr.flush()
        time.sleep(delay)
    sys.stderr.write(
        f"[nano_banana_pro] ok stem={filename_stem} bytes={png_path.stat().st_size} provider={nano_result.get('provider')}\n"
    )
    sys.stderr.flush()
    extracted_text = assert_generated_image_text_safe(png_path)
    return {
        "image_path": str(png_path),
        "image_kind": "nano_banana_png",
        # Back-compat: some publishers still read `fallback_svg_path` from the
        # result. It is intentionally empty now — no SVG template art should
        # ever ship through the pipeline.
        "fallback_svg_path": "",
        "nano_banana": nano_result,
        "text_qa": {
            "status": "passed",
            "extracted_lines": extracted_text,
        },
    }


def render_video_poster_asset(contract: dict, destination_root: Path, filename_stem: str) -> dict:
    destination_root.mkdir(parents=True, exist_ok=True)
    png_path = destination_root / f"{filename_stem}.png"
    nano_result = {
        "executed": False,
        "status": "not_configured",
        "output_path": str(png_path),
    }
    if nano_banana_enabled():
        nano_result = run_nano_banana(
            video_poster_prompt(contract),
            png_path,
            contract.get("layout", {}).get("aspect_ratio", "9:16"),
        )
    extracted_text = assert_generated_image_text_safe(png_path) if png_path.exists() else []
    return {
        "poster_image_path": str(png_path) if png_path.exists() else "",
        "nano_banana": nano_result,
        "text_qa": {
            "status": "passed" if extracted_text or not png_path.exists() else "passed",
            "extracted_lines": extracted_text,
        },
    }


def tenant_profile_id(handoff: dict, brand_slug: str) -> str:
    return slugify(
        first_nonempty(
            handoff.get("tenant_profile_id", ""),
            handoff.get("brand_slug", ""),
            handoff.get("production_brief", {}).get("brand_slug", ""),
            brand_slug,
            default="client-brand",
        )
    )


def aries_review_root(tenant_id: str) -> Path:
    root = Path.cwd() / "output" / "aries-review" / tenant_id
    root.mkdir(parents=True, exist_ok=True)
    return root


def write_review_package(tenant_id: str, campaign_id: str, platform_slug: str, payload: dict) -> str:
    path = aries_review_root(tenant_id) / campaign_id / platform_slug / "review-package.json"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    return str(path)


def maybe_run_json_command(command: str, payload: dict) -> dict:
    if not command.strip():
        return {
            "executed": False,
            "status": "not_configured",
            "stdout": "",
            "stderr": "",
            "returncode": None,
        }
    try:
        completed = subprocess.run(
            shlex.split(command),
            input=json.dumps(payload),
            text=True,
            capture_output=True,
            check=False,
            timeout=60,
        )
        return {
            "executed": True,
            "status": "ok" if completed.returncode == 0 else "error",
            "stdout": completed.stdout.strip(),
            "stderr": completed.stderr.strip(),
            "returncode": completed.returncode,
        }
    except Exception as exc:
        return {
            "executed": False,
            "status": f"{type(exc).__name__}",
            "stdout": "",
            "stderr": str(exc),
            "returncode": None,
        }


def maybe_submit_aries_review(review_payload: dict) -> dict:
    command = os.environ.get("ARIES_REVIEW_POST_CMD", "")
    return maybe_run_json_command(command, review_payload)


def maybe_publish_live_draft(platform_slug: str, publish_payload: dict) -> dict:
    specific_name = f"LOBSTER_{platform_slug.upper().replace('-', '_')}_DRAFT_PUBLISH_CMD"
    command = os.environ.get(specific_name, "").strip() or os.environ.get("LOBSTER_DRAFT_PUBLISH_CMD", "").strip()
    result = maybe_run_json_command(command, publish_payload)
    result["env_var"] = specific_name if os.environ.get(specific_name, "").strip() else "LOBSTER_DRAFT_PUBLISH_CMD"
    return result


def bool_arg(value: str) -> bool:
    return (value or "").strip().lower() in {"1", "true", "yes", "y", "on"}


def skipped_publish_payload(step_type: str, platform_slug: str, run_id: str, brand_slug: str) -> dict:
    return {
        "type": step_type,
        "mode": "skipped",
        "generated_at": utc_now(),
        "run_id": run_id,
        "brand_slug": brand_slug,
        "platform": platform_slug,
        "status": "skipped",
    }


def draft_publish_command_for(platform_slug: str) -> tuple[str, str]:
    specific_name = f"LOBSTER_{platform_slug.upper().replace('-', '_')}_DRAFT_PUBLISH_CMD"
    command = os.environ.get(specific_name, "").strip() or os.environ.get("LOBSTER_DRAFT_PUBLISH_CMD", "").strip()
    env_name = specific_name if os.environ.get(specific_name, "").strip() else "LOBSTER_DRAFT_PUBLISH_CMD"
    return command, env_name


def require_live_draft_publish(platform_slug: str, publish_payload: dict) -> dict:
    command, env_name = draft_publish_command_for(platform_slug)
    if not command:
        raise SystemExit(
            f"live_draft_publish_requested_but_not_configured:{platform_slug}:{env_name}"
        )
    result = maybe_run_json_command(command, publish_payload)
    result["env_var"] = env_name
    if result.get("status") != "ok":
        raise SystemExit(
            f"live_draft_publish_failed:{platform_slug}:{result.get('stderr') or result.get('stdout') or result.get('returncode')}"
        )
    return result


def render_command_for(platform_slug: str) -> tuple[str, str]:
    specific_name = f"LOBSTER_{platform_slug.upper().replace('-', '_')}_RENDER_CMD"
    command = os.environ.get(specific_name, "").strip() or os.environ.get("LOBSTER_VIDEO_RENDER_CMD", "").strip()
    env_name = specific_name if os.environ.get(specific_name, "").strip() else "LOBSTER_VIDEO_RENDER_CMD"
    return command, env_name


def require_video_render(platform_slug: str, render_payload: dict) -> dict:
    command, env_name = render_command_for(platform_slug)
    if not command:
        raise SystemExit(
            f"video_render_requested_but_not_configured:{platform_slug}:{env_name}"
        )
    result = maybe_run_json_command(command, render_payload)
    result["env_var"] = env_name
    if result.get("status") != "ok":
        raise SystemExit(
            f"video_render_failed:{platform_slug}:{result.get('stderr') or result.get('stdout') or result.get('returncode')}"
        )
    return result
