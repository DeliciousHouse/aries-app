#!/usr/bin/env python3
import json
import os
import re
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


WRAPPER_PHRASES = (
    "based on the brand data",
    "competitive landscape analysis",
    "here is the brand strategy",
    "brand strategy analysis",
    "based on the provided brand",
    "based on the brand identity",
    "brand strategy for",
)
LABEL_ONLY_RE = re.compile(
    r"^(problem|proof|hook|headline|opening line|cta|summary|message|core message)\s*:?\s*$",
    re.IGNORECASE,
)
TRUNCATED_LAST_TOKENS = {"and", "or", "with", "for", "to"}


def utc_now() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat()


def normalize_space(value: Any) -> str:
    return re.sub(r"\s+", " ", str(value or "")).strip()


def string_or_none(value: Any) -> str | None:
    normalized = normalize_space(value)
    return normalized or None


def record_or_empty(value: Any) -> dict[str, Any]:
    return value if isinstance(value, dict) else {}


def list_of_strings(value: Any) -> list[str]:
    if not isinstance(value, list):
        return []
    return [normalize_space(entry) for entry in value if normalize_space(entry)]


def unique_strings(values: list[str]) -> list[str]:
    seen: set[str] = set()
    ordered: list[str] = []
    for value in values:
        if value in seen:
            continue
        seen.add(value)
        ordered.append(value)
    return ordered


def contains_wrapper_language(value: Any) -> bool:
    normalized = normalize_space(value).lower()
    if not normalized:
        return False
    if LABEL_ONLY_RE.match(normalized):
        return True
    return any(phrase in normalized for phrase in WRAPPER_PHRASES)


def meaningful_token_count(value: Any) -> int:
    return len(re.findall(r"[A-Za-z0-9&']+", normalize_space(value)))


def is_truncated_phrase(value: Any) -> bool:
    normalized = normalize_space(value)
    if not normalized:
        return False
    if normalized.endswith((":", "-", "/", "(", "...")):
        return True
    tokens = re.findall(r"[A-Za-z0-9&']+", normalized.lower())
    if not tokens:
        return False
    return tokens[-1] in TRUNCATED_LAST_TOKENS


_TRAILING_PUNCT_SUFFIXES = ("...", ":", "-", "/", "(")


def repair_truncated_phrase(value: Any) -> str:
    """Strip trailing punctuation and trailing preposition/conjunction tokens
    that would cause is_truncated_phrase() to reject the string. Returns the
    cleaned value (possibly empty).

    Used to deterministically scrub LLM output before validation, since LLMs
    routinely produce copy ending with 'for'/'to'/'with'/etc. even when the
    prompt explicitly forbids it.
    """
    normalized = normalize_space(value)
    if not normalized:
        return ""
    changed = True
    while changed and normalized:
        changed = False
        for suffix in _TRAILING_PUNCT_SUFFIXES:
            if normalized.endswith(suffix):
                normalized = normalize_space(normalized[: -len(suffix)])
                changed = True
                break
        if changed:
            continue
        tokens = re.findall(r"[A-Za-z0-9&']+", normalized.lower())
        if tokens and tokens[-1] in TRUNCATED_LAST_TOKENS:
            match = re.search(
                r"\b" + re.escape(tokens[-1]) + r"\b[^A-Za-z0-9&']*$",
                normalized,
                flags=re.IGNORECASE,
            )
            if match:
                normalized = normalize_space(normalized[: match.start()].rstrip(",;:- "))
                changed = True
    return normalized


def validate_copy_text(label: str, value: Any, min_tokens: int = 3) -> str:
    normalized = normalize_space(value)
    if not normalized:
        raise RuntimeError(f"quality_gate_failed:{label}:blank")
    if contains_wrapper_language(normalized):
        raise RuntimeError(f"quality_gate_failed:{label}:wrapper_language")
    if is_truncated_phrase(normalized):
        raise RuntimeError(f"quality_gate_failed:{label}:truncated")
    if meaningful_token_count(normalized) < min_tokens:
        raise RuntimeError(f"quality_gate_failed:{label}:too_short")
    return normalized


def validate_short_text(label: str, value: Any, min_tokens: int = 1) -> str:
    normalized = normalize_space(value)
    if not normalized:
        raise RuntimeError(f"quality_gate_failed:{label}:blank")
    if contains_wrapper_language(normalized):
        raise RuntimeError(f"quality_gate_failed:{label}:wrapper_language")
    if meaningful_token_count(normalized) < min_tokens:
        raise RuntimeError(f"quality_gate_failed:{label}:too_short")
    return normalized


def validate_optional_copy_text(label: str, value: Any, min_tokens: int = 3) -> str | None:
    normalized = normalize_space(value)
    if not normalized:
        return None
    return validate_copy_text(label, normalized, min_tokens=min_tokens)


