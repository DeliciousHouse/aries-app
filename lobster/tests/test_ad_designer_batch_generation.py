#!/usr/bin/env python3
import io
import json
import os
import runpy
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
AD_DESIGNER = BIN_DIR / "ad-designer"
if str(BIN_DIR) not in sys.path:
    sys.path.insert(0, str(BIN_DIR))


PLATFORM_ORDER = ["meta-ads", "instagram", "linkedin", "landing-page"]


@contextmanager
def temporary_cwd(path: Path):
    previous = Path.cwd()
    os.chdir(path)
    try:
        yield
    finally:
        os.chdir(previous)


def ad_designer_input(families: list[dict]) -> dict:
    return {
        "run_id": "ad-designer-batch-test",
        "brand_slug": "acme-brand",
        "production_brief": {
            "brand_name": "Acme Brand",
            "campaign_name": "Spring Launch Proof",
            "core_message": "Launch smarter with proof",
            "offer_summary": "See the product launch system",
            "primary_cta": "Book demo",
            "proof_points": [
                "Teams ship campaigns faster",
                "Leaders see cleaner approvals",
                "Ops keeps launch quality high",
            ],
            "design_tokens": {
                "palette": {
                    "background": "#050505",
                    "surface": "#111111",
                    "text": "#f8f8f8",
                    "accent": "#ff6600",
                    "accent_contrast": "#000000",
                    "muted": "#aaaaaa",
                    "theme_mode": "dark",
                },
                "typography": {
                    "display_family": "Inter",
                    "body_family": "Inter",
                },
            },
            "testing_matrix": {
                "meta": {
                    "cold_funnel": families[:1],
                    "warm_funnel": families[1:],
                }
            },
        },
        "script_assets": {
            "meta_ad_script": {
                "hook": "Stop guessing on launch day",
                "body": [
                    "Operators see cleaner handoffs fast.",
                    "Teams approve launch assets with confidence.",
                ],
            }
        },
    }


def family(family_id: str | None, family_name: str, funnel_stage: str = "cold") -> dict:
    payload = {
        "family_name": family_name,
        "funnel_stage": funnel_stage,
        "primary_hook": f"{family_name} launch proof",
        "opening_line": f"{family_name} launch proof",
        "angle": "Lead with proof before the CTA lands",
        "hypothesis": "Proof-forward creative improves launch confidence",
        "proof_variants": [
            "Teams ship campaigns faster",
            "Leaders see cleaner approvals",
        ],
        "offer_variants": ["Book a guided launch demo"],
    }
    if family_id is not None:
        payload["family_id"] = family_id
    return payload


class FakeImageRenderer:
    def __init__(self, release_after: int) -> None:
        self.release_after = release_after
        self.condition = threading.Condition()
        self.active = 0
        self.started = 0
        self.max_active = 0
        self.calls: list[str] = []

    def __call__(self, contract: dict, destination_root: Path, filename_stem: str) -> dict:
        with self.condition:
            self.active += 1
            self.started += 1
            self.max_active = max(self.max_active, self.active)
            self.calls.append(filename_stem)
            self.condition.notify_all()
            deadline = time.monotonic() + 1.0
            while self.started < self.release_after and time.monotonic() < deadline:
                self.condition.wait(timeout=0.01)
        try:
            # Scramble completion order so the test proves ad-designer restores
            # deterministic submission order after as_completed() returns.
            if filename_stem.startswith("meta-ads"):
                time.sleep(0.03)
            elif filename_stem.startswith("instagram"):
                time.sleep(0.02)
            elif filename_stem.startswith("linkedin"):
                time.sleep(0.01)
            destination_root.mkdir(parents=True, exist_ok=True)
            image_path = destination_root / f"{filename_stem}.png"
            image_path.write_bytes(f"fake image {filename_stem}".encode("utf-8"))
            return {
                "image_path": str(image_path),
                "image_kind": "nano_banana_png",
                "nano_banana": {
                    "executed": False,
                    "status": "fake_ok",
                    "output_path": str(image_path),
                },
                "text_qa": {
                    "status": "passed",
                    "extracted_lines": [],
                },
            }
        finally:
            with self.condition:
                self.active -= 1
                self.condition.notify_all()


