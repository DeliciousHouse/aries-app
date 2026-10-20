#!/usr/bin/python3
"""Operations verifier for ubuntu-docker-replace.mjs, called as <phase> <sha> <image>.

Exit 0 accepts the phase; the caller suppresses all output.
- quiesced: app and DB healthy, and no in-flight or unknown-outcome scheduled publish
  (assert-no-unresolved-scheduled-claims.mjs). Swapping mid-publish is refused.
- appReady: the new app container runs exactly <image> with OCI revision <sha>, and
  answers / and /api/health/db.
- accepted: all four services run exactly <image>/<sha>; root, DB and Hermes health ok;
  the scheduled-posts readiness check passes; still no unresolved claims.
- health: routes only, no candidate binding (used by controller rollback).
Out of scope: durable outside-container ingress/egress containment. The runbook itself says
code must not guess production firewall controls; workers stop on SIGTERM (graceful drain).
"""
import json
import subprocess
import sys
import time
import urllib.request

ORIGIN = "http://127.0.0.1:13000"
APP = "aries-a3e604b4-app"
SERVICES = [APP] + ["aries-a3e604b4-" + s for s in ("scheduled-posts", "insights-sync", "weekly-trigger")]
ROUTES = {"quiesced": ["/api/health/db"], "appReady": ["/", "/api/health/db"],
          "accepted": ["/", "/api/health/db", "/api/health/hermes"], "health": ["/", "/api/health/db", "/api/health/hermes"]}


def docker(*args):
    return subprocess.run(["docker", *args], capture_output=True, text=True, timeout=120)


def routes_ok(routes):
    try:
        for route in routes:
            with urllib.request.urlopen(ORIGIN + route, timeout=15) as response:
                if response.status != 200:
                    return False
                body = response.read()
            if route == "/api/health/db" and json.loads(body).get("status") != "ok":
                return False
            if route == "/api/health/hermes" and json.loads(body).get("ok") is not True:
                return False
        return True
    except Exception:
        return False


def bound(names, sha, image):
    candidate = docker("image", "inspect", "-f", "{{.Id}}", image)
    revision = docker("image", "inspect", "-f", '{{index .Config.Labels "org.opencontainers.image.revision"}}', image)
    if candidate.returncode or revision.returncode or revision.stdout.strip() != sha:
        return False
    for name in names:
        state = docker("inspect", "-f", "{{.Image}} {{.State.Running}}", name)
        if state.returncode or state.stdout.split() != [candidate.stdout.strip(), "true"]:
            return False
    return True


def no_unresolved_claims():
    return docker("exec", APP, "node", "scripts/release/assert-no-unresolved-scheduled-claims.mjs").returncode == 0


def scheduled_ready():
    return docker("exec", "-e", "ARIES_SCHEDULED_POSTS_READINESS_CHECK=1", SERVICES[1],
                  "node", "scripts/automations/scheduled-posts-worker.mjs").returncode == 0


def check(phase, sha, image):
    if not routes_ok(ROUTES[phase]):
        return False
    if phase == "quiesced":
        return no_unresolved_claims()
    if phase == "appReady":
        return bound([APP], sha, image)
    if phase == "accepted":
        return bound(SERVICES, sha, image) and scheduled_ready() and no_unresolved_claims()
    return True


def main(argv):
    if len(argv) < 2 or argv[1] not in ROUTES:
        return 1
    phase = argv[1]
    sha, image = (argv[2], argv[3]) if len(argv) > 3 else ("", "")
    if phase in ("appReady", "accepted") and not (len(sha) == 40 and "@sha256:" in image):
        return 1
    deadline = time.monotonic() + (20 if phase == "quiesced" else 140)
    while True:
        if check(phase, sha, image):
            return 0
        if time.monotonic() >= deadline:
            return 1
        time.sleep(5)


if __name__ == "__main__":
    sys.exit(main(sys.argv))
