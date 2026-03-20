#!/usr/bin/env python3
import json
import re
from pathlib import Path
from typing import Any


def slugify(value: str, default: str = "artifact") -> str:
    slug = re.sub(r"[^a-z0-9]+", "-", (value or "").lower()).strip("-")
    return slug or default


def output_root() -> Path:
    root = Path.cwd() / "output"
    root.mkdir(parents=True, exist_ok=True)
    return root


def logs_root(run_id: str, stage_slug: str) -> Path:
    path = output_root() / "logs" / slugify(run_id, "run") / stage_slug
    path.mkdir(parents=True, exist_ok=True)
    return path


def write_stage_log(run_id: str, stage_slug: str, step_name: str, payload: Any) -> str:
    path = logs_root(run_id, stage_slug) / f"{step_name}.json"
    path.write_text(json.dumps(payload, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    return str(path)


def write_text(path: Path, text: str) -> str:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text.rstrip() + "\n", encoding="utf-8")
    return str(path)


def write_json(path: Path, payload: Any) -> str:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    return str(path)


def brand_output_paths(brand_slug: str) -> dict[str, Path]:
    root = output_root()
    slug = slugify(brand_slug, "client-brand")
    campaign_root = root / f"{slug}-campaign"
    return {
        "root": root,
        "brand_bible_md": root / f"{slug}-brand-bible.md",
        "design_system_css": root / f"{slug}-design-system.css",
        "campaign_proposal_md": root / f"{slug}-campaign-proposal.md",
        "campaign_proposal_html": root / f"{slug}-campaign-proposal.html",
        "campaign_root": campaign_root,
        "landing_pages_dir": campaign_root / "landing-pages",
        "ad_images_dir": campaign_root / "ad-images",
        "scripts_dir": campaign_root / "scripts",
        "campaign_assets_md": campaign_root / "CAMPAIGN-ASSETS.md",
    }


def competitor_output_paths(competitor: str) -> dict[str, Path]:
    root = output_root() / "meta-ads" / slugify(competitor, "competitor")
    root.mkdir(parents=True, exist_ok=True)
    return {
        "root": root,
        "extract_json": root / "meta-ads-extract.json",
        "analysis_json": root / "meta-ads-analysis.json",
        "creative_json": root / "ad-creative-analysis.json",
        "summary_json": root / "summary.json",
        "summary_md": root / "summary.md",
        "summary_html": root / "summary.html",
    }
