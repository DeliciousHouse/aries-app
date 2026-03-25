#!/usr/bin/env python3
import argparse
import json
import os
import sys
from pathlib import Path

REQUIRED_KEYS = [
    "asset_id",
    "platform",
    "aspect_ratio",
    "objective",
    "visual_concept",
    "brand_constraints",
    "negative_constraints",
]
OPTIONAL_TEXT_KEYS = [
    "funnel_stage",
    "landing_page",
    "headline",
    "body_copy",
    "style_notes",
]

MAX_FIELD_LENGTH = 500
MAX_TOTAL_CHARS = 2500
MAX_ARRAY_ITEMS = 8
MAX_ARRAY_ITEM_CHARS = 180


def fail(msg: str) -> int:
    print(msg, file=sys.stderr)
    return 1


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--jobs-file", required=True)
    args = parser.parse_args()

    path = Path(args.jobs_file)
    if not path.exists():
        return fail(f"image jobs file not found: {path}")
    if path.stat().st_size == 0:
        return fail(f"image jobs file is empty: {path}")

    valid = 0
    with path.open("r", encoding="utf-8") as fh:
        for i, line in enumerate(fh, start=1):
            line = line.strip()
            if not line:
                continue
            try:
                job = json.loads(line)
            except json.JSONDecodeError as exc:
                return fail(f"invalid JSON on line {i}: {exc}")

            missing = [k for k in REQUIRED_KEYS if k not in job]
            if missing:
                return fail(f"line {i}: missing required keys: {', '.join(missing)}")

            total_chars = 0
            for key in REQUIRED_KEYS + OPTIONAL_TEXT_KEYS:
                value = job.get(key)
                if isinstance(value, str):
                    if len(value) > MAX_FIELD_LENGTH:
                        return fail(f"line {i}: field {key} exceeds {MAX_FIELD_LENGTH} chars")
                    total_chars += len(value)
                elif key in ["brand_constraints", "negative_constraints", "exact_text"]:
                    if value is None:
                        continue
                elif value is not None and key not in ["brand_constraints", "negative_constraints", "exact_text"]:
                    return fail(f"line {i}: field {key} must be a string when present")

            for array_key in ["brand_constraints", "negative_constraints", "exact_text"]:
                arr = job.get(array_key, [])
                if not isinstance(arr, list):
                    return fail(f"line {i}: field {array_key} must be an array")
                if len(arr) > MAX_ARRAY_ITEMS:
                    return fail(f"line {i}: field {array_key} exceeds {MAX_ARRAY_ITEMS} items")
                for item in arr:
                    if not isinstance(item, str):
                        return fail(f"line {i}: field {array_key} must contain only strings")
                    if len(item) > MAX_ARRAY_ITEM_CHARS:
                        return fail(f"line {i}: item in {array_key} exceeds {MAX_ARRAY_ITEM_CHARS} chars")
                    total_chars += len(item)

            if total_chars > MAX_TOTAL_CHARS:
                return fail(f"line {i}: compact brief exceeds {MAX_TOTAL_CHARS} chars total")

            valid += 1

    if valid == 0:
        return fail(f"image jobs file has no jobs: {path}")

    print(json.dumps({"ok": True, "jobsFile": str(path), "jobs": valid}, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
