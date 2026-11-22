"""Generate 4K-supersampled PNG and multi-resolution PNG-compressed ICO icons from public/logo.svg.

Renders public/logo.svg at 2048x2048 using a headless Chromium/Edge engine (for exact native
SVG linearGradients, clipPath, and feGaussianBlur optical bloom on a transparent RGBA canvas),
then Lanczos-downsamples via Pillow into all web, PWA, Tauri, and Windows taskbar targets.
"""

from __future__ import annotations

import io
import os
import shutil
import struct
import subprocess
import sys
import tempfile
from pathlib import Path
from typing import Dict, List, Optional, Tuple

from PIL import Image


ROOT_DIR = Path(__file__).resolve().parent.parent
SVG_PATH = ROOT_DIR / "public" / "logo.svg"
PUBLIC_DIR = ROOT_DIR / "public"
TAURI_ICONS_DIR = ROOT_DIR / "src-tauri" / "icons"

SUPERSAMPLE_SIZE = 2048

PUBLIC_PNG_TARGETS: Dict[str, int] = {
    "logo-1024.png": 1024,
    "logo-512.png": 512,
    "logo-256.png": 256,
    "logo.png": 256,
    "logo-192.png": 192,
    "logo-64.png": 64,
    "logo-32.png": 32,
}

TAURI_PNG_TARGETS: Dict[str, int] = {
    "16x16.png": 16,
    "32x32.png": 32,
    "128x128.png": 128,
    "128x128@2x.png": 256,
    "icon.png": 512,
}

ICO_SIZES: Tuple[int, ...] = (16, 24, 32, 48, 64, 128, 256)

ICO_TARGETS: Tuple[Path, ...] = (
    PUBLIC_DIR / "favicon.ico",
    TAURI_ICONS_DIR / "icon.ico",
    TAURI_ICONS_DIR / "tauf.ico",
    TAURI_ICONS_DIR / "tauf-aqua.ico",
)


def find_chromium_binary() -> Optional[str]:
    """Locate Microsoft Edge or Chromium/Chrome for native SVG rasterization."""
    for name in ("msedge", "msedge.exe", "google-chrome", "chromium", "chrome"):
        found = shutil.which(name)
        if found and os.path.isfile(found):
            return found

    candidates = [
        r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
        r"C:\Program Files\Microsoft\Edge\Application\msedge.exe",
        os.path.expandvars(r"%LOCALAPPDATA%\Microsoft\Edge\Application\msedge.exe"),
        r"C:\Program Files\Google\Chrome\Application\chrome.exe",
        r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe",
        os.path.expandvars(r"%LOCALAPPDATA%\Google\Chrome\Application\chrome.exe"),
        "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
        "/usr/bin/microsoft-edge",
        "/usr/bin/google-chrome",
        "/usr/bin/chromium",
        "/usr/bin/chromium-browser",
    ]
    for path in candidates:
        if path and os.path.isfile(path):
            return path
    return None


def render_svg_supersampled(svg_path: Path, size: int = SUPERSAMPLE_SIZE) -> Image.Image:
    """Render SVG to a transparent RGBA Pillow Image at `size`x`size`."""
    svg_text = svg_path.read_text(encoding="utf-8")
    browser = find_chromium_binary()
    if browser:
        scaled_svg = svg_text.replace(
            'width="512" height="512"',
            f'width="{size}" height="{size}"',
            1,
        )
        html = (
            "<!doctype html><html><head><meta charset='utf-8'></head>"
            "<body style='margin:0;padding:0;background:transparent;overflow:hidden;'>"
            f"{scaled_svg}</body></html>"
        )
        with tempfile.TemporaryDirectory(prefix="tauf-icon-gen-") as tmp_dir:
            tmp = Path(tmp_dir)
            html_path = tmp / "render.html"
            out_png = tmp / "master.png"
            profile_dir = tmp / "profile"
            html_path.write_text(html, encoding="utf-8")

            cmd = [
                browser,
                "--headless=new",
                "--disable-gpu",
                "--no-sandbox",
                "--force-device-scale-factor=1",
                "--default-background-color=00000000",
                "--hide-scrollbars",
                f"--user-data-dir={profile_dir}",
                f"--window-size={size},{size}",
                f"--screenshot={out_png}",
                html_path.as_uri(),
            ]
            subprocess.run(
                cmd,
                check=True,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                timeout=30,
            )
            with Image.open(out_png) as img:
                master = img.convert("RGBA")
                if master.size != (size, size):
                    master = master.resize((size, size), Image.Resampling.LANCZOS)
                return master

    # Optional vector fallback if headless Chromium is unavailable in CI
    for fallback in ("cairosvg", "resvg_py"):
        if fallback == "cairosvg":
            try:
                import cairosvg  # type: ignore

                png_bytes = cairosvg.svg2png(
                    bytestring=svg_text.encode("utf-8"),
                    output_width=size,
                    output_height=size,
                )
                return Image.open(io.BytesIO(png_bytes)).convert("RGBA")
            except ImportError:
                pass
        elif fallback == "resvg_py":
            try:
                import resvg_py  # type: ignore

                png_bytes = bytes(
                    resvg_py.svg_to_bytes(
                        svg_string=svg_text,
                        width=size,
                        height=size,
                    )
                )
                return Image.open(io.BytesIO(png_bytes)).convert("RGBA")
            except ImportError:
                pass

    raise RuntimeError(
        "No supported SVG rasterizer found (Microsoft Edge, Chrome, cairosvg, or resvg_py)."
    )


def save_png(img: Image.Image, path: Path) -> None:
    """Write an optimized RGBA PNG image with exact pixel data."""
    path.parent.mkdir(parents=True, exist_ok=True)
    img.save(path, format="PNG", optimize=True)


