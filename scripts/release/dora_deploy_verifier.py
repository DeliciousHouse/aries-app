#!/usr/bin/python3
"""Operations verifier for ubuntu-docker-replace.mjs, called as <phase> <sha> <image>.

Exit 0 accepts the phase; output is suppressed by the caller.
- quiesced: the running app and database are healthy before any mutation.
- appReady: the candidate app answers / and /api/health/db on loopback.
- accepted: database and Hermes health are both ok.
ponytail: health-based, not the runbook's synthetic three-worker probes; the schema gate in
dora_pull_deploy.py is what keeps image-only swaps compatible. Add worker probes if a
swap ever breaks a worker while health stays green.
"""
import json
import sys
import time
import urllib.request

ORIGIN = "http://127.0.0.1:13000"


def get(route):
    with urllib.request.urlopen(ORIGIN + route, timeout=15) as response:
        return response.status, response.read()


def healthy(routes):
    try:
        for route in routes:
            status, body = get(route)
            if status != 200:
                return False
            if route == "/api/health/db" and json.loads(body).get("status") != "ok":
                return False
            if route == "/api/health/hermes" and json.loads(body).get("ok") is not True:
                return False
        return True
    except Exception:
        return False


def main(phase):
    routes = {"quiesced": ["/api/health/db"], "appReady": ["/", "/api/health/db"],
              "accepted": ["/", "/api/health/db", "/api/health/hermes"]}.get(phase)
    if routes is None:
        return 1
    deadline = time.monotonic() + (20 if phase == "quiesced" else 150)
    while True:
        if healthy(routes):
            return 0
        if time.monotonic() >= deadline:
            return 1
        time.sleep(5)


if __name__ == "__main__":
    sys.exit(main(sys.argv[1] if len(sys.argv) > 1 else ""))
