#!/usr/bin/env python
"""Deterministic post-level bootstrap for the tenant-15 posting-time contract.

Input is the JSON object returned by the read-only SQL in
``tenant-15-posting-time-measurement.md``. The implementation intentionally uses
only the Python 3.11 standard library.
"""

from __future__ import annotations

import argparse
from collections import defaultdict
import json
from pathlib import Path
import random
import statistics
from typing import Any

SEED = 20_260_819
RESAMPLES = 10_000
LOWER_QUANTILE = 0.025
UPPER_QUANTILE = 0.975
WIDE_NORMALIZED_WIDTH = 0.50


def _quantile(values: list[float], probability: float) -> float:
    """Return a linearly interpolated quantile using index (n - 1) * p."""
    if not values:
        raise ValueError("quantile requires at least one value")
    ordered = sorted(values)
    position = (len(ordered) - 1) * probability
    lower_index = int(position)
    upper_index = min(lower_index + 1, len(ordered) - 1)
    fraction = position - lower_index
    return ordered[lower_index] + fraction * (
        ordered[upper_index] - ordered[lower_index]
    )


def _numeric_engagement(value: Any) -> float | None:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    return float(value)


def _period_strata(
    posts: list[dict[str, Any]], platform: str, period: str
) -> dict[tuple[int, str], list[float]]:
    """Group measured posts by frozen account and media type.

    A post is the resampling unit. Missing engagement is excluded; a measured
    zero is retained. The SQL makes post IDs unique, so no de-duplication occurs
    here and duplicate input rows remain a visible evidence defect.
    """
    strata: dict[tuple[int, str], list[float]] = defaultdict(list)
    for post in posts:
        if post.get("platform") != platform or post.get("period") != period:
            continue
        if post.get("analysis_included") is not True:
            continue
        engagement = _numeric_engagement(post.get("engagement"))
        if engagement is None:
            continue
        account_id = post.get("account_id")
        if isinstance(account_id, bool) or not isinstance(account_id, int):
            raise ValueError(
                f"analysis row has invalid account_id for {platform}/{period}"
            )
        media_type = post.get("media_type")
        if not isinstance(media_type, str) or not media_type:
            raise ValueError(
                f"analysis row has invalid media_type for {platform}/{period}"
            )
        strata[(account_id, media_type)].append(engagement)
    return dict(strata)


def _draw_stratified(
    rng: random.Random, strata: dict[tuple[int, str], list[float]]
) -> list[float]:
    sample: list[float] = []
    for key in sorted(strata):
        values = strata[key]
        sample.extend(rng.choice(values) for _ in range(len(values)))
    return sample


def _stratum_counts(
    strata: dict[tuple[int, str], list[float]]
) -> list[dict[str, Any]]:
    return [
        {
            "account_id": account_id,
            "media_type": media_type,
            "post_count": len(strata[(account_id, media_type)]),
        }
        for account_id, media_type in sorted(strata)
    ]


def bootstrap(payload: dict[str, Any]) -> dict[str, Any]:
    contract = payload.get("contract")
    posts = payload.get("posts")
    if not isinstance(contract, dict) or contract.get("tenant_id") != 15:
        raise ValueError("input is not the tenant-15 measurement result")
    if not isinstance(posts, list) or not all(isinstance(row, dict) for row in posts):
        raise ValueError("input posts must be an array of objects")

    platforms = contract.get("treated_platforms")
    if (
        not isinstance(platforms, list)
        or not platforms
        or not all(isinstance(platform, str) and platform for platform in platforms)
    ):
        raise ValueError("treated_platforms must be a non-empty string array")

    post_ids = [row.get("post_id") for row in posts]
    if len(post_ids) != len(set(post_ids)):
        raise ValueError("post-level input contains duplicate post_id rows")

    rng = random.Random(SEED)
    results: list[dict[str, Any]] = []
    for platform in sorted(platforms):
        pre_strata = _period_strata(posts, platform, "pre")
        post_strata = _period_strata(posts, platform, "post")
        pre_values = [value for values in pre_strata.values() for value in values]
        post_values = [value for values in post_strata.values() for value in values]

        if not pre_values or not post_values:
            results.append(
                {
                    "platform": platform,
                    "status": "insufficient_sample",
                    "pre_measured_posts": len(pre_values),
                    "post_measured_posts": len(post_values),
                    "pre_strata": _stratum_counts(pre_strata),
                    "post_strata": _stratum_counts(post_strata),
                }
            )
            continue

        pre_median = float(statistics.median(pre_values))
        post_median = float(statistics.median(post_values))
        absolute_change = post_median - pre_median
        relative_change = (
            None if pre_median == 0 else absolute_change / pre_median
        )

        bootstrap_changes: list[float] = []
        for _ in range(RESAMPLES):
            sampled_pre = _draw_stratified(rng, pre_strata)
            sampled_post = _draw_stratified(rng, post_strata)
            bootstrap_changes.append(
                float(statistics.median(sampled_post))
                - float(statistics.median(sampled_pre))
            )

        lower = _quantile(bootstrap_changes, LOWER_QUANTILE)
        upper = _quantile(bootstrap_changes, UPPER_QUANTILE)
        normalized_width = (upper - lower) / max(abs(pre_median), 1.0)
        results.append(
            {
                "platform": platform,
                "status": "ok",
                "pre_measured_posts": len(pre_values),
                "post_measured_posts": len(post_values),
                "pre_median_engagement": pre_median,
                "post_median_engagement": post_median,
                "absolute_median_change": absolute_change,
                "relative_median_change": relative_change,
                "absolute_change_interval_95": [lower, upper],
                "normalized_interval_width": normalized_width,
                "wide_interval": normalized_width > WIDE_NORMALIZED_WIDTH,
                "pre_strata": _stratum_counts(pre_strata),
                "post_strata": _stratum_counts(post_strata),
            }
        )

    return {
        "tenant_id": 15,
        "seed": SEED,
        "resamples": RESAMPLES,
        "statistic": "post_median_engagement_minus_pre_median_engagement",
        "interval_method": "95% percentile with linear interpolation at (n-1)*p",
        "resampling_unit": "post",
        "strata": "platform x period x frozen account_id x media_type",
        "missing_engagement": "excluded",
        "zero_engagement": "retained",
        "zero_pre_relative_change": "null",
        "wide_rule": (
            "(upper-lower)/max(abs(pre_median),1) > "
            f"{WIDE_NORMALIZED_WIDTH:.2f}"
        ),
        "results": results,
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("measurement_json", type=Path)
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()

    with args.measurement_json.open("r", encoding="utf-8") as handle:
        payload = json.load(handle)
    result = bootstrap(payload)
    rendered = json.dumps(result, indent=2, sort_keys=True) + "\n"
    if args.output:
        args.output.write_text(rendered, encoding="utf-8")
    else:
        print(rendered, end="")


if __name__ == "__main__":
    main()
