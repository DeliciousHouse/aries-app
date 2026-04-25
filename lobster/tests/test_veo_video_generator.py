#!/usr/bin/env python3
import io
import json
import os
import runpy
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from contextlib import contextmanager
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


@contextmanager
def temporary_cwd(path: Path):
    previous = Path.cwd()
    os.chdir(path)
    try:
        yield
    finally:
        os.chdir(previous)


class FakeVeoRenderer:
    def __init__(self, release_after: int) -> None:
        self.release_after = release_after
        self.condition = threading.Condition()
        self.active = 0
        self.started = 0
        self.max_active = 0
        self.calls: list[dict] = []

    def __call__(
        self,
        prompt: str,
        destination: Path,
        aspect_ratio: str,
        duration_seconds: int,
        model: str | None = None,
    ) -> dict:
        with self.condition:
            self.active += 1
            self.started += 1
            self.max_active = max(self.max_active, self.active)
            call = {
                "prompt": prompt,
                "destination": str(destination),
                "aspect_ratio": aspect_ratio,
                "duration_seconds": duration_seconds,
                "model": model,
            }
            self.calls.append(call)
            self.condition.notify_all()
            released = self.condition.wait_for(lambda: self.started >= self.release_after, timeout=5.0)
            if not released:
                self.active -= 1
                self.condition.notify_all()
                raise AssertionError(
                    f"Timed out waiting for {self.release_after} concurrent video renders; "
                    f"only {self.started} started"
                )
        try:
            # Make completion order differ from submission order so the script's
            # post-processing sort has to provide deterministic output.
            if aspect_ratio == "9:16" and "Warm Proof" not in prompt:
                time.sleep(0.03)
            elif aspect_ratio == "9:16":
                time.sleep(0.02)
            elif "Warm Proof" not in prompt:
                time.sleep(0.01)
            destination.parent.mkdir(parents=True, exist_ok=True)
            destination.write_bytes(f"fake veo mp4 {destination.name}".encode("utf-8"))
            return {
                "executed": True,
                "status": "fake_ok",
                "stdout": "",
                "stderr": "",
                "returncode": 0,
                "command": [model or "fake-veo"],
                "output_path": str(destination),
                "provider": "fake_veo",
                "operation_name": f"fake/{destination.stem}",
            }
        finally:
            with self.condition:
                self.active -= 1
                self.condition.notify_all()


def run_veo_video_generator_with_fake_renderer(
    payload: dict,
    renderer: FakeVeoRenderer,
    env_overrides: dict[str, str] | None = None,
) -> dict:
    with tempfile.TemporaryDirectory() as temp_dir:
        workdir = Path(temp_dir) / "lobster-workdir"
        data_root = Path(temp_dir) / "data-root"
        cache_root = Path(temp_dir) / "stage3-cache"
        workdir.mkdir()
        env = {
            "DATA_ROOT": str(data_root),
            "LOBSTER_STAGE3_CACHE_DIR": str(cache_root),
            "GEMINI_API_KEY": "fake-key-no-network",
            "LOBSTER_VIDEO_RENDER_ENABLED": "1",
            "LOBSTER_VIDEO_PARALLELISM": "3",
        }
        if env_overrides:
            env.update(env_overrides)
        with temporary_cwd(workdir), patch.dict(os.environ, env, clear=False):
            namespace = runpy.run_path(str(VEO_VIDEO_GENERATOR), run_name="__veo_video_generator_batch_test__")
            namespace["main"].__globals__["run_veo_render"] = renderer
            stdout = io.StringIO()
            stderr = io.StringIO()
            with (
                patch.object(
                    sys,
                    "argv",
                    [
                        str(VEO_VIDEO_GENERATOR),
                        "--json",
                        "--brand-slug",
                        "acme-brand",
                        "--job-id",
                        "job-render-123",
                    ],
                ),
                patch.object(sys, "stdin", io.StringIO(json.dumps(payload))),
                patch.object(sys, "stdout", stdout),
                patch.object(sys, "stderr", stderr),
            ):
                result = namespace["main"]()
            if result != 0:
                raise AssertionError(f"veo-video-generator returned non-zero status {result}: {stderr.getvalue()}")
            parsed = json.loads(stdout.getvalue())
            parsed["_stderr"] = stderr.getvalue()
            parsed["_video_paths_exist"] = {
                variant["video_path"]: Path(variant["video_path"]).exists()
                for platform in parsed.get("video_assets", {}).get("platform_contracts", [])
                for variant in platform.get("rendered_video_variants", [])
            }
            parsed["_platform_contract_payloads"] = {
                platform["contract_path"]: json.loads(Path(platform["contract_path"]).read_text(encoding="utf-8"))
                for platform in parsed.get("video_assets", {}).get("platform_contracts", [])
            }
            return parsed


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


