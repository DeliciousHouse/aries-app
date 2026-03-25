#!/usr/bin/env python3
import argparse
import json
import os
import shutil
import sys
from pathlib import Path

STAGES = {
    "research": {
        "bins": ["lobster", "openclaw", "jq", "curl", "python3"],
        "env": ["GEMINI_API_KEY"],
    },
    "strategy": {
        "bins": ["lobster", "openclaw", "jq", "curl", "python3"],
        "env": [],
    },
    "production": {
        "bins": ["lobster", "openclaw", "jq", "curl", "python3"],
        "env": ["GEMINI_API_KEY"],
    },
    "publish": {
        "bins": ["lobster", "openclaw", "jq", "curl", "python3"],
        "env": ["META_ACCESS_TOKEN", "META_AD_ACCOUNT_ID", "META_PAGE_ID"],
    },
    "full": {
        "bins": ["lobster", "openclaw", "jq", "curl", "python3"],
        "env": ["GEMINI_API_KEY", "META_ACCESS_TOKEN", "META_AD_ACCOUNT_ID", "META_PAGE_ID"],
    },
}

def parse_dotenv(path: Path) -> dict[str, str]:
    values: dict[str, str] = {}
    if not path.exists():
        return values
    for raw in path.read_text().splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        values[key.strip()] = value.strip().strip('"').strip("'")
    return values

def resolve_env(name: str) -> str | None:
    if os.environ.get(name):
        return os.environ.get(name)
    cwd_env = parse_dotenv(Path.cwd() / ".env")
    if cwd_env.get(name):
        return cwd_env[name]
    home_env = parse_dotenv(Path.home() / ".openclaw" / ".env")
    if home_env.get(name):
        return home_env[name]
    return None

def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--stage", choices=sorted(STAGES), required=True)
    args = parser.parse_args()

    stage = STAGES[args.stage]
    missing_bins = [name for name in stage["bins"] if shutil.which(name) is None]
    missing_env = [name for name in stage["env"] if not resolve_env(name)]

    payload = {
        "ok": not missing_bins and not missing_env,
        "stage": args.stage,
        "missingBins": missing_bins,
        "missingEnv": missing_env,
        "cwd": str(Path.cwd()),
    }
    print(json.dumps(payload, indent=2))
    return 0 if payload["ok"] else 1

if __name__ == "__main__":
    raise SystemExit(main())
