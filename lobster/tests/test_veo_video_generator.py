#!/usr/bin/env python3
import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch


TESTS_DIR = Path(__file__).resolve().parent
LOBSTER_ROOT = TESTS_DIR.parent
BIN_DIR = LOBSTER_ROOT / "bin"
if str(BIN_DIR) not in sys.path:
    sys.path.insert(0, str(BIN_DIR))

from _stage3_common import video_variant_output_paths  # noqa: E402


VEO_VIDEO_GENERATOR = BIN_DIR / "veo-video-generator"


def smoke_input() -> dict:
    return {
        "run_id": "veo-storage-smoke",
        "brand_slug": "acme-brand",
        "production_brief": {
            "campaign_name": "Spring Launch Proof",
            "core_message": "Launch smarter with proof",
            "offer_summary": "See the product launch system",
            "primary_cta": "Book demo",
            "proof_points": [
                "Teams ship campaigns faster",
                "Leaders see cleaner approvals",
                "Ops keeps launch quality high",
            ],
            "constraints": {
                "compliance": "Human review stays required",
            },
            "testing_matrix": {
                "video": {
                    "cold_funnel": [
                        {
                            "family_id": "cold-proof",
                            "family_name": "Cold Proof",
                            "funnel_stage": "cold",
                            "primary_hook": "Stop guessing on launch day",
                            "opening_line": "Stop guessing on launch day",
                            "angle": "Lead with proof before the CTA lands",
                            "proof_variants": [
                                "Teams ship campaigns faster",
                                "Leaders see cleaner approvals",
                            ],
                            "offer_variants": [
                                "See the product launch system",
                            ],
                        }
                    ],
                    "warm_funnel": [
                        {
                            "family_id": "warm-proof",
                            "family_name": "Warm Proof",
                            "funnel_stage": "warm",
                            "primary_hook": "You already have demand",
                            "opening_line": "You already have demand",
                            "angle": "Show the workflow that removes launch drag",
                            "proof_variants": [
                                "Ops keeps launch quality high",
                                "Teams ship campaigns faster",
                            ],
                            "offer_variants": [
                                "Book a guided launch demo",
                            ],
                        }
                    ],
                }
            },
        },
        "script_assets": {
            "short_video_script": {
                "concept_id": "spring-launch-proof",
                "opening_line": "Stop guessing on launch day",
                "duration_seconds": 30,
                "beats": [
                    "Name the launch problem with clarity",
                    "Show the proof with concrete outcomes",
                    "Close with a confident call to action",
                ],
            },
            "meta_ad_script": {
                "body": [
                    "Operators see cleaner handoffs fast.",
                    "Teams approve launch assets with confidence.",
                ]
            },
        },
    }


class VideoVariantOutputPathsTest(unittest.TestCase):
    def test_job_scoped_paths_use_data_root(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            with patch.dict(os.environ, {"DATA_ROOT": temp_dir}, clear=False):
                paths = video_variant_output_paths(
                    "tiktok",
                    "family-a",
                    job_id="job-123",
                    campaign_id="campaign-456",
                )
            expected_root = Path(temp_dir) / "generated" / "draft" / "jobs" / "job-123" / "videos"
            self.assertEqual(paths["directory"], str(expected_root))
            self.assertEqual(paths["video_file"], str(expected_root / "tiktok-family-a.mp4"))
            self.assertEqual(paths["poster_file"], str(expected_root / "tiktok-family-a.jpg"))
            self.assertEqual(paths["captions_file"], str(expected_root / "tiktok-family-a.srt"))

    def test_legacy_paths_fall_back_to_output_tree(self) -> None:
        cwd = Path("/tmp/aries-lobster")
        paths = video_variant_output_paths(
            "youtube-shorts",
            "family-a",
            job_id="",
            campaign_id="campaign-456",
            cwd=cwd,
        )
        expected_root = cwd / "output" / "video-contracts" / "campaign-456" / "rendered" / "youtube-shorts"
        self.assertEqual(paths["directory"], str(expected_root))
        self.assertEqual(paths["video_file"], str(expected_root / "youtube-shorts-family-a.mp4"))


class VeoVideoGeneratorSmokeTest(unittest.TestCase):
    def test_smoke_output_populates_job_scoped_video_variants_when_render_is_disabled(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            data_root = Path(temp_dir) / "data-root"
            cache_root = Path(temp_dir) / "stage3-cache"
            env = {
                **os.environ,
                "DATA_ROOT": str(data_root),
                "LOBSTER_STAGE3_CACHE_DIR": str(cache_root),
                "LOBSTER_VIDEO_RENDER_ENABLED": "0",
            }
            job_id = "job-smoke-123"
            completed = subprocess.run(
                [
                    sys.executable,
                    str(VEO_VIDEO_GENERATOR),
                    "--json",
                    "--brand-slug",
                    "acme-brand",
                    "--job-id",
                    job_id,
                ],
                cwd=str(LOBSTER_ROOT),
                env=env,
                input=json.dumps(smoke_input()),
                text=True,
                capture_output=True,
                check=True,
            )

            payload = json.loads(completed.stdout)
            self.assertEqual(payload["job_id"], job_id)
            self.assertEqual(payload["video_assets"]["render_status"], "not_requested")

            expected_prefix = str(data_root / "generated" / "draft" / "jobs" / job_id / "videos")
            platforms = payload["video_assets"]["platform_contracts"]
            self.assertTrue(platforms, "expected platform contracts in veo payload")
            for platform in platforms:
                rendered_path = platform.get("rendered_video_path", "")
                self.assertTrue(rendered_path.startswith(expected_prefix))
                self.assertFalse(Path(rendered_path).exists(), "render-disabled smoke run should not write mp4 bytes")

                variants = platform.get("rendered_video_variants", [])
                self.assertGreaterEqual(len(variants), 1)
                for variant in variants:
                    self.assertTrue(variant["video_path"].startswith(expected_prefix))
                    self.assertTrue(variant["poster_path"].startswith(expected_prefix))
                    self.assertTrue(variant["captions_path"].startswith(expected_prefix))
                    self.assertIn("duration_seconds", variant)
                    self.assertIn("aspect_ratio", variant)

                contract_path = Path(platform["contract_path"])
                contract_payload = json.loads(contract_path.read_text(encoding="utf-8"))
                self.assertEqual(
                    contract_payload["rendered_video_path"],
                    rendered_path,
                )
                self.assertEqual(
                    contract_payload["rendered_video_paths_by_family"],
                    platform["rendered_video_paths_by_family"],
                )


if __name__ == "__main__":
    unittest.main()
