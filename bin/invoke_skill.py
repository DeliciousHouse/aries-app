#!/usr/bin/env python3
import argparse
import json
import re
import subprocess
import sys
from typing import Any


def sanitize_skill_name(name: str) -> str:
    sanitized = re.sub(r"[^a-z0-9]+", "_", name.lower()).strip("_")
    return sanitized[:32]


def build_command(agent_id: str, message: str, timeout: str, thinking: str | None, verbose: str | None, local: bool) -> list[str]:
    cmd = ["openclaw", "agent", "--message", message, "--json", "--timeout", str(timeout)]
    if agent_id:
        cmd[2:2] = ["--agent", agent_id]
    if thinking:
        cmd.extend(["--thinking", thinking])
    if verbose:
        cmd.extend(["--verbose", verbose])
    if local:
        cmd.append("--local")
    return cmd


def run_once(skill_name: str, agent_id: str, skill_input: str, timeout: str, thinking: str | None, verbose: str | None, local: bool) -> dict[str, Any]:
    message = f"/skill {skill_name}".strip()
    if skill_input.strip():
        message = f"{message} {skill_input.strip()}"

    cmd = build_command(agent_id, message, timeout, thinking, verbose, local)
    proc = subprocess.run(cmd, capture_output=True, text=True)
    stdout = proc.stdout.strip()
    stderr = proc.stderr.strip()

    try:
        parsed = json.loads(stdout) if stdout else None
    except json.JSONDecodeError:
        parsed = None

    return {
        "ok": proc.returncode == 0,
        "skill": skill_name,
        "agentId": agent_id,
        "message": message,
        "result": parsed,
        "rawStdout": None if parsed is not None else stdout,
        "stderr": stderr or None,
        "exitCode": proc.returncode,
        "command": cmd,
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--agent-id", default="main")
    parser.add_argument("--skill", required=True)
    parser.add_argument("--input", default="")
    parser.add_argument("--timeout", default="3600")
    parser.add_argument("--thinking")
    parser.add_argument("--verbose")
    parser.add_argument("--local", action="store_true")
    args = parser.parse_args()

    candidates: list[str] = []
    for candidate in [args.skill, sanitize_skill_name(args.skill)]:
        if candidate and candidate not in candidates:
            candidates.append(candidate)

    attempts: list[dict[str, Any]] = []
    final_exit = 1

    for candidate in candidates:
        payload = run_once(
            skill_name=candidate,
            agent_id=args.agent_id,
            skill_input=args.input,
            timeout=args.timeout,
            thinking=args.thinking,
            verbose=args.verbose,
            local=args.local,
        )
        attempts.append(payload)
        final_exit = payload["exitCode"]
        if payload["ok"]:
            output = {
                "ok": True,
                "requestedSkill": args.skill,
                "resolvedSkill": candidate,
                "attempts": attempts,
                "result": payload,
            }
            print(json.dumps(output, indent=2))
            return 0

    output = {
        "ok": False,
        "requestedSkill": args.skill,
        "resolvedSkill": None,
        "attempts": attempts,
    }
    print(json.dumps(output, indent=2))
    return final_exit


if __name__ == "__main__":
    raise SystemExit(main())