def write_png_ico(frames: Dict[int, Image.Image], out_path: Path) -> None:
    """Write a Windows ICO file embedding PNG-compressed RGBA frames for all target sizes."""
    out_path.parent.mkdir(parents=True, exist_ok=True)
    ordered_sizes = sorted(frames.keys())
    png_blobs: List[Tuple[int, bytes]] = []
    for sz in ordered_sizes:
        buf = io.BytesIO()
        frames[sz].save(buf, format="PNG", optimize=True)
        png_blobs.append((sz, buf.getvalue()))

    count = len(png_blobs)
    header = struct.pack("<HHH", 0, 1, count)
    offset = 6 + 16 * count
    entries: List[bytes] = []
    payloads: List[bytes] = []

    for sz, blob in png_blobs:
        dim = 0 if sz >= 256 else sz
        entry = struct.pack(
            "<BBBBHHII",
            dim,        # bWidth (0 means 256)
            dim,        # bHeight (0 means 256)
            0,          # bColorCount
            0,          # bReserved
            1,          # wPlanes
            32,         # wBitCount
            len(blob),  # dwBytesInRes
            offset,     # dwImageOffset
        )
        entries.append(entry)
        payloads.append(blob)
        offset += len(blob)

    out_path.write_bytes(header + b"".join(entries) + b"".join(payloads))


def verify_generated_assets() -> None:
    """Verify exact pixel dimensions, RGBA outer transparency, and 7-frame PNG-ICO structure."""
    expected_pngs: List[Tuple[Path, int]] = [
        (PUBLIC_DIR / name, sz) for name, sz in PUBLIC_PNG_TARGETS.items()
    ] + [
        (TAURI_ICONS_DIR / name, sz) for name, sz in TAURI_PNG_TARGETS.items()
    ]

    for png_path, expected_sz in expected_pngs:
        if not png_path.is_file():
            raise AssertionError(f"Missing generated PNG: {png_path}")
        with Image.open(png_path) as im:
            if im.mode != "RGBA":
                raise AssertionError(f"{png_path} expected RGBA, got {im.mode}")
            if im.size != (expected_sz, expected_sz):
                raise AssertionError(
                    f"{png_path} expected {(expected_sz, expected_sz)}, got {im.size}"
                )
            corners = (
                im.getpixel((0, 0)),
                im.getpixel((expected_sz - 1, 0)),
                im.getpixel((0, expected_sz - 1)),
                im.getpixel((expected_sz - 1, expected_sz - 1)),
            )
            if any(c[3] != 0 for c in corners):
                raise AssertionError(
                    f"{png_path} corners are not transparent outside squircle: {corners}"
                )

    expected_ico_sizes = {(s, s) for s in ICO_SIZES}
    for ico_path in ICO_TARGETS:
        raw = ico_path.read_bytes()
        reserved, typ, count = struct.unpack_from("<HHH", raw, 0)
        if reserved != 0 or typ != 1 or count != len(ICO_SIZES):
            raise AssertionError(f"{ico_path} invalid ICO header: {(reserved, typ, count)}")
        seen_sizes = set()
        for i in range(count):
            w, h, _, _, _, bpp, sz, off = struct.unpack_from("<BBBBHHII", raw, 6 + i * 16)
            dim = (w or 256, h or 256)
            if bpp != 32 or not raw[off : off + 8].startswith(b"\x89PNG"):
                raise AssertionError(f"{ico_path} frame {i} ({dim}) is not 32bpp PNG")
            seen_sizes.add(dim)
        if seen_sizes != expected_ico_sizes:
            raise AssertionError(
                f"{ico_path} missing ICO frames: expected {expected_ico_sizes}, got {seen_sizes}"
            )
        with Image.open(ico_path) as im:
            pillow_sizes = set(im.info.get("sizes") or ())
            if pillow_sizes != expected_ico_sizes:
                raise AssertionError(
                    f"{ico_path} Pillow info sizes mismatch: {pillow_sizes}"
                )


def main() -> int:
    if not SVG_PATH.is_file():
        print(f"ERROR: Source SVG not found: {SVG_PATH}", file=sys.stderr)
        return 1

    print(f"[generate-icons] Rasterizing {SVG_PATH.relative_to(ROOT_DIR)} at {SUPERSAMPLE_SIZE}x{SUPERSAMPLE_SIZE}...")
    master = render_svg_supersampled(SVG_PATH, SUPERSAMPLE_SIZE)

    resized_cache: Dict[int, Image.Image] = {}

    def get_frame(size: int) -> Image.Image:
        if size not in resized_cache:
            # Exact area integration (BOX) avoids sinc ringing at large integer ratios (16-48px)
            resample = Image.Resampling.BOX if size <= 48 else Image.Resampling.LANCZOS
            resized_cache[size] = master.resize((size, size), resample)
        return resized_cache[size]

    for filename, size in PUBLIC_PNG_TARGETS.items():
        out = PUBLIC_DIR / filename
        save_png(get_frame(size), out)
        print(f"  wrote {out.relative_to(ROOT_DIR)} ({size}x{size})")

    for filename, size in TAURI_PNG_TARGETS.items():
        out = TAURI_ICONS_DIR / filename
        save_png(get_frame(size), out)
        print(f"  wrote {out.relative_to(ROOT_DIR)} ({size}x{size})")

    ico_frames = {sz: get_frame(sz) for sz in ICO_SIZES}
    for ico_path in ICO_TARGETS:
        write_png_ico(ico_frames, ico_path)
        print(f"  wrote {ico_path.relative_to(ROOT_DIR)} ({len(ICO_SIZES)} PNG frames: {ICO_SIZES})")

    verify_generated_assets()
    print("[generate-icons] Verified all PNGs (exact sizes + transparent corners) and 7-frame PNG ICOs.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
