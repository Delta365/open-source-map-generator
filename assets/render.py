#!/usr/bin/env python3
"""
Topographic Restraint — Open Source - Map Generator plugin assets.

Renders:
  - icon.png   (128 x 128)
  - cover.png  (1920 x 960)

Both rendered at 4x and downsampled for crispness, then a faint paper
grain is laid over the top so the ink behaves the way real ink behaves
on real paper.
"""

from __future__ import annotations

import math
import os
from PIL import Image, ImageDraw, ImageFont

# --------------------------------------------------------------------------- #
# palette — closed system: paper, two ink weights, one quiet flame.
# --------------------------------------------------------------------------- #
PAPER     = (242, 235, 220)
PAPER_DK  = (228, 219, 200)
INK_DEEP  = (28, 56, 60)
INK_MID   = (52, 84, 88)
INK_LITE  = (110, 132, 132)
ACCENT    = (200, 77, 44)

GRAIN_AMOUNT_ICON  = 4
GRAIN_AMOUNT_COVER = 6

# --------------------------------------------------------------------------- #
# fonts (canvas-design skill ships a curated TTF directory)
# --------------------------------------------------------------------------- #
FONTS_DIR = (
    "/Users/sanjivanrane/Library/Application Support/Claude/"
    "local-agent-mode-sessions/skills-plugin/"
    "1dd479fc-62d9-4a93-9518-eb038241088a/"
    "25c6f461-df4e-4e19-8dcc-0763f9bd0b9d/"
    "skills/canvas-design/canvas-fonts"
)


def load_font(name: str, size: int) -> ImageFont.FreeTypeFont:
    return ImageFont.truetype(os.path.join(FONTS_DIR, name), size)


# --------------------------------------------------------------------------- #
# helpers
# --------------------------------------------------------------------------- #
def add_grain(img: Image.Image, amount: int = 6, seed: int = 42) -> Image.Image:
    """Add subtle paper grain so the ink reads as ink on fibre, not as fill."""
    try:
        import numpy as np
        rng = np.random.default_rng(seed)
        arr = np.array(img, dtype=np.int16)
        noise = rng.integers(-amount, amount + 1, size=arr.shape, dtype=np.int16)
        arr = (arr + noise).clip(0, 255).astype("uint8")
        return Image.fromarray(arr)
    except ImportError:
        import random
        random.seed(seed)
        out = img.copy()
        px = out.load()
        for y in range(out.height):
            for x in range(out.width):
                r, g, b = px[x, y][:3]
                d = random.randint(-amount, amount)
                px[x, y] = (
                    max(0, min(255, r + d)),
                    max(0, min(255, g + d)),
                    max(0, min(255, b + d)),
                )
        return out


def contour(
    cx: float,
    cy: float,
    radius: float,
    harmonics: list[tuple[float, float, float]],
    n: int = 360,
) -> list[tuple[float, float]]:
    """Closed perturbed-circle contour (sum-of-harmonics)."""
    pts: list[tuple[float, float]] = []
    for i in range(n + 1):
        t = 2 * math.pi * i / n
        pert = sum(amp * math.sin(freq * t + phase) for amp, freq, phase in harmonics)
        rr = radius + pert
        pts.append((cx + rr * math.cos(t), cy + rr * math.sin(t)))
    return pts


def stroke_contour(
    draw: ImageDraw.ImageDraw,
    points: list[tuple[float, float]],
    color: tuple[int, int, int],
    width: int,
) -> None:
    draw.line(points, fill=color, width=width, joint="curve")


def corner_ticks(
    draw: ImageDraw.ImageDraw,
    box: tuple[float, float, float, float],
    inset: float,
    length: float,
    width: int,
    color: tuple[int, int, int],
) -> None:
    x0, y0, x1, y1 = box
    cs = [
        (x0 + inset, y0 + inset, +1, +1),
        (x1 - inset, y0 + inset, -1, +1),
        (x0 + inset, y1 - inset, +1, -1),
        (x1 - inset, y1 - inset, -1, -1),
    ]
    for cx, cy, dx, dy in cs:
        draw.line([(cx, cy), (cx + dx * length, cy)], fill=color, width=width)
        draw.line([(cx, cy), (cx, cy + dy * length)], fill=color, width=width)


# --------------------------------------------------------------------------- #
# topographic figure — the plate's principal subject
# --------------------------------------------------------------------------- #
TERRAIN_HARMONICS = [
    (1.00, 3, 0.7),
    (0.55, 5, 2.1),
    (0.32, 8, 0.3),
    (0.18, 13, 1.8),
    (0.10, 21, 0.9),
]


