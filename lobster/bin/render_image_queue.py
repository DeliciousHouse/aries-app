#!/usr/bin/env python3
import argparse
import json
import re
import subprocess
import sys
import time
from pathlib import Path
from typing import Any

RATE_LIMIT_PATTERNS = [
    re.compile(r"\b429\b", re.I),
    re.compile(r"rate\s*limit", re.I),
    re.compile(r"resource[_ -]?exhausted", re.I),
    re.compile(r"quota\s*exceeded", re.I),
    re.compile(r"too many requests", re.I),
]


def read_jobs(path: Path) -> list[dict[str, Any]]:
    jobs: list[dict[str, Any]] = []
    with path.open("r", encoding="utf-8") as fh:
        for line in fh:
            line = line.strip()
            if not line:
                continue
            jobs.append(json.loads(line))
    return jobs


def compact_list(items: list[str]) -> str:
    if not items:
        return "- none"
    return "\n".join(f"- {item}" for item in items)


def build_prompt(job: dict[str, Any], image_output_dir: Path) -> str:
    asset_id = job["asset_id"]
    out_path = image_output_dir / f"{asset_id}.png"
    sections = [
        "Render exactly one final social image using this compact brief. Do not create variants. Do not create multiple platforms. Do not use prior campaign context unless it is already captured below.",
        f"Asset ID: {asset_id}",
        f"Funnel stage: {job.get('funnel_stage', '')}",
        f"Platform: {job['platform']}",
        f"Aspect ratio: {job['aspect_ratio']}",
        f"Objective: {job['objective']}",
        f"Landing page: {job.get('landing_page', '')}",
        f"Headline: {job.get('headline', '')}",
        f"Body copy: {job.get('body_copy', '')}",
        f"Visual concept: {job['visual_concept']}",
        f"Style notes: {job.get('style_notes', '')}",
        "Brand constraints:\n" + compact_list(job.get("brand_constraints", [])),
        "Negative constraints:\n" + compact_list(job.get("negative_constraints", [])),
        "Exact text:\n" + compact_list(job.get("exact_text", [])),
        "Execution rules:",
        "- Generate one final image only.",
        "- No batching.",
        "- No alternative concepts.",
        f"- Save the output image to {out_path}.",
        f"- Print the saved file path for {asset_id}.",
    ]
    return "\n\n".join(section for section in sections if section.strip())


def is_rate_limited(text: str) -> bool:
    return any(pattern.search(text) for pattern in RATE_LIMIT_PATTERNS)


def call_ad_designer(agent_id: str, prompt: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [
            sys.executable,
            "./bin/invoke_skill.py",
            "--agent-id",
            agent_id,
            "--skill",
            "ad-designer",
            "--input",
            prompt,
            "--timeout",
            "3600",
        ],
        capture_output=True,
        text=True,
    )


def write_json(path: Path, payload: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8") as fh:
        json.dump(payload, fh, indent=2, ensure_ascii=False)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--agent-id", required=True)
    parser.add_argument("--jobs-file", required=True)
    parser.add_argument("--image-output-dir", required=True)
    parser.add_argument("--completed-dir", required=True)
    parser.add_argument("--failed-dir", required=True)
    parser.add_argument("--log-dir", required=True)
    parser.add_argument("--delay-seconds", type=int, default=12)
    parser.add_argument("--max-retries", type=int, default=5)
    args = parser.parse_args()

    jobs_file = Path(args.jobs_file)
    image_output_dir = Path(args.image_output_dir)
    completed_dir = Path(args.completed_dir)
    failed_dir = Path(args.failed_dir)
    log_dir = Path(args.log_dir)
    image_output_dir.mkdir(parents=True, exist_ok=True)
    completed_dir.mkdir(parents=True, exist_ok=True)
    failed_dir.mkdir(parents=True, exist_ok=True)
    log_dir.mkdir(parents=True, exist_ok=True)

    jobs = read_jobs(jobs_file)
    summary = {"completed": [], "failed": [], "skipped": []}

    for index, job in enumerate(jobs, start=1):
        asset_id = job["asset_id"]
        done_marker = completed_dir / f"{asset_id}.done.json"
        if done_marker.exists():
            summary["skipped"].append(asset_id)
            continue

        prompt = build_prompt(job, image_output_dir)
        last_payload: dict[str, Any] | None = None
        success = False

        for attempt in range(1, args.max_retries + 1):
            proc = call_ad_designer(args.agent_id, prompt)
            combined = (proc.stdout or "") + "\n" + (proc.stderr or "")
            payload = {
                "assetId": asset_id,
                "attempt": attempt,
                "exitCode": proc.returncode,
                "stdout": proc.stdout,
                "stderr": proc.stderr,
                "rateLimited": is_rate_limited(combined),
            }
            write_json(log_dir / f"{asset_id}.attempt-{attempt}.json", payload)
            last_payload = payload

            if proc.returncode == 0 and not payload["rateLimited"]:
                write_json(done_marker, payload)
                summary["completed"].append(asset_id)
                success = True
                break

            if payload["rateLimited"] and attempt < args.max_retries:
                sleep_for = args.delay_seconds * (2 ** (attempt - 1))
                time.sleep(sleep_for)
                continue

            if attempt < args.max_retries:
                time.sleep(args.delay_seconds)

        if not success:
            write_json(
                failed_dir / f"{asset_id}.failed.json",
                last_payload or {"assetId": asset_id, "error": "unknown"},
            )
            summary["failed"].append(asset_id)

        if index < len(jobs):
            time.sleep(args.delay_seconds)

    print(json.dumps(summary, indent=2))
    return 1 if summary["failed"] else 0


if __name__ == "__main__":
    raise SystemExit(main())
