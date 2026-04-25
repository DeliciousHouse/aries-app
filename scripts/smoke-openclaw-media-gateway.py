#!/usr/bin/env python3
"""Local smoke for Lobster's OpenClaw media gateway integration.

Loads local env files without printing secrets, then invokes the same helper used by
Stage 4 so gateway result extraction and media copy semantics are exercised.
"""
from __future__ import annotations

import os
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "lobster" / "bin"))

from _openclaw_media_gateway import MediaGatewayError, generate_image, generate_video, media_gateway_configured  # noqa: E402


def load_env_file(path: Path) -> None:
    if not path.exists():
        return
    for raw_line in path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        key = key.strip()
        value = value.strip().strip('"').strip("'")
        if key and key not in os.environ:
            os.environ[key] = value


def main() -> int:
    for candidate in [ROOT / ".env", ROOT.parent / ".env", Path.home() / "openclaw" / ".env", Path.home() / ".hermes" / ".env"]:
        load_env_file(candidate)

    os.environ["LOBSTER_MEDIA_GATEWAY_ENABLED"] = "1"
    # Keep generated assets under a throwaway destination while exercising the real gateway.
    out_dir = Path(tempfile.mkdtemp(prefix="aries-openclaw-gateway-smoke-"))
    image_dest = out_dir / "gateway-smoke.png"
    video_dest = out_dir / "gateway-smoke.mp4"

    print(f"configured={media_gateway_configured()}")
    print(f"destination_dir={out_dir}")

    image = generate_image(
        "Minimal product ad test image: a single blue circle on a plain white background. No text.",
        image_dest,
        aspect_ratio="square",
    )
    print(f"image_status={image.get('status')} image_exists={image_dest.exists()} image_bytes={image_dest.stat().st_size if image_dest.exists() else 0}")

    if os.environ.get("LOBSTER_SMOKE_SKIP_VIDEO", "").strip().lower() in {"1", "true", "yes"}:
        print("video_status=skipped")
        return 0

    video = generate_video(
        "Minimal 5 second video test: a blue circle gently pulsing on a plain white background. No text.",
        video_dest,
        aspect_ratio="16:9",
        duration_seconds=5,
        model=os.environ.get("LOBSTER_VIDEO_MODEL"),
    )
    print(f"video_status={video.get('status')} video_exists={video_dest.exists()} video_bytes={video_dest.stat().st_size if video_dest.exists() else 0}")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except MediaGatewayError as exc:
        print(f"SMOKE_FAILED:{exc}", file=sys.stderr)
        raise SystemExit(1)