class VeoVideoGeneratorRenderBatchTest(unittest.TestCase):
    def test_render_enabled_uses_parallelism_and_returns_complete_platform_family_matrix(self) -> None:
        renderer = FakeVeoRenderer(release_after=3)
        payload = run_veo_video_generator_with_fake_renderer(smoke_input(), renderer)

        self.assertIn("with parallelism=3", payload["_stderr"])
        self.assertEqual(renderer.max_active, 3)
        self.assertEqual(len(renderer.calls), 4)

        video_assets = payload["video_assets"]
        self.assertEqual(video_assets["render_status"], "rendered")
        rendered_videos = video_assets["rendered_videos"]
        self.assertEqual(
            [(entry["aspect_ratio"], entry["family_id"]) for entry in rendered_videos],
            [
                ("9:16", "cold-proof"),
                ("9:16", "warm-proof"),
                ("16:9", "cold-proof"),
                ("16:9", "warm-proof"),
            ],
        )

        platforms = video_assets["platform_contracts"]
        self.assertEqual(
            [platform["platform_slug"] for platform in platforms],
            [
                "youtube-shorts",
                "tiktok",
                "instagram-reels",
                "instagram-feed-video",
                "youtube-longform",
                "stories",
                "linkedin-video",
                "x-video",
            ],
        )

        all_pairs: list[tuple[str, str]] = []
        for platform in platforms:
            contract_payload = payload["_platform_contract_payloads"][platform["contract_path"]]
            platform_slug = platform["platform_slug"]
            expected_aspect_ratio = contract_payload["platform_requirements"]["aspect_ratio"]
            variants = platform["rendered_video_variants"]
            self.assertEqual([variant["family_id"] for variant in variants], ["cold-proof", "warm-proof"])
            self.assertEqual(set(platform["rendered_video_paths_by_family"].keys()), {"cold-proof", "warm-proof"})
            self.assertEqual(len(variants), 2)
            for variant in variants:
                pair = (platform_slug, variant["family_id"])
                all_pairs.append(pair)
                self.assertEqual(variant["platform_slug"], platform_slug)
                self.assertEqual(variant["aspect_ratio"], expected_aspect_ratio)
                self.assertTrue(payload["_video_paths_exist"][variant["video_path"]], variant["video_path"])
                self.assertEqual(
                    contract_payload["rendered_video_paths_by_family"][variant["family_id"]],
                    variant["video_path"],
                )
        self.assertEqual(len(all_pairs), 16)
        self.assertEqual(len(all_pairs), len(set(all_pairs)))

    def test_duplicate_video_family_ids_fail_before_rendering(self) -> None:
        duplicated = json.loads(json.dumps(smoke_input()))
        duplicated["production_brief"]["testing_matrix"]["video"]["warm_funnel"][0]["family_id"] = "cold-proof"
        renderer = FakeVeoRenderer(release_after=1)

        with self.assertRaisesRegex(SystemExit, "quality_gate_failed:video_families:duplicate_family_id:cold-proof"):
            run_veo_video_generator_with_fake_renderer(duplicated, renderer)
        self.assertEqual(renderer.calls, [])

    def test_invalid_video_parallelism_fails_before_rendering(self) -> None:
        renderer = FakeVeoRenderer(release_after=1)
        with self.assertRaisesRegex(SystemExit, "quality_gate_failed:veo_video_generator:invalid_parallelism:nope"):
            run_veo_video_generator_with_fake_renderer(
                smoke_input(),
                renderer,
                {"LOBSTER_VIDEO_PARALLELISM": "nope"},
            )
        self.assertEqual(renderer.calls, [])


if __name__ == "__main__":
    unittest.main()