def draw_terrain(
    draw: ImageDraw.ImageDraw,
    cx: float,
    cy: float,
    base_r: float,
    n_contours: int,
    *,
    line_width_index: int,
    line_width_normal: int,
    perturb_scale: float = 0.13,
) -> None:
    """Stack of concentric topographic contours. Caller draws its own summit
    so each plate can choose between a plain dot and a survey marker."""
    n_pts = max(360, int(base_r * 1.6))
    for i in range(n_contours):
        f = i / max(1, n_contours - 1)         # 0 outer, 1 inner
        r = base_r * (1 - f * 0.94)
        damp = 1 - f * 0.7                     # inner contours smoother
        h = [
            (base_r * perturb_scale * amp * damp, freq, phase + f * 0.04)
            for amp, freq, phase in TERRAIN_HARMONICS
        ]
        pts = contour(cx, cy, r, h, n=n_pts)
        is_index = (i % 5 == 0)                # every 5th line = "index contour"
        stroke_contour(
            draw,
            pts,
            INK_DEEP if is_index else INK_MID,
            line_width_index if is_index else line_width_normal,
        )


def summit_dot(
    draw: ImageDraw.ImageDraw,
    cx: float,
    cy: float,
    r: float,
    color: tuple[int, int, int] = ACCENT,
) -> None:
    """Plain filled summit — used at small scales where a ring would smudge."""
    draw.ellipse([(cx - r, cy - r), (cx + r, cy + r)], fill=color)


def summit_marker(
    draw: ImageDraw.ImageDraw,
    cx: float,
    cy: float,
    r_inner: float,
    r_outer: float,
    ring_width: int,
    color: tuple[int, int, int] = ACCENT,
    ring_color: tuple[int, int, int] = INK_DEEP,
) -> None:
    """Survey-marker treatment: a filled point inside a thin ring, the way
    a trig station is drawn on a master plate."""
    draw.ellipse(
        [(cx - r_outer, cy - r_outer), (cx + r_outer, cy + r_outer)],
        outline=ring_color,
        width=ring_width,
    )
    draw.ellipse(
        [(cx - r_inner, cy - r_inner), (cx + r_inner, cy + r_inner)],
        fill=color,
    )


# --------------------------------------------------------------------------- #
# icon — 128 x 128
# --------------------------------------------------------------------------- #
def render_icon() -> Image.Image:
    SIZE = 128
    SCALE = 8
    s = SIZE * SCALE
    img = Image.new("RGB", (s, s), PAPER)
    draw = ImageDraw.Draw(img)

    # the principal subject sits on the centre line of the plate
    cx, cy = s / 2, s / 2
    base_r = s * 0.36   # slightly tighter so it breathes inside the icon's edge

    draw_terrain(
        draw, cx, cy, base_r,
        n_contours=7,
        line_width_index=int(s * 0.014),
        line_width_normal=int(s * 0.010),
        perturb_scale=0.10,
    )
    summit_dot(draw, cx, cy, s * 0.030)

    # No corner ticks at this scale: at 32x32 they vanish and at 128x128 they
    # only crowd the contour. The pattern is the icon.

    img = img.resize((SIZE, SIZE), Image.LANCZOS)
    img = add_grain(img, amount=GRAIN_AMOUNT_ICON, seed=11)
    return img


