#!/usr/bin/env python3
"""Cheap Lobster workflow used by the OpenClaw gateway availability smoke test.

The script intentionally avoids provider calls and external services. If the
OpenClaw gateway can execute the `lobster` tool from the Aries `lobster` cwd,
this writes a small JSON report to the requested output location and prints the
same report to stdout so Lobster returns it in the tool envelope.
"""

from __future__ import annotations

import argparse
import json
import os
import socket
from datetime import datetime, timezone
from pathlib import Path


def _inside(path: Path, root: Path) -> bool:
    return path == root or root in path.parents


def resolve_output_location(raw_location: str) -> Path:
    cwd = Path.cwd().resolve()
    project_root = cwd.parent if cwd.name == "lobster" else cwd
    default_location = Path("output/diagnostics/openclaw-lobster-availability.json")
    requested = Path(raw_location) if raw_location.strip() else default_location
    resolved = (cwd / requested).resolve() if not requested.is_absolute() else requested.resolve()

    allowed_roots = [
        cwd / "output",
        project_root / ".artifacts",
        Path(os.environ.get("TMPDIR", "/tmp")).resolve(),
    ]
    if not any(_inside(resolved, root.resolve()) for root in allowed_roots):
        allowed = ", ".join(str(root.resolve()) for root in allowed_roots)
        raise RuntimeError(
            f"unsafe_output_location: {resolved} is outside allowed diagnostic roots: {allowed}"
        )
    return resolved


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--marker", default="")
    parser.add_argument("--workflow", default="diagnostics/openclaw-gateway-availability.lobster")
    parser.add_argument("--output-location", default="output/diagnostics/openclaw-lobster-availability.json")
    args = parser.parse_args()

    output_location = resolve_output_location(args.output_location)
    output_location.parent.mkdir(parents=True, exist_ok=True)

    report = {
        "ok": True,
        "lobster_tool": "available",
        "marker": args.marker,
        "workflow": args.workflow,
        "cwd": str(Path.cwd().resolve()),
        "output_location_requested": args.output_location,
        "output_location": str(output_location),
        "hostname": socket.gethostname(),
        "pid": os.getpid(),
        "timestamp": datetime.now(timezone.utc).isoformat(),
    }

    serialized = json.dumps(report, sort_keys=True)
    output_location.write_text(serialized + "\n", encoding="utf-8")
    print(serialized)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