def validate_unique_copy_list(
    label: str,
    values: Any,
    *,
    min_items: int = 1,
    max_items: int | None = None,
    min_tokens: int = 3,
) -> list[str]:
    normalized = unique_strings([validate_copy_text(f"{label}[{index}]", item, min_tokens=min_tokens) for index, item in enumerate(list_of_strings(values))])
    if len(normalized) < min_items:
        raise RuntimeError(f"quality_gate_failed:{label}:too_few_items")
    if max_items is not None:
        normalized = normalized[:max_items]
    if len(normalized) != len(unique_strings(normalized)):
        raise RuntimeError(f"quality_gate_failed:{label}:duplicate_items")
    return normalized


def validate_channel_angles(value: Any) -> dict[str, str]:
    record = record_or_empty(value)
    required = ("meta", "landing-page", "video")
    normalized: dict[str, str] = {}
    for channel in required:
        normalized[channel] = validate_copy_text(
            f"channel_specific_angles.{channel}",
            record.get(channel),
            min_tokens=4,
        )
    return normalized


def validate_line_options(value: Any, label: str) -> dict[str, list[str]]:
    # Each channel must return at least 4 distinct hook/line variants so the
    # downstream campaign-planner can assign a unique primary_hook and
    # opening_line to each of its 4 creative families (Outcome proof,
    # Problem to promise, Offer clarity, Differentiated proof). Historically
    # this gate required only min_items=1, which let the LLM ship a single
    # hook per channel — campaign-planner then collapsed all 4 families onto
    # hooks[0] and the entire campaign surfaced the same headline across
    # every platform preview. Tightening to min_items=4 forces the LLM to
    # emit real variety up front.
    record = record_or_empty(value)
    required = ("meta", "landing-page", "video")
    normalized: dict[str, list[str]] = {}
    for channel in required:
        normalized[channel] = validate_unique_copy_list(
            f"{label}.{channel}",
            record.get(channel),
            min_items=4,
            max_items=6,
            min_tokens=3,
        )
    return normalized


def synthetic_public_brand_name(value: Any) -> bool:
    normalized = normalize_space(value).lower()
    if not normalized:
        return True
    if normalized.startswith("public "):
        return True
    if ".com" in normalized or ".net" in normalized or ".org" in normalized:
        return True
    if normalized.endswith(" com"):
        return True
    return False


def validate_brand_name(candidate: Any, *, canonical_name: Any = None) -> str:
    canonical = normalize_space(canonical_name)
    if canonical:
        if synthetic_public_brand_name(canonical):
            raise RuntimeError("quality_gate_failed:brand_name:synthetic")
        return canonical

    normalized = normalize_space(candidate)
    if not normalized:
        raise RuntimeError("quality_gate_failed:brand_name:blank")
    if synthetic_public_brand_name(normalized):
        raise RuntimeError("quality_gate_failed:brand_name:synthetic")
    if meaningful_token_count(normalized) < 1:
        raise RuntimeError("quality_gate_failed:brand_name:too_short")
    return normalized


def normalize_marketing_url(value: Any) -> str | None:
    normalized = normalize_space(value)
    if not normalized:
        return None
    candidate = normalized if re.match(r"^[a-z][a-z0-9+.-]*://", normalized, re.IGNORECASE) else f"https://{normalized}"
    try:
        from urllib.parse import urlparse, urlunparse

        parsed = urlparse(candidate)
        hostname = (parsed.hostname or "").lower()
        if not hostname:
            return None
        scheme = (parsed.scheme or "https").lower()
        netloc = hostname
        if parsed.port and not ((scheme == "https" and parsed.port == 443) or (scheme == "http" and parsed.port == 80)):
            netloc = f"{hostname}:{parsed.port}"
        path = parsed.path or "/"
        if path != "/":
            path = path.rstrip("/") or "/"
        return urlunparse((scheme, netloc, path, "", parsed.query, ""))
    except Exception:
        return None


def data_root() -> Path:
    candidates = [
        normalize_space(os.environ.get("DATA_ROOT")),
        normalize_space(os.environ.get("ARIES_SHARED_DATA_ROOT")),
        "/home/node/data",
        "/tmp/aries-data",
        "/data",
    ]
    raw = next((candidate for candidate in candidates if candidate), "/home/node/data")
    root = Path(raw).resolve()
    if not root.exists() or not root.is_dir():
        fallback = next(
            (Path(candidate).resolve() for candidate in candidates if candidate and Path(candidate).exists() and Path(candidate).is_dir()),
            root,
        )
        root = fallback
    allow_tmp = normalize_space(os.environ.get("ALLOW_TMP_RUNTIME_PERSISTENCE")).lower() in {"1", "true", "yes", "on"}
    if not allow_tmp and (str(root) == "/tmp" or str(root).startswith("/tmp/")):
        raise RuntimeError("runtime_persistence_unavailable:data_root_tmp")
    if not root.exists() or not root.is_dir():
        raise RuntimeError("runtime_persistence_unavailable:data_root_missing")
    return root


