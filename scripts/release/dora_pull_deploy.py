#!/usr/bin/python3
"""Dora pull deploy for Aries production on ubuntu-docker (owner-authorized 2026-10-20).

Each tick: newest master commit -> its own `full-suite / full-suite` check passed ->
ghcr sha-<SHA> image published (publish-master-image.yml) -> no schema/DDL change
since the running revision -> verified pg_dump -> ubuntu-docker-replace.mjs swap ->
health. Schema changes are refused and left for an operator; nothing here migrates.

Install from a reviewed commit (docs/runbooks/dora-pull-deploy.md): the controller,
verifier and replace tool are copied into ~/.local/lib/aries-deploy, so a candidate
commit can never change the code that deploys it.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import time
import urllib.error
import urllib.request

REPO = "DeliciousHouse/aries-app"
IMAGE = "ghcr.io/delicioushouse/aries-app"
REGISTRY_REPO = IMAGE.split("/", 1)[1]
CHECK = "full-suite / full-suite"
SERVICES = ["aries-a3e604b4-" + s for s in ("app", "scheduled-posts", "insights-sync", "weekly-trigger")]
NETWORK = "aries-cutover-v1"
PG, DB = "aries-a3e604b4-pg", "aries_snapshot"
LIB = Path(__file__).resolve().parent
BACKUPS = Path.home() / "backups-aries"
KEEP_BACKUPS = 5
DDL = re.compile(r"^\+.*\b(CREATE|ALTER|DROP|RENAME)\s+(TABLE|INDEX|TYPE|SCHEMA|COLUMN|CONSTRAINT|SEQUENCE)\b", re.I | re.M)
CODE = (".ts", ".tsx", ".js", ".mjs", ".cjs", ".sql")


def run(*args, input=None, timeout=900):
    result = subprocess.run(args, input=input, capture_output=True, timeout=timeout)
    if result.returncode:
        # Never echo Docker/Node output: it can carry the protected runtime env.
        raise RuntimeError(f"command failed: {Path(args[0]).name} {args[1] if len(args) > 1 else ''}")
    return result.stdout


def text(*args, **kw):
    return run(*args, **kw).decode().strip()


def github(path):
    request = urllib.request.Request(f"https://api.github.com/repos/{REPO}/{path}",
                                     headers={"Accept": "application/vnd.github+json", "User-Agent": "aries-dora-deploy"})
    with urllib.request.urlopen(request, timeout=30) as response:
        return json.load(response)


def ci_passed(check_runs, sha):
    matching = [c for c in check_runs if c.get("name") == CHECK and c.get("head_sha") == sha
                and c.get("app", {}).get("slug") == "github-actions"]
    # Newest run decides: an older success cannot hide a failed rerun.
    latest = max(matching, key=lambda c: c.get("id", 0), default={})
    return latest.get("status") == "completed" and latest.get("conclusion") == "success"


def schema_change(compare):
    """Reason string if the diff may need a migration, else None. Unknown = refuse."""
    if compare.get("status") != "ahead":
        return f"master is {compare.get('status')} relative to production, not ahead"
    files = compare.get("files", [])
    if len(files) >= 300:
        return "diff too large to inspect (300+ files)"
    for f in files:
        name = f["filename"]
        if name.startswith("migrations/") or name == "scripts/init-db.js":
            return "schema file changed: " + name
        if name.startswith("tests/") or not name.endswith(CODE):
            continue
        if "patch" not in f and f.get("status") != "removed":
            return "patch unavailable for " + name
        if DDL.search(f.get("patch", "")):
            return "DDL statement changed in " + name
    return None


def registry_digest(sha):
    with urllib.request.urlopen(f"https://ghcr.io/token?scope=repository:{REGISTRY_REPO}:pull", timeout=30) as r:
        token = json.load(r)["token"]
    request = urllib.request.Request(f"https://ghcr.io/v2/{REGISTRY_REPO}/manifests/sha-{sha}", method="HEAD", headers={
        "Authorization": "Bearer " + token,
        "Accept": "application/vnd.oci.image.index.v1+json,application/vnd.oci.image.manifest.v1+json,"
                  "application/vnd.docker.distribution.manifest.list.v2+json,application/vnd.docker.distribution.manifest.v2+json"})
    try:
        with urllib.request.urlopen(request, timeout=30) as r:
            digest = r.headers["Docker-Content-Digest"]
    except urllib.error.HTTPError as error:
        if error.code == 404:
            return None
        raise
    if not re.fullmatch(r"sha256:[0-9a-f]{64}", digest or ""):
        raise RuntimeError("registry returned no digest")
    return digest


def inspect(name):
    try:
        return json.loads(text("docker", "inspect", name))[0]
    except RuntimeError:
        return None


def image_revision(image_id):
    return text("docker", "image", "inspect", "-f", '{{index .Config.Labels "org.opencontainers.image.revision"}}', image_id)


def running_revision():
    app = inspect(SERVICES[0])
    if not app or not app["State"]["Running"]:
        raise RuntimeError("production app is not running")
    return image_revision(app["Image"])


def node():
    versions = sorted((Path.home() / ".nvm/versions/node").glob("v24.*"))
    if not versions:
        raise RuntimeError("Node 24 is not installed under nvm")
    return str(versions[-1] / "bin/node")


def backup(sha):
    BACKUPS.mkdir(mode=0o700, exist_ok=True)
    path = BACKUPS / f"auto-{sha[:12]}-{time.strftime('%Y%m%dT%H%M%S')}.dump"
    path.write_bytes(run("docker", "exec", PG, "pg_dump", "-U", "postgres", "-d", DB, "-Fc", timeout=1800))
    path.chmod(0o600)
    # A truncated or corrupt archive fails pg_restore --list.
    if path.stat().st_size < 1_000_000 or b"TABLE DATA" not in run("docker", "exec", "-i", PG, "pg_restore", "--list", input=path.read_bytes()):
        raise RuntimeError("database backup failed verification")
    for old in sorted(BACKUPS.glob("auto-*.dump"))[:-KEEP_BACKUPS]:
        old.unlink()
    return path


def build_plan(sha, image, sources, base, check_id, backup_path, verifier, now):
    evidence = {
        "launchOwnership": f"controller inventory of the four direct-Docker services at {now}",
        "storageIdentity": "image-only swap; HostConfig and binds cloned by ubuntu-docker-replace.mjs",
        "appAndWorkerSettings": "Config and HostConfig cloned in memory; only Image changes",
        "restoredCopyCompatibility": f"no migrations/, init-db or DDL change in {base[:12]}..{sha[:12]} (controller schema gate)",
        "backupAndRollback": f"pg_dump {backup_path.name} verified with pg_restore --list; originals retained for rollback",
        "reviewedReplacement": f"master {sha} {CHECK} check {check_id} success; owner-authorized master auto-deploy 2026-10-20",
    }
    return {"host": "ubuntu-docker", "origin": "https://aries.deliciouswines.org", "sha": sha, "image": image,
            "checkpoints": {k: {"sha": sha, "image": image, "evidence": v} for k, v in evidence.items()},
            "mode": "compatible_image_only", "schemaChanged": False, "checkpointAt": now, "sources": sources,
            "verifier": {"path": str(verifier), "sha256": hashlib.sha256(verifier.read_bytes()).hexdigest()}}


def stamp(state, name, value):
    tmp = state / (name + ".tmp")
    tmp.write_text(value)
    os.replace(tmp, state / name)


def wait_healthy(seconds=240):
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        if subprocess.run([str(LIB / "dora_deploy_verifier.py"), "accepted", "-", "-"], capture_output=True).returncode == 0:
            return
        time.sleep(10)
    raise RuntimeError("production unhealthy after rollback; operator intervention required")


def rollback(journal):
    # ponytail: restarts the old image once the candidate is stopped. Safe only because the
    # schema gate refused any migration/DDL change; the runbook's no-restart rule covers schema moves.
    for name in SERVICES:
        original = journal["originals"][name]
        current = inspect(name)
        if current and current["Id"] == original:
            if not current["State"]["Running"]:
                run("docker", "start", original)
            continue
        if current:
            run("docker", "stop", "-t", "60", current["Id"])
            run("docker", "rename", current["Id"], f"{name}-failed-{journal['sha'][:12]}")
        run("docker", "rename", original, name)
        if NETWORK not in (inspect(original)["NetworkSettings"]["Networks"] or {}):
            run("docker", "network", "connect", NETWORK, original)
        run("docker", "start", original)
    wait_healthy()


def finish_or_recover(state):
    journal = json.loads((state / "transaction.json").read_text())
    app = inspect(SERVICES[0])
    if (app and app["State"]["Running"] and app["Id"] != journal["originals"][SERVICES[0]]
            and image_revision(app["Image"]) == journal["sha"]
            and all((c := inspect(n)) and c["State"]["Running"] for n in SERVICES)):
        wait_healthy(60)
        stamp(state, "deployed", journal["sha"])
        print("Interrupted deploy had completed; production healthy at " + journal["sha"])
    else:
        rollback(journal)
        stamp(state, "failed", journal["sha"])
        print("Recovered interrupted deploy; original containers restored and healthy")
    (state / "transaction.json").unlink()


def prune_retained(keep):
    for line in text("docker", "ps", "-a", "--format", "{{.ID}} {{.Names}}").splitlines():
        cid, name = line.split(" ", 1)
        if "-retained-" in name and name.startswith("aries-a3e604b4-") and not any(k.startswith(cid) for k in keep):
            run("docker", "rm", cid)


def poll(state, dry_run=False):
    if (state / "transaction.json").exists():
        return finish_or_recover(state)
    if Path("/home/node/.aries-replacement.lock").exists():
        raise RuntimeError("replacement lock present; an operator must inspect before removing it")
    sha = github("commits/master")["sha"]
    deployed = running_revision()
    failed = (state / "failed").read_text().strip() if (state / "failed").exists() else ""
    if sha in (deployed, failed):
        return print("Up to date" if sha == deployed else "Master " + sha[:12] + " failed before; waiting for a new commit")
    if not re.fullmatch(r"[0-9a-f]{40}", deployed):
        raise RuntimeError("running image has no full OCI revision")
    runs = github(f"commits/{sha}/check-runs?per_page=100")["check_runs"]
    if not ci_passed(runs, sha):
        return print("Waiting for " + CHECK + " on " + sha[:12])
    reason = schema_change(github(f"compare/{deployed}...{sha}"))
    if reason:
        stamp(state, "blocked", f"{sha} {reason}\n")
        raise RuntimeError("deploy refused, operator needed: " + reason)
    (state / "blocked").unlink(missing_ok=True)
    digest = registry_digest(sha)
    if not digest:
        return print("Waiting for image sha-" + sha[:12])
    image = f"{IMAGE}@{digest}"
    run("docker", "pull", "-q", image, timeout=1800)
    if image_revision(image) != sha:
        raise RuntimeError("image revision label does not match master")
    check_id = max(c["id"] for c in runs if c.get("name") == CHECK and c.get("head_sha") == sha)
    if dry_run:
        return print(f"Would deploy {sha} as {image}")
    sources = json.loads(text(node(), str(LIB / "ubuntu-docker-replace.mjs"), "--inventory"))
    path = backup(sha)
    now = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    plan = build_plan(sha, image, sources, deployed, check_id, path, LIB / "dora_deploy_verifier.py", now)
    plan_path = state / "plan.json"
    plan_path.write_text(json.dumps(plan))
    stamp(state, "transaction.json", json.dumps({"sha": sha, "originals": {n: sources[n]["id"] for n in SERVICES}}))
    try:
        out = text(node(), str(LIB / "ubuntu-docker-replace.mjs"), "--execute", str(plan_path), timeout=2400)
        receipt = json.loads(out.splitlines()[-1])
        if receipt.get("deployed") is not True or receipt.get("sha") != sha:
            raise RuntimeError("replacement receipt is not a deployment")
    except Exception:
        rollback(json.loads((state / "transaction.json").read_text()))
        stamp(state, "failed", sha)
        (state / "transaction.json").unlink()
        raise RuntimeError(f"deploy of {sha[:12]} failed; originals restored and healthy") from None
    finally:
        plan_path.unlink(missing_ok=True)
    stamp(state, "deployed", sha)
    stamp(state, "result.json", json.dumps({"sha": sha, "image": image, "backup": str(path), "previous": deployed,
                                           "containers": receipt["containers"], "retained": receipt["retained"],
                                           "at": now}))
    (state / "transaction.json").unlink()
    prune_retained(receipt["retained"])
    print(f"Deployed {sha} ({image}); previous {deployed[:12]} retained; backup {path.name}")


def self_test():
    ok = {"status": "ahead", "files": [{"filename": "app/page.tsx", "patch": "+const a = 1"},
                                       {"filename": "tests/x.test.ts", "patch": "+CREATE TABLE t (a int)"},
                                       {"filename": "package-lock.json"}]}
    assert schema_change(ok) is None
    assert "migrations/" in schema_change({"status": "ahead", "files": [{"filename": "migrations/1.sql"}]})
    assert "DDL" in schema_change({"status": "ahead", "files": [{"filename": "scripts/w.ts", "patch": "+  await q('ALTER TABLE x ADD y int')"}]})
    assert schema_change({"status": "ahead", "files": [{"filename": "lib/old.ts", "patch": "-await q('CREATE TABLE t (a int)')"}]}) is None
    assert "patch unavailable" in schema_change({"status": "ahead", "files": [{"filename": "lib/big.ts"}]})
    assert "behind" in schema_change({"status": "behind", "files": []})
    assert schema_change({"status": "ahead", "files": [{"filename": "a.ts"}] * 300})
    sha = "a" * 40
    run_ok = {"name": CHECK, "head_sha": sha, "app": {"slug": "github-actions"}, "id": 1, "status": "completed", "conclusion": "success"}
    assert ci_passed([run_ok], sha)
    assert not ci_passed([run_ok, dict(run_ok, id=2, conclusion="failure")], sha)
    assert not ci_passed([dict(run_ok, head_sha="b" * 40)], sha)
    verifier = Path(__file__)
    plan = build_plan(sha, IMAGE + "@sha256:" + "b" * 64, {}, "c" * 40, 7, Path("/x/auto.dump"), verifier, "2026-10-20T00:00:00Z")
    assert plan["mode"] == "compatible_image_only" and plan["schemaChanged"] is False
    assert len(plan["checkpoints"]) == 6 and all(c["sha"] == sha for c in plan["checkpoints"].values())
    print("self-test ok")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--state", type=Path, default=Path.home() / ".local/share/aries-deploy")
    parser.add_argument("--status", action="store_true", help="report master vs production; never deploy")
    parser.add_argument("--dry-run", action="store_true", help="run every gate, then stop before backup and swap")
    parser.add_argument("--self-test", action="store_true")
    args = parser.parse_args()
    if args.self_test:
        return self_test()
    import fcntl
    os.umask(0o077)
    args.state.mkdir(mode=0o700, parents=True, exist_ok=True)
    with (args.state / "lock").open("w") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        if args.status:
            sha, deployed = github("commits/master")["sha"], running_revision()
            blocked = (args.state / "blocked").read_text().strip() if (args.state / "blocked").exists() else ""
            print(f"production {deployed[:12]}; master {sha[:12]}; " + ("caught up" if sha == deployed else "behind")
                  + (f"; blocked: {blocked}" if blocked else ""))
        else:
            poll(args.state, args.dry_run)


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(str(error) if type(error) is RuntimeError else f"aries deploy controller failed ({type(error).__name__})")
        sys.exit(1)