def run_ad_designer(payload: dict, renderer: FakeImageRenderer, env_overrides: dict[str, str] | None = None) -> dict:
    with tempfile.TemporaryDirectory() as temp_dir:
        workdir = Path(temp_dir) / "lobster-workdir"
        cache_dir = Path(temp_dir) / "stage3-cache"
        workdir.mkdir()
        env = {
            "LOBSTER_STAGE3_CACHE_DIR": str(cache_dir),
            "LOBSTER_IMAGE_PARALLELISM": "3",
        }
        if env_overrides:
            env.update(env_overrides)
        with temporary_cwd(workdir), patch.dict(os.environ, env, clear=False):
            namespace = runpy.run_path(str(AD_DESIGNER), run_name="__ad_designer_batch_test__")
            namespace["main"].__globals__["render_static_publish_asset"] = renderer
            stdout = io.StringIO()
            stderr = io.StringIO()
            with (
                patch.object(sys, "argv", [str(AD_DESIGNER), "--json", "--brand-slug", "acme-brand"]),
                patch.object(sys, "stdin", io.StringIO(json.dumps(payload))),
                patch.object(sys, "stdout", stdout),
                patch.object(sys, "stderr", stderr),
            ):
                result = namespace["main"]()
            if result != 0:
                raise AssertionError(f"ad-designer returned non-zero status {result}: {stderr.getvalue()}")
            parsed = json.loads(stdout.getvalue())
            parsed["_stderr"] = stderr.getvalue()
            parsed["_family_image_paths_exist"] = [
                Path(entry["image_path"]).exists()
                for entry in parsed.get("artifacts", {}).get("family_images", [])
            ]
            return parsed


class AdDesignerBatchGenerationTest(unittest.TestCase):
    def test_parallel_image_generation_uses_env_cap_and_returns_complete_deterministic_matrix(self) -> None:
        renderer = FakeImageRenderer(release_after=3)
        payload = run_ad_designer(
            ad_designer_input(
                [
                    family("cold-proof", "Cold Proof", "cold"),
                    family("warm-proof", "Warm Proof", "warm"),
                ]
            ),
            renderer,
            {"LOBSTER_IMAGE_PARALLELISM": "3"},
        )

        self.assertIn("with parallelism=3", payload["_stderr"])
        self.assertEqual(renderer.max_active, 3)

        family_images = payload["artifacts"]["family_images"]
        self.assertEqual(len(family_images), 8)
        pairs = [(entry["family_id"], entry["platform_slug"]) for entry in family_images]
        self.assertEqual(len(pairs), len(set(pairs)))
        self.assertEqual(
            pairs,
            [
                ("cold-proof", "meta-ads"),
                ("cold-proof", "instagram"),
                ("cold-proof", "linkedin"),
                ("cold-proof", "landing-page"),
                ("warm-proof", "meta-ads"),
                ("warm-proof", "instagram"),
                ("warm-proof", "linkedin"),
                ("warm-proof", "landing-page"),
            ],
        )
        for expected_family_id in ("cold-proof", "warm-proof"):
            self.assertEqual(
                [entry["platform_slug"] for entry in family_images if entry["family_id"] == expected_family_id],
                PLATFORM_ORDER,
            )
        image_paths = [entry["image_path"] for entry in family_images]
        self.assertEqual(len(image_paths), len(set(image_paths)))
        self.assertTrue(all(payload["_family_image_paths_exist"]))

        concepts = payload["ad_assets"]["creative_brief"]["concepts"]
        self.assertEqual(len(concepts), 2)
        for concept in concepts:
            self.assertEqual(
                [entry["platform_slug"] for entry in concept["platform_renders"]],
                PLATFORM_ORDER,
            )

    def test_family_without_id_still_populates_concept_platform_renders(self) -> None:
        renderer = FakeImageRenderer(release_after=1)
        payload = run_ad_designer(
            ad_designer_input([family(None, "Name Only Family", "cold")]),
            renderer,
            {"LOBSTER_IMAGE_PARALLELISM": "2"},
        )

        family_images = payload["artifacts"]["family_images"]
        self.assertEqual(len(family_images), 4)
        self.assertEqual({entry["family_id"] for entry in family_images}, {"Name Only Family"})
        concepts = payload["ad_assets"]["creative_brief"]["concepts"]
        self.assertEqual(len(concepts), 1)
        self.assertEqual(
            [entry["platform_slug"] for entry in concepts[0]["platform_renders"]],
            PLATFORM_ORDER,
        )

    def test_duplicate_family_ids_fail_before_rendering(self) -> None:
        renderer = FakeImageRenderer(release_after=1)
        with self.assertRaisesRegex(SystemExit, "quality_gate_failed:ad_designer:duplicate_family_id:cold-proof"):
            run_ad_designer(
                ad_designer_input(
                    [
                        family("cold-proof", "Cold Proof", "cold"),
                        family("cold-proof", "Warm Proof", "warm"),
                    ]
                ),
                renderer,
            )
        self.assertEqual(renderer.calls, [])

    def test_duplicate_output_stems_fail_before_rendering(self) -> None:
        renderer = FakeImageRenderer(release_after=1)
        with self.assertRaisesRegex(SystemExit, "quality_gate_failed:ad_designer:duplicate_output_stem:meta-ads-outcome-proof"):
            run_ad_designer(
                ad_designer_input(
                    [
                        family("meta-outcome-proof", "Meta Outcome Proof", "cold"),
                        family("outcome-proof", "Outcome Proof", "warm"),
                    ]
                ),
                renderer,
            )
        self.assertEqual(renderer.calls, [])


if __name__ == "__main__":
    unittest.main()