# --------------------------------------------------------------------------- #
# cover — 1920 x 960
# --------------------------------------------------------------------------- #
def render_cover() -> Image.Image:
    W, H = 1920, 960
    SCALE = 2
    s_w, s_h = W * SCALE, H * SCALE
    img = Image.new("RGB", (s_w, s_h), PAPER)
    draw = ImageDraw.Draw(img)

    # ---------- principal subject (left of centre) ------------------------- #
    hero_cx, hero_cy = s_w * 0.30, s_h * 0.50
    hero_r = s_h * 0.34

    draw_terrain(
        draw, hero_cx, hero_cy, hero_r,
        n_contours=22,
        line_width_index=4,
        line_width_normal=2,
        perturb_scale=0.13,
    )
    summit_marker(
        draw, hero_cx, hero_cy,
        r_inner=hero_r * 0.028,
        r_outer=hero_r * 0.075,
        ring_width=3,
    )

    # ---------- the export specimen — a Figma frame with the same form ----- #
    frame_w = s_w * 0.40
    frame_h = frame_w * 9 / 16              # 16:9 like a real export
    frame_x = s_w * 0.55
    frame_y = (s_h - frame_h) / 2

    # frame label, the way Figma shows frame names above the frame
    fr_label_font = load_font("GeistMono-Regular.ttf", int(s_h * 0.020))
    fr_label = "MAP  ·  1920 × 1080"
    draw.text(
        (frame_x, frame_y - s_h * 0.040),
        fr_label,
        fill=INK_MID,
        font=fr_label_font,
    )

    # the thin frame outline — kept delicate so it reads as a Figma frame
    # rather than a heavy poster border
    draw.rectangle(
        [(frame_x, frame_y), (frame_x + frame_w, frame_y + frame_h)],
        outline=INK_DEEP,
        width=3,
    )

    # the smaller terrain inside the frame — lighter on perturbation, fewer lines
    spec_cx = frame_x + frame_w * 0.50
    spec_cy = frame_y + frame_h * 0.55
    spec_r = min(frame_w, frame_h) * 0.30
    draw_terrain(
        draw, spec_cx, spec_cy, spec_r,
        n_contours=14,
        line_width_index=3,
        line_width_normal=1,
        perturb_scale=0.10,
    )
    summit_dot(draw, spec_cx, spec_cy, spec_r * 0.060)

    # ---------- title typography ------------------------------------------ #
    # Libre Baskerville: a classical book serif with the steady weight of
    # patient typesetting, paired with mono annotations for the data of the
    # discipline.
    title_size = int(s_h * 0.066)   # Baskerville is a touch heavier than
                                    # InstrumentSerif, so we drop the size
                                    # slightly to keep the same visual weight.
    title_font = load_font("LibreBaskerville-Regular.ttf", title_size)
    sub_font = load_font("GeistMono-Regular.ttf", int(s_h * 0.018))

    title_top = "Open Source"
    title_bot = "Map Generator"
    title_x = s_w * 0.054
    title_y = s_h * 0.755
    line_h = int(title_size * 1.18)   # Baskerville has a tall x-height; give
                                      # the lines more breathing room than the
                                      # InstrumentSerif setting needed.
    draw.text((title_x, title_y),               title_top, fill=INK_DEEP, font=title_font)
    draw.text((title_x, title_y + line_h),      title_bot, fill=INK_DEEP, font=title_font)

    # the discipline plate's sources line
    src_text = "MAPLIBRE   ·   OPENSTREETMAP   ·   CARTO   ·   ESRI   ·   OPENTOPOMAP"
    src_y = title_y + line_h * 2 + int(s_h * 0.018)
    draw.text((title_x, src_y), src_text, fill=INK_MID, font=sub_font)

    # ---------- marginalia (corners, coordinates, plate index) ------------- #
    meta_font = load_font("GeistMono-Regular.ttf", int(s_h * 0.014))

    plate_text = "PLATE  I  ·  TOPOGRAPHIC RESTRAINT  ·  MMXXVI"
    draw.text((title_x, s_h * 0.060), plate_text, fill=INK_MID, font=meta_font)

    # Null Island as a quiet cartographic in-joke (0°N 0°E)
    coord_text = "0°00′00″N    0°00′00″E"
    cb = draw.textbbox((0, 0), coord_text, font=meta_font)
    coord_w = cb[2] - cb[0]
    draw.text(
        (s_w - coord_w - s_w * 0.054, s_h * 0.060),
        coord_text,
        fill=INK_MID,
        font=meta_font,
    )

    # bottom-right: edition mark
    edition_text = "Open Edition"
    eb = draw.textbbox((0, 0), edition_text, font=meta_font)
    edition_w = eb[2] - eb[0]
    draw.text(
        (s_w - edition_w - s_w * 0.054, s_h - s_h * 0.078),
        edition_text,
        fill=INK_MID,
        font=meta_font,
    )

    # ---------- registration ticks ---------------------------------------- #
    corner_ticks(
        draw,
        (0, 0, s_w, s_h),
        inset=s_h * 0.040,
        length=s_h * 0.024,
        width=2,
        color=INK_DEEP,
    )

    # ---------- finish ---------------------------------------------------- #
    img = img.resize((W, H), Image.LANCZOS)
    img = add_grain(img, amount=GRAIN_AMOUNT_COVER, seed=23)
    return img


# --------------------------------------------------------------------------- #
# main
# --------------------------------------------------------------------------- #
def main() -> None:
    out_dir = os.path.dirname(os.path.abspath(__file__))

    icon = render_icon()
    icon.save(os.path.join(out_dir, "icon.png"), "PNG", optimize=True)

    cover = render_cover()
    cover.save(os.path.join(out_dir, "cover.png"), "PNG", optimize=True)

    print("rendered:")
    print(f"  {os.path.join(out_dir, 'icon.png')}  ({icon.size[0]} x {icon.size[1]})")
    print(f"  {os.path.join(out_dir, 'cover.png')}  ({cover.size[0]} x {cover.size[1]})")


if __name__ == "__main__":
    main()
