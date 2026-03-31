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
import urllib.error
import urllib.request
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from _canonical_outputs import write_stage_log


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


def load_json_file(path: str) -> dict:
    candidate = Path(path)
    if not path or not candidate.exists() or not candidate.is_file():
        return {}
    return json.loads(candidate.read_text(encoding="utf-8"))


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
    proof_points = list_or_empty(creative.get("proof_points"))[:3]
    body_lines = list_or_empty(creative.get("body_lines"))[:3]
    lines = [contract.get("platform", "Static Asset"), creative.get("headline", "Headline"), *body_lines, *proof_points]
    escaped = [line.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;") for line in lines]
    svg = f"""<svg xmlns="http://www.w3.org/2000/svg" width="1080" height="1350" viewBox="0 0 1080 1350">
  <rect width="1080" height="1350" fill="#f4efe5"/>
  <rect x="54" y="54" width="972" height="1242" rx="36" fill="#1d3124"/>
  <text x="108" y="160" fill="#f0e7d8" font-family="Arial, sans-serif" font-size="38" font-weight="700">{escaped[0]}</text>
  <text x="108" y="270" fill="#ffffff" font-family="Arial, sans-serif" font-size="72" font-weight="700">{escaped[1]}</text>
  <text x="108" y="390" fill="#d8e3dc" font-family="Arial, sans-serif" font-size="34">{escaped[2] if len(escaped) > 2 else ''}</text>
  <text x="108" y="450" fill="#d8e3dc" font-family="Arial, sans-serif" font-size="34">{escaped[3] if len(escaped) > 3 else ''}</text>
  <text x="108" y="510" fill="#d8e3dc" font-family="Arial, sans-serif" font-size="34">{escaped[4] if len(escaped) > 4 else ''}</text>
  <rect x="108" y="1120" width="360" height="96" rx="20" fill="#f0b429"/>
  <text x="148" y="1182" fill="#1d3124" font-family="Arial, sans-serif" font-size="40" font-weight="700">{creative.get('primary_cta', 'Learn More')}</text>
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


def static_image_prompt(contract: dict) -> str:
    creative = contract.get("creative", {})
    platform = contract.get("platform", "marketing creative")
    proof_points = list_or_empty(creative.get("proof_points"))[:3]
    body_lines = [line for line in list_or_empty(creative.get("body_lines"))[:3] if line]
    return "\n".join(
        [
            f"Create a polished high-converting ad creative for {platform}.",
            "Style: premium B2B marketing creative, clean typography, believable modern layout, not generic clipart, not meme-like.",
            "Use readable text in the image.",
            f"Headline: {creative.get('headline', 'Lead with proof.')}",
            *(f"Support line: {line}" for line in body_lines),
            *(f"Proof point: {line}" for line in proof_points),
            f"CTA button text: {creative.get('primary_cta', 'Learn More')}",
            f"Aspect ratio: {contract.get('layout', {}).get('aspect_ratio', '4:5')}",
            "Design direction: dark green and warm neutral palette, premium consulting aesthetic, strong contrast, clear hierarchy.",
            "Output a single finished marketing image.",
        ]
    )


def video_poster_prompt(contract: dict) -> str:
    hook = contract.get("creative", {}).get("hook") or contract.get("creative", {}).get("headline") or contract.get("concept_id", "Lead with proof")
    beats = [line for line in list_or_empty(contract.get("creative", {}).get("beats"))[:3] if line]
    platform = contract.get("platform", contract.get("platform_slug", "video"))
    return "\n".join(
        [
            f"Create a striking poster frame / thumbnail for a {platform} marketing video.",
            "Style: premium performance marketing creative, cinematic but realistic, clean typography, persuasive and modern.",
            f"Primary hook: {hook}",
            *(f"Story beat: {line}" for line in beats),
            "Include bold headline text and room for platform-safe crops.",
            "Output a single finished image suitable as a poster frame.",
        ]
    )


def render_static_publish_asset(contract: dict, destination_root: Path, filename_stem: str) -> dict:
    destination_root.mkdir(parents=True, exist_ok=True)
    svg_path = destination_root / f"{filename_stem}.svg"
    render_static_svg(contract, svg_path)
    png_path = destination_root / f"{filename_stem}.png"
    nano_result = {
        "executed": False,
        "status": "not_configured",
        "output_path": str(png_path),
    }
    final_image_path = str(svg_path)
    final_image_kind = "svg_fallback"
    if nano_banana_enabled():
        nano_result = run_nano_banana(
            static_image_prompt(contract),
            png_path,
            contract.get("layout", {}).get("aspect_ratio", "4:5"),
        )
        if nano_result.get("status") == "ok" and png_path.exists():
            final_image_path = str(png_path)
            final_image_kind = "nano_banana_png"
    return {
        "image_path": final_image_path,
        "image_kind": final_image_kind,
        "fallback_svg_path": str(svg_path),
        "nano_banana": nano_result,
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
    return {
        "poster_image_path": str(png_path) if png_path.exists() else "",
        "nano_banana": nano_result,
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
