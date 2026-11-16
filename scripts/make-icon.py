"""Generate the app icon (assets/icon.ico) and the window favicon (public/favicon.ico).

Run once when the design changes; the outputs are committed.
    uv run --no-project --with pillow python scripts/make-icon.py

Design: the app's accent blue rounded square. Large sizes show a white sheet with a
folded corner and "M" + down arrow (Markdown). Small sizes (<= 32px) drop the sheet,
which would blur, and show a white "M" + arrow only.
Font: Segoe UI Bold from Windows (C:/Windows/Fonts/segoeuib.ttf).
"""
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parent.parent
FONT = "C:/Windows/Fonts/segoeuib.ttf"

BLUE = (0, 120, 212, 255)        # --accent
BLUE_DARK = (0, 91, 161, 255)    # --accent-h
INK = (30, 30, 46, 255)          # --bg-header
WHITE = (255, 255, 255, 255)
FOLD = (200, 222, 242, 255)

SS = 4  # supersampling factor


def arrow(d, cx, top, bottom, width, color):
    """Down arrow: shaft from top, head ending at bottom."""
    head_h = (bottom - top) * 0.45
    shaft_w = width * 0.36
    d.rectangle([cx - shaft_w / 2, top, cx + shaft_w / 2, bottom - head_h + 1], fill=color)
    d.polygon([(cx - width / 2, bottom - head_h), (cx + width / 2, bottom - head_h), (cx, bottom)], fill=color)


def draw_m(d, box, color):
    """Draw "M" fitted into box (x0, y0, x1, y1) by cap height."""
    x0, y0, x1, y1 = box
    h = y1 - y0
    size = int(h * 1.42)
    font = ImageFont.truetype(FONT, size)
    l, t, r, b = d.textbbox((0, 0), "M", font=font)
    scale = h / (b - t)
    if abs(scale - 1) > 0.02:
        font = ImageFont.truetype(FONT, max(1, int(size * scale)))
        l, t, r, b = d.textbbox((0, 0), "M", font=font)
    w = r - l
    d.text((x0 + (x1 - x0 - w) / 2 - l, y0 - t), "M", font=font, fill=color)


def render(px):
    n = px * SS
    img = Image.new("RGBA", (n, n), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    pad = n * 0.04
    d.rounded_rectangle([pad, pad, n - pad, n - pad], radius=n * 0.2, fill=BLUE)

    if px <= 32:
        # "M" + arrow, white, filling the square
        draw_m(d, (n * 0.12, n * 0.28, n * 0.66, n * 0.72), WHITE)
        arrow(d, n * 0.79, n * 0.28, n * 0.72, n * 0.26, WHITE)
    else:
        # sheet with folded top-right corner
        sx0, sy0, sx1, sy1 = n * 0.2, n * 0.13, n * 0.8, n * 0.87
        f = (sx1 - sx0) * 0.3
        d.polygon([(sx0, sy0), (sx1 - f, sy0), (sx1, sy0 + f), (sx1, sy1), (sx0, sy1)], fill=WHITE)
        d.polygon([(sx1 - f, sy0), (sx1 - f, sy0 + f), (sx1, sy0 + f)], fill=FOLD)
        # "M" + arrow on the sheet
        draw_m(d, (sx0 + n * 0.06, n * 0.44, n * 0.56, n * 0.72), INK)
        arrow(d, n * 0.66, n * 0.44, n * 0.72, n * 0.17, BLUE_DARK)

    return img.resize((px, px), Image.LANCZOS)


def main():
    sizes = [16, 20, 24, 32, 40, 48, 64, 128, 256]
    frames = {s: render(s) for s in sizes}
    (ROOT / "assets").mkdir(exist_ok=True)
    ico = ROOT / "assets" / "icon.ico"
    frames[256].save(ico, format="ICO", sizes=[(s, s) for s in sizes],
                     append_images=[frames[s] for s in sizes if s != 256])
    # Window icon: an .ico so the browser picks the small design at 16-32px
    # (a single 64px PNG gets shrunk and the "M" blurs in the title bar).
    fav = [16, 24, 32, 48, 64]
    frames[64].save(ROOT / "public" / "favicon.ico", format="ICO", sizes=[(s, s) for s in fav],
                    append_images=[frames[s] for s in fav if s != 64])
    # preview sheet for eyeballing (not committed)
    sheet = Image.new("RGBA", (sum(sizes) + 10 * len(sizes), 256), (240, 240, 240, 255))
    x = 0
    for s in sizes:
        sheet.paste(frames[s], (x, 0), frames[s])
        x += s + 10
    sheet.save(ROOT / "sandbox" / "icon-preview.png")
    print("wrote", ico, "and public/favicon.ico")


if __name__ == "__main__":
    main()
