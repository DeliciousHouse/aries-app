#!/usr/bin/env python3
import argparse
import json
import os
import re
import sys

def env_name(name: str) -> str:
    return "LOBSTER_ARG_" + re.sub(r"[^A-Za-z0-9]", "_", name).upper()

def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("required", nargs="+")
    args = parser.parse_args()

    missing = []
    values = {}
    for name in args.required:
        value = os.environ.get(env_name(name), "").strip()
        values[name] = value
        if not value:
            missing.append(name)

    payload = {"ok": not missing, "values": values, "missingArgs": missing}
    print(json.dumps(payload, indent=2))
    return 0 if not missing else 1

if __name__ == "__main__":
    raise SystemExit(main())
