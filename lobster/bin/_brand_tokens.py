#!/usr/bin/env python3
import re
from typing import Any

from _marketing_profile_common import list_of_strings, normalize_space, record_or_empty


HEX_COLOR_RE = re.compile(r"^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$")
GENERIC_FONT_FAMILIES = {
    "serif",
    "sans-serif",
    "system-ui",
    "ui-serif",
    "ui-sans-serif",
    "monospace",
    "ui-monospace",
    "cursive",
    "fantasy",
}
SERIF_HINTS = {"serif", "slab", "garamond", "baskerville", "playfair", "merriweather", "georgia", "times"}
MONO_HINTS = {"mono", "code", "courier", "consolas"}


def normalize_hex_color(value: Any) -> str | None:
    cleaned = normalize_space(value)
    if not cleaned:
        return None
    if not cleaned.startswith("#"):
        cleaned = f"#{cleaned}"
    if not HEX_COLOR_RE.match(cleaned):
        return None
    if len(cleaned) == 4:
        cleaned = "#" + "".join(ch * 2 for ch in cleaned[1:])
    return cleaned.lower()


def unique_colors(values: list[str]) -> list[str]:
    seen: set[str] = set()
    ordered: list[str] = []
    for value in values:
        normalized = normalize_hex_color(value)
        if not normalized or normalized in seen:
            continue
        seen.add(normalized)
        ordered.append(normalized)
    return ordered


def _rgb(color: str) -> tuple[float, float, float]:
    normalized = normalize_hex_color(color)
    if not normalized:
        return (0.0, 0.0, 0.0)
    return (
        int(normalized[1:3], 16) / 255.0,
        int(normalized[3:5], 16) / 255.0,
        int(normalized[5:7], 16) / 255.0,
    )


def relative_luminance(color: str) -> float:
    def transform(channel: float) -> float:
        return channel / 12.92 if channel <= 0.03928 else ((channel + 0.055) / 1.055) ** 2.4

    red, green, blue = _rgb(color)
    return 0.2126 * transform(red) + 0.7152 * transform(green) + 0.0722 * transform(blue)


def _contrast_ratio(left: str, right: str) -> float:
    l1 = relative_luminance(left)
    l2 = relative_luminance(right)
    lighter = max(l1, l2)
    darker = min(l1, l2)
    return (lighter + 0.05) / (darker + 0.05)


def _pick_contrast_color(background: str, palette: list[str], *, prefer_light: bool) -> str:
    ranked = sorted(palette, key=relative_luminance, reverse=prefer_light)
    for candidate in ranked:
        if _contrast_ratio(background, candidate) >= 4.0:
            return candidate
    fallback = "#ffffff" if prefer_light else "#111111"
    return fallback


def _sorted_palette(palette: list[str]) -> list[str]:
    return sorted(unique_colors(palette), key=relative_luminance)


def css_font_stack(family: str | None, *, generic_fallback: str = "sans-serif") -> str:
    cleaned = normalize_space(family)
    if not cleaned:
        if generic_fallback == "serif":
            return "ui-serif, Georgia, serif"
        if generic_fallback == "monospace":
            return "ui-monospace, SFMono-Regular, monospace"
        return "ui-sans-serif, system-ui, sans-serif"
    if cleaned.lower() in GENERIC_FONT_FAMILIES:
        return cleaned
    return f"'{cleaned}', {css_font_stack(generic_fallback, generic_fallback=generic_fallback)}"


def infer_generic_font_family(family: str | None, default: str = "sans-serif") -> str:
    cleaned = normalize_space(family).lower()
    if not cleaned:
        return default
    if any(hint in cleaned for hint in MONO_HINTS):
        return "monospace"
    if "sans" in cleaned:
        return "sans-serif"
    if any(hint in cleaned for hint in SERIF_HINTS):
        return "serif"
    return default


def build_brand_tokens(brand_kit: dict[str, Any]) -> dict[str, Any]:
    colors = record_or_empty(brand_kit.get("colors"))
    palette = unique_colors(
        [
            colors.get("primary", ""),
            colors.get("secondary", ""),
            colors.get("accent", ""),
            *list_of_strings(colors.get("palette")),
        ]
    )
    if not palette:
        raise RuntimeError("quality_gate_failed:brand_palette_missing")

    sorted_palette = _sorted_palette(palette)
    primary = normalize_hex_color(colors.get("primary")) or palette[0]
    secondary = normalize_hex_color(colors.get("secondary")) or (palette[1] if len(palette) > 1 else primary)
    accent = normalize_hex_color(colors.get("accent")) or primary
    theme_is_dark = relative_luminance(primary) < 0.42

    if theme_is_dark:
        background = sorted_palette[0]
        surface = sorted_palette[1] if len(sorted_palette) > 1 else secondary
        text = _pick_contrast_color(background, sorted_palette, prefer_light=True)
        muted = sorted_palette[-2] if len(sorted_palette) > 2 else text
    else:
        background = sorted_palette[-1]
        surface = sorted_palette[-2] if len(sorted_palette) > 1 else secondary
        text = _pick_contrast_color(background, sorted_palette, prefer_light=False)
        muted = sorted_palette[1] if len(sorted_palette) > 2 else secondary

    outline = secondary if _contrast_ratio(background, secondary) >= 1.4 else accent
    accent_contrast = _pick_contrast_color(accent, sorted_palette, prefer_light=relative_luminance(accent) < 0.45)

    font_families = list_of_strings(brand_kit.get("font_families"))
    display_family = font_families[0] if font_families else ""
    body_family = font_families[1] if len(font_families) > 1 else display_family

    return {
        "palette": {
            "primary": primary,
            "secondary": secondary,
            "accent": accent,
            "background": background,
            "surface": surface,
            "text": text,
            "muted": muted,
            "outline": outline,
            "accent_contrast": accent_contrast,
            "palette": sorted_palette,
            "theme_mode": "dark" if theme_is_dark else "light",
        },
        "typography": {
            "display_family": display_family,
            "body_family": body_family,
            "families": font_families,
            "display_stack": css_font_stack(
                display_family or "ui-sans-serif",
                generic_fallback=infer_generic_font_family(display_family, "sans-serif"),
            ),
            "body_stack": css_font_stack(
                body_family or display_family or "ui-sans-serif",
                generic_fallback=infer_generic_font_family(body_family or display_family, "sans-serif"),
            ),
        },
    }


def brand_direction_lines(brand_tokens: dict[str, Any]) -> list[str]:
    palette = record_or_empty(brand_tokens.get("palette"))
    typography = record_or_empty(brand_tokens.get("typography"))
    palette_values = [value for value in list_of_strings(palette.get("palette")) if normalize_hex_color(value)]
    palette_summary = ", ".join(palette_values[:6])
    font_values = [value for value in list_of_strings(typography.get("families")) if value]
    font_summary = ", ".join(font_values[:4]) if font_values else "Use the extracted site typography hierarchy."
    lines = []
    if palette_summary:
        lines.append(f"Brand palette: {palette_summary}.")
    if palette.get("background") and palette.get("text"):
        lines.append(
            f"Use {palette.get('background')} as the base field, {palette.get('surface')} for surfaces, "
            f"{palette.get('text')} for copy, and {palette.get('accent')} for emphasis or CTA moments."
        )
    if font_summary:
        lines.append(f"Typography: {font_summary}.")
    return lines