def validated_tenant_dir(tenant_id: str) -> Path:
    cleaned = normalize_space(tenant_id)
    if not cleaned:
        raise RuntimeError("runtime_persistence_unavailable:tenant_id_missing")
    path = data_root() / "generated" / "validated" / cleaned
    path.mkdir(parents=True, exist_ok=True)
    return path


def validated_document_path(tenant_id: str, file_name: str) -> Path:
    return validated_tenant_dir(tenant_id) / file_name


def load_json_file(path: Path) -> dict[str, Any]:
    if not path.exists() or not path.is_file():
        return {}
    try:
        parsed = json.loads(path.read_text(encoding="utf-8"))
        return parsed if isinstance(parsed, dict) else {}
    except Exception:
        return {}


def write_json_file(path: Path, payload: dict[str, Any]) -> str:
    path.parent.mkdir(parents=True, exist_ok=True)
    temp_path = path.parent / f".{path.name}.{next(tempfile._get_candidate_names())}.tmp"
    temp_path.write_text(json.dumps(payload, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    temp_path.replace(path)
    return str(path)


def extract_json_object(raw_text: str) -> dict[str, Any]:
    text = normalize_space(raw_text)
    if not text:
        return {}
    code_fence = re.search(r"```(?:json)?\s*(\{.*\})\s*```", raw_text, flags=re.DOTALL | re.IGNORECASE)
    if code_fence:
        text = code_fence.group(1)
    if text.startswith("{") and text.endswith("}"):
        try:
            parsed = json.loads(text)
            return parsed if isinstance(parsed, dict) else {}
        except json.JSONDecodeError:
            pass
    start = raw_text.find("{")
    end = raw_text.rfind("}")
    if start >= 0 and end > start:
        try:
            parsed = json.loads(raw_text[start : end + 1])
            return parsed if isinstance(parsed, dict) else {}
        except json.JSONDecodeError:
            return {}
    return {}


def tenant_slug_from_id(tenant_id: str) -> str:
    normalized = normalize_space(tenant_id).lower()
    return re.sub(r"^public_", "", normalized) or normalized


def build_business_profile_update(
    tenant_id: str,
    existing_record: dict[str, Any],
    *,
    business_name: Any = None,
    website_url: Any = None,
    competitor_url: Any = None,
    offer: Any = None,
    business_type: Any = None,
    primary_goal: Any = None,
    launch_approver_name: Any = None,
    channels: Any = None,
) -> dict[str, Any]:
    next_record = {
        "tenant_id": tenant_id,
        "business_name": existing_record.get("business_name"),
        "tenant_slug": existing_record.get("tenant_slug") or tenant_slug_from_id(tenant_id),
        "website_url": existing_record.get("website_url"),
        "business_type": existing_record.get("business_type"),
        "primary_goal": existing_record.get("primary_goal"),
        "launch_approver_user_id": existing_record.get("launch_approver_user_id"),
        "launch_approver_name": existing_record.get("launch_approver_name"),
        "offer": existing_record.get("offer"),
        "notes": existing_record.get("notes"),
        "competitor_url": existing_record.get("competitor_url"),
        "channels": list_of_strings(existing_record.get("channels")),
        "updated_at": utc_now(),
    }

    if normalize_space(business_name):
        next_record["business_name"] = validate_brand_name(business_name)
    if normalize_space(website_url):
        normalized_website_url = normalize_marketing_url(website_url)
        if not normalized_website_url:
            raise RuntimeError("quality_gate_failed:business_profile.website_url:invalid")
        next_record["website_url"] = normalized_website_url
    if normalize_space(competitor_url):
        normalized_competitor_url = normalize_marketing_url(competitor_url)
        if not normalized_competitor_url:
            raise RuntimeError("quality_gate_failed:business_profile.competitor_url:invalid")
        next_record["competitor_url"] = normalized_competitor_url
    if normalize_space(offer):
        next_record["offer"] = validate_copy_text("business_profile.offer", offer, min_tokens=3)
    if normalize_space(business_type):
        next_record["business_type"] = validate_short_text("business_profile.business_type", business_type)
    if normalize_space(primary_goal):
        next_record["primary_goal"] = validate_copy_text("business_profile.primary_goal", primary_goal, min_tokens=2)
    if normalize_space(launch_approver_name):
        next_record["launch_approver_name"] = validate_short_text(
            "business_profile.launch_approver_name",
            launch_approver_name,
            min_tokens=1,
        )
    if isinstance(channels, list) and channels:
        next_record["channels"] = unique_strings([validate_short_text("business_profile.channels", channel) for channel in channels])

    return next_record
