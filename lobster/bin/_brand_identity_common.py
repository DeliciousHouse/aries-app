from __future__ import annotations

import re

from _marketing_profile_common import normalize_marketing_url, record_or_empty


def _string(value) -> str | None:
    if isinstance(value, str):
        text = value.strip()
        return text or None
    if isinstance(value, (int, float, bool)):
        return str(value)
    return None


def _string_list(value) -> list[str]:
    if not isinstance(value, list):
        return []
    result: list[str] = []
    for item in value:
        text = _string(item)
        if text:
            result.append(text)
    return result


def normalize_identity_text(value) -> str | None:
    text = _string(value)
    if not text:
        return None

    text = re.sub(r"<script[\s\S]*?</script>", " ", text, flags=re.IGNORECASE)
    text = re.sub(r"<style[\s\S]*?</style>", " ", text, flags=re.IGNORECASE)
    text = re.sub(r"\b(?:class|className|style|id|href|src|data-[\w-]+)\s*=\s*['\"][^'\"]*['\"]", " ", text, flags=re.IGNORECASE)
    text = re.sub(r"</?[a-z][^>]*>", " ", text, flags=re.IGNORECASE)
    text = re.sub(
        r"\b(?:bg|text|font|tracking|max-w|min-w|min-h|max-h|from|via|to|px|py|pt|pr|pb|pl|mx|my|mt|mr|mb|ml|grid|flex|gap|items|justify|rounded|shadow|ring|border|leading|sm:|md:|lg:|xl:|2xl:|hover:|focus:|before:|after:|group-hover:)[^\s,;)]*",
        " ",
        text,
        flags=re.IGNORECASE,
    )
    text = re.sub(r"(?:^|\s)(?:[#.][a-z0-9_-]+|::?[a-z-]+|@media|var\(--[^)]+\)|theme\([^)]+\)|calc\([^)]+\))", " ", text, flags=re.IGNORECASE)
    text = re.sub(r"[`*_#>{}\[\]|]", " ", text)
    text = re.sub(r"\s+", " ", text).strip()

    if not text:
        return None

    if re.search(r"(?:<|>|class=|classname=|bg-clip-text|bg-gradient|tracking-\[|from-\[#|via-\[#|to-\[#|var\(--|@media)", text, flags=re.IGNORECASE):
        return None

    return text


def _join_readable(items: list[str]) -> str | None:
    if not items:
        return None
    if len(items) == 1:
        return items[0]
    if len(items) == 2:
        return f"{items[0]} and {items[1]}"
    return f"{', '.join(items[:-1])}, and {items[-1]}"


def _landing_hook(value: dict) -> str | None:
    hooks = record_or_empty(value.get("hooks"))
    return normalize_identity_text(_string_list(hooks.get("landing-page"))[0] if _string_list(hooks.get("landing-page")) else None)


def _derive_style_vibe(explicit_style_vibe, brand_kit: dict) -> str | None:
    explicit = normalize_identity_text(explicit_style_vibe)
    if explicit:
        return explicit
    colors = record_or_empty(brand_kit.get("colors"))
    palette = _string_list(colors.get("palette"))
    fonts = _string_list(brand_kit.get("font_families"))
    if palette and fonts:
        return "Minimal and editorial."
    if palette:
        return "Clean and contemporary."
    if fonts:
        return "Typographic and refined."
    return None


def _derive_tone_of_voice(brand_voice, brand_kit: dict) -> str | None:
    voice_list = [normalize_identity_text(item) for item in _string_list(brand_voice)]
    voice_list = [item for item in voice_list if item]
    readable = _join_readable(voice_list)
    if readable:
        return readable if readable.endswith(".") else f"{readable}."
    return normalize_identity_text(brand_kit.get("brand_voice_summary"))


def build_brand_identity(value: dict) -> dict | None:
    brand_kit = record_or_empty(value.get("brand_kit"))
    website_url = normalize_marketing_url(value.get("website_url"))
    canonical_url = normalize_marketing_url(value.get("canonical_url") or website_url) or website_url
    audience = normalize_identity_text(value.get("audience") or value.get("audience_summary"))
    positioning = normalize_identity_text(value.get("positioning"))
    offer = normalize_identity_text(value.get("offer") or value.get("offer_summary"))
    promise = (
        normalize_identity_text(value.get("brand_promise"))
        or _landing_hook(value)
        or offer
    )
    primary_cta = normalize_identity_text(value.get("primary_cta"))
    proof_points = [normalize_identity_text(item) for item in _string_list(value.get("proof_points"))]
    proof_points = [item for item in proof_points if item]
    summary_parts = []
    for item in (positioning, offer, promise):
        if item and item not in summary_parts:
            summary_parts.append(item)
    summary = normalize_identity_text(" ".join(summary_parts))
    tone_of_voice = _derive_tone_of_voice(value.get("brand_voice"), brand_kit)
    style_vibe = _derive_style_vibe(value.get("style_vibe"), brand_kit)
    cta_style = f'Direct, action-oriented CTAs led by "{primary_cta}".' if primary_cta else None
    proof_style = "Proof-led messaging grounded in concrete outcomes and credibility signals." if proof_points else None

    if not any([summary, positioning, audience, offer, promise, tone_of_voice, style_vibe, cta_style, proof_style]):
        return None

    return {
        "summary": summary,
        "positioning": positioning,
        "audience": audience,
        "offer": offer,
        "promise": promise,
        "toneOfVoice": tone_of_voice,
        "styleVibe": style_vibe,
        "ctaStyle": cta_style,
        "proofStyle": proof_style,
        "provenance": {
            "source_url": website_url,
            "canonical_url": canonical_url,
            "source_fingerprint": canonical_url or website_url,
        },
    }
