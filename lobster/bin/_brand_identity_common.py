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
    # Only strip utility classes that have bracketed arbitrary values (e.g. text-[14px], bg-[#fff]),
    # or that are preceded/followed by a responsive prefix. The previous catch-all
    # pattern `\b(text|font|from|to|via|...)` chewed up natural English words like
    # "text-first", "end-to-end", "from-scratch", producing holes in brand copy.
    text = re.sub(
        r"\b(?:bg|text|font|tracking|max-w|min-w|min-h|max-h|from|via|to|px|py|pt|pr|pb|pl|mx|my|mt|mr|mb|ml|grid|flex|gap|items|justify|rounded|shadow|ring|border|leading)-\[[^\]\s]+\]",
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


def _clean_join_item(value: str) -> str:
    # Clean up LLM joinder artifacts: items that start with "and "/"or "/leading
    # conjunctions, or end with dangling conjunctions/punctuation. Without this,
    # feeding ["Authoritative and", "Systematic and organized", "and innovative"]
    # into _join_readable produces "... and and innovative" holes.
    cleaned = re.sub(r"^\s*(?:and|or|but|yet)\s+", "", value, flags=re.IGNORECASE)
    cleaned = re.sub(r"\s+(?:and|or|but|yet)\s*$", "", cleaned, flags=re.IGNORECASE)
    return cleaned.strip().rstrip(",.;:")


def _join_readable(items: list[str]) -> str | None:
    cleaned_items: list[str] = []
    seen: set[str] = set()
    for entry in items:
        if not isinstance(entry, str):
            continue
        cleaned = _clean_join_item(entry)
        if not cleaned:
            continue
        key = cleaned.lower()
        if key in seen:
            continue
        seen.add(key)
        cleaned_items.append(cleaned)
    if not cleaned_items:
        return None
    if len(cleaned_items) == 1:
        return cleaned_items[0]
    if len(cleaned_items) == 2:
        return f"{cleaned_items[0]} and {cleaned_items[1]}"
    return f"{', '.join(cleaned_items[:-1])}, and {cleaned_items[-1]}"


def _landing_hook(value: dict) -> str | None:
    hooks = record_or_empty(value.get("hooks"))
    return normalize_identity_text(_string_list(hooks.get("landing-page"))[0] if _string_list(hooks.get("landing-page")) else None)


def _parse_hex_luminance(hex_color: str) -> float | None:
    clean = hex_color.lstrip("#")
    if len(clean) == 3:
        clean = "".join(c * 2 for c in clean)
    if len(clean) != 6:
        return None
    try:
        r, g, b = int(clean[0:2], 16), int(clean[2:4], 16), int(clean[4:6], 16)
    except ValueError:
        return None
    return (0.299 * r + 0.587 * g + 0.114 * b) / 255


def _parse_hex_hue(hex_color: str) -> float | None:
    clean = hex_color.lstrip("#")
    if len(clean) == 3:
        clean = "".join(c * 2 for c in clean)
    if len(clean) != 6:
        return None
    try:
        r, g, b = int(clean[0:2], 16) / 255, int(clean[2:4], 16) / 255, int(clean[4:6], 16) / 255
    except ValueError:
        return None
    mx, mn = max(r, g, b), min(r, g, b)
    if mx - mn < 0.05:
        return None
    d = mx - mn
    if mx == r:
        h = ((g - b) / d + (6 if g < b else 0)) / 6
    elif mx == g:
        h = ((b - r) / d + 2) / 6
    else:
        h = ((r - g) / d + 4) / 6
    return h * 360


def _color_mood(palette: list[str]) -> str:
    luminances = [v for v in (_parse_hex_luminance(c) for c in palette) if v is not None]
    hues = [v for v in (_parse_hex_hue(c) for c in palette) if v is not None]
    avg_lum = sum(luminances) / len(luminances) if luminances else 0.5
    warm_count = sum(1 for h in hues if h < 60 or h > 300)
    cool_count = sum(1 for h in hues if 150 <= h <= 270)
    is_warm = warm_count > cool_count
    is_dark = avg_lum < 0.4
    is_bright = avg_lum > 0.65

    if is_dark and is_warm:
        return "Bold and warm with high-contrast depth"
    if is_dark and not is_warm:
        return "Sleek and modern with cool undertones"
    if is_bright and is_warm:
        return "Light and inviting with warm energy"
    if is_bright and not is_warm:
        return "Bright and clean with a cool edge"
    if is_warm:
        return "Grounded and approachable with warm tones"
    return "Balanced and professional with neutral clarity"


def _font_mood(fonts: list[str]) -> str | None:
    lower = " ".join(fonts).lower()
    if re.search(r"serif(?!.*sans)", lower) and "sans" not in lower:
        return "editorial typography"
    if re.search(r"mono|code|courier", lower):
        return "technical precision"
    if re.search(r"handwrit|script|cursive|brush", lower):
        return "handcrafted character"
    if re.search(r"display|playfair|dm\s?serif|lora|merriweather", lower):
        return "refined editorial type"
    return None


def _derive_style_vibe(explicit_style_vibe, brand_kit: dict) -> str | None:
    explicit = normalize_identity_text(explicit_style_vibe)
    if explicit:
        return explicit
    colors = record_or_empty(brand_kit.get("colors"))
    palette = _string_list(colors.get("palette"))
    fonts = _string_list(brand_kit.get("font_families"))
    if palette and fonts:
        cm = _color_mood(palette)
        fm = _font_mood(fonts)
        return f"{cm} and {fm}." if fm else f"{cm}."
    if palette:
        return f"{_color_mood(palette)}."
    if fonts:
        fm = _font_mood(fonts)
        return f"Typographic focus with {fm}." if fm else "Typographic and refined."
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
