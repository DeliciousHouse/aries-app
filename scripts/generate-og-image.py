"""Regenerate public/og-image.png (1200x630) from public/aries-logo.webp.

Only existing brand inputs: the cream ram-horn mark, the app background #050505
(app/globals.css --color-background), text #f8f7ff (styles/redesign/tokens.css),
and the product name/tagline already in app/layout.tsx. Run: python scripts/generate-og-image.py
Font: Segoe UI (Windows); swap FONT_* for Inter/Manrope if available.
"""
from PIL import Image, ImageDraw, ImageFont

W, H, BG, FG = 1200, 630, "#050505", "#f8f7ff"
FONT_BOLD, FONT_REG = "C:/Windows/Fonts/segoeuib.ttf", "C:/Windows/Fonts/segoeui.ttf"

img = Image.new("RGB", (W, H), BG)
logo = Image.open("public/aries-logo.webp").convert("RGBA")
logo.thumbnail((260, 260), Image.LANCZOS)
img.paste(logo, ((W - logo.width) // 2, 70), logo)

d = ImageDraw.Draw(img)
for text, font, y in (
    ("Aries AI", ImageFont.truetype(FONT_BOLD, 84), 370),
    ("Weekly Social Content Operating System", ImageFont.truetype(FONT_REG, 38), 485),
):
    d.text(((W - d.textlength(text, font=font)) / 2, y), text, font=font, fill=FG)
img.save("public/og-image.png", optimize=True)
