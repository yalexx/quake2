#!/usr/bin/env python3
"""Draw the Quake 2 app icon: the Q2 crescent mark, in the game's own palette.

Everything here is deterministic: the same inputs give byte-identical files, on
any machine, with no randomness beyond integer hashes of the pixel coordinates
and no anti-aliasing anywhere.  The master is drawn on a 128x128 logical grid --
a 64-unit design square at two pixels per unit, which is as coarse as the mark
can be drawn before the crescent's arms fall below a pixel -- and every asset is
a NEAREST rescale of it, so the 256 icon is the master made of 2x2 blocks.

Why 128 and not 64: the reference's thinnest stroke (the crescent's arm) is 11
of the emblem's 409 pixels, i.e. 1.6 design units.  Drawn at one pixel per unit
that stroke is 1-2 pixels and the silhouette scores 0.795 against the reference;
drawn at two it is 3.5 pixels and scores 0.848 (docs/icon.md has both numbers).

The shape is the mark measured off the reference logo (docs/icon.md records the
measurements): a crescent bowl that opens at the top, the "II" bar and prongs
inside it, and the two prongs carrying on below the bowl as the tail.  Every
geometric constant below is a reference-pixel measurement, mapped through RX/RY
so the drawing and the measurement can be compared one-to-one.

The colours are not invented either: the palette is read out of the game's own
archives -- the 256-colour palette stored in pics/colormap.pcx (the same table
pics/m_main_logo.pcx carries), inside baseq2/pak0.pak.

  python3 scripts/draw-icon.py              # write every asset
  python3 scripts/draw-icon.py --check      # draw, compare with what is on disk
  python3 scripts/draw-icon.py --pak PATH   # read the palette from another pak
"""

from __future__ import annotations

import argparse
import hashlib
import struct
import sys
from io import BytesIO
from pathlib import Path

import numpy as np
from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
PAK = ROOT / "baseq2" / "pak0.pak"

GRID = 128                    # pixels the icon is drawn on (design units x 2)
OUT_FAVICON = ROOT / "favicon.png"
OUT_ICO = ROOT / "favicon.ico"
OUT_APPLE = ROOT / "apple-touch-180.png"
OUT_ICON = ROOT / "icon" / "quake2-256.png"
ICO_SIZES = (16, 32, 48, 64)
ICON_SIZES = ((OUT_FAVICON, 64), (OUT_APPLE, 180), (OUT_ICON, 256))

# ---------------------------------------------------------------------------
# The reference logo, measured (all numbers are reference-image pixels; see
# docs/icon.md for how each was taken).
#
# The emblem occupies x 203..498, y 97..505; its vertical centre is y=301 and
# its horizontal centre x=350.5.  Everything is designed in a 64-unit square
# (DESIGN) with the emblem 58 units tall and centred, and that design is drawn
# on a grid twice as fine (GRID=128), so the thinnest stroke in the mark -- the
# crescent's arm, 11 reference pixels -- is 3.5 pixels rather than 1.8.
REF_TOP, REF_BOTTOM = 97.0, 505.0
REF_CX, REF_CY = 350.5, 301.0
DESIGN = 64.0                              # design units across the canvas
EMBLEM_UNITS = 58.0                        # the emblem's height, in design units
K = EMBLEM_UNITS / (REF_BOTTOM - REF_TOP)  # reference pixels -> design units


def RX(x: float) -> float:
    """Reference x -> design units."""
    return DESIGN / 2.0 + (x - REF_CX) * K


def RY(y: float) -> float:
    """Reference y -> design units."""
    return DESIGN / 2.0 + (y - REF_CY) * K


# --- the bowl: an outer disc with an oval void punched out of its top part,
# cut open at the top so the arms end in the two tips.  Both curves are least-
# squares fits to the reference's edge points, then refined against the
# silhouette (docs/icon.md has the fit residuals).
BOWL_CX, BOWL_CY, BOWL_R = 350.5, 247.3, 146.0      # outer boundary, fitted to 210 edge points
VOID_CX, VOID_CY, VOID_A, VOID_B = 349.8, 230.0, 127.5, 121.5   # inner void, fitted to 463 edge points
TIP_LEFT, TIP_RIGHT = 242.7, 289.0                  # degrees, image coords (y down): the opening is 46.3 deg

# --- the inner mark: a bar across the top, two prongs hanging from it.
BAR_X0, BAR_X1, BAR_Y0, BAR_Y1 = 308.0, 394.0, 289.0, 301.0
LEG_L, LEG_R, LEG_HALF = 332.3, 368.8, 15.0
TAPER_Y0, TAPER_Y1, TIP_HALF = 414.0, 505.0, 4.0    # prongs taper into the tail spikes from here down

# --- the gap between the prongs, and the keel it is bridged by.
NOTCH_CX, NOTCH_HALF, NOTCH_Y = 350.5, 5.0, 305.0   # open from just under the bar ...
KEEL_Y0, KEEL_Y1 = 351.0, 372.0                     # ... solid across the bowl's underside ...

# --- the barb on the right-hand tip: the arm ends in a narrow nub that carries
# on up past the arc (reference x 391..401, y 97..118, drawn as one clean piece
# so it reads as a barb rather than the reference photograph's speckle).
SPUR_REF = ((391, 118), (401, 118), (401, 97), (391, 97))

# ---------------------------------------------------------------------------
# Palette roles.  Every index below is looked up in the game's palette; the
# numbers in the comments are the RGB that index carries there.
PLATE_RAMP = (0, 142, 159, 1, 47, 46, 45, 2)        # 0..31 luminance near-blacks
INK_RAMP = (5, 6, 7, 8, 9, 10, 11, 12)              # 75..187 greys: the stone the mark is cut from
INK_HI, INK_LO = 11, 7


def read_palette(pak_path: Path) -> tuple[np.ndarray, dict]:
    """The 256-colour palette the game draws with, read out of the PAK itself.

    A Quake 2 PAK is "PACK", u32 directory offset, u32 directory length, then
    fixed 64-byte entries (name[56], u32 offset, u32 length).  pics/colormap.pcx
    ends with the 768-byte palette table every WAL and most PCX pictures in the
    archive are indexed against; pics/m_main_logo.pcx carries its own copy.  Both
    are read, and required to agree on every index this icon draws with -- if
    they stopped agreeing there, the icon's colours would no longer be the
    game's, and we want to know.
    """
    pak = pak_path.read_bytes()
    if pak[:4] != b"PACK":
        raise SystemExit(f"{pak_path}: not a Quake 2 PAK (no PACK signature)")
    diroff, dirlen = struct.unpack_from("<II", pak, 4)
    entries = {}
    for off in range(diroff, diroff + dirlen, 64):
        name = pak[off:off + 56].split(b"\0")[0].decode("latin1").replace("\\", "/").lower()
        start, length = struct.unpack_from("<II", pak, off + 56)
        entries[name] = pak[start:start + length]

    def palette_of(entry: str) -> np.ndarray:
        blob = entries.get(entry)
        if blob is None or len(blob) < 769:
            raise SystemExit(f"{pak_path}: {entry} is missing or carries no palette table")
        if blob[-769] != 0x0C:                       # PCX palette marker byte
            raise SystemExit(f"{pak_path}: {entry} does not end with a 0x0C palette marker")
        return np.frombuffer(blob[-768:], dtype=np.uint8).reshape(256, 3)

    colormap = palette_of("pics/colormap.pcx")
    logo = palette_of("pics/m_main_logo.pcx")
    # The two tables agree on 246 of 256 entries; the ten that differ are 48-55
    # (browns) and 240/241 (the palette's test red and blue), where the small
    # logo picture stores white.  None of them is a colour this icon uses, and
    # that is checked here rather than assumed.
    used = sorted(set(PLATE_RAMP) | set(INK_RAMP))
    disagree = [i for i in used if not np.array_equal(colormap[i], logo[i])]
    if disagree:
        raise SystemExit(f"{pak_path}: the two palettes disagree on indices {disagree}, which this icon uses")
    return colormap.copy(), {"colormap": "pics/colormap.pcx", "logo": "pics/m_main_logo.pcx",
                             "used": used, "palette_entries_that_differ": 10}


# ---------------------------------------------------------------------------
# Deterministic noise.  Integer hashes only: no RNG state, no platform float
# behaviour, so every run draws the same stone.

def hash_noise(x: np.ndarray, y: np.ndarray, seed: int) -> np.ndarray:
    """Per-pixel noise in [0,1) from an integer hash of the grid coordinates."""
    n = (x.astype(np.int64) * 374761393 + y.astype(np.int64) * 668265263 + seed * 1442695041) & 0xFFFFFFFF
    n = (n ^ (n >> 13)) & 0xFFFFFFFF
    n = (n * 1274126177) & 0xFFFFFFFF
    n = (n ^ (n >> 16)) & 0xFFFFFFFF
    return (n & 0xFFFF).astype(np.float64) / 65536.0


def value_noise(u: np.ndarray, v: np.ndarray, cell: float, seed: int) -> np.ndarray:
    """Smoothed lattice noise in [0,1): bilinear between integer-hash corners."""
    gu, gv = u / cell, v / cell
    u0, v0 = np.floor(gu), np.floor(gv)
    fu, fv = gu - u0, gv - v0
    fu = fu * fu * (3 - 2 * fu)                      # smoothstep, so the patches are round
    fv = fv * fv * (3 - 2 * fv)
    x0, y0 = u0.astype(np.int64), v0.astype(np.int64)
    c00 = hash_noise(x0, y0, seed)
    c10 = hash_noise(x0 + 1, y0, seed)
    c01 = hash_noise(x0, y0 + 1, seed)
    c11 = hash_noise(x0 + 1, y0 + 1, seed)
    top = c00 + (c10 - c00) * fu
    bottom = c01 + (c11 - c01) * fu
    return top + (bottom - top) * fv


BAYER = np.array([[0, 8, 2, 10],
                  [12, 4, 14, 6],
                  [3, 11, 1, 9],
                  [15, 7, 13, 5]], dtype=np.float64) / 16.0


def dither_to_ramp(target: np.ndarray, ramp, palette: np.ndarray, ordered: bool = True) -> np.ndarray:
    """Map a luminance field onto a palette ramp, dithering between neighbours.

    This is the 8-bit look the game itself has: instead of a smooth gradient we
    pick between the two palette entries either side of the wanted luminance,
    more of the brighter one the closer we are to it.  The mark uses the ordered
    4x4 screen (the game's own skies and menus are ordered-dithered); the plate
    uses a hash instead, so its near-black grain scatters like stone rather than
    showing the screen as a repeating cross-hatch.
    """
    h, w = target.shape
    yy, xx = np.mgrid[0:h, 0:w]
    threshold = BAYER[yy % 4, xx % 4] if ordered else hash_noise(xx, yy, 101)
    lums = np.array([palette[i].astype(np.float64) @ [0.2126, 0.7152, 0.0722] for i in ramp])
    out = np.empty((h, w, 3), dtype=np.uint8)
    for py in range(h):
        for px in range(w):
            t = target[py, px]
            if t <= lums[0]:
                out[py, px] = palette[ramp[0]]
            elif t >= lums[-1]:
                out[py, px] = palette[ramp[-1]]
            else:
                hi = int(np.searchsorted(lums, t))
                lo = hi - 1
                frac = (t - lums[lo]) / (lums[hi] - lums[lo])
                pick = ramp[hi] if threshold[py, px] < frac else ramp[lo]
                out[py, px] = palette[pick]
    return out


# ---------------------------------------------------------------------------
# The mark.

def in_polygon(u: np.ndarray, v: np.ndarray, poly) -> np.ndarray:
    """Even-odd point-in-polygon test over an array of points."""
    inside = np.zeros(u.shape, dtype=bool)
    n = len(poly)
    for i in range(n):
        x0, y0 = poly[i]
        x1, y1 = poly[(i + 1) % n]
        if y0 == y1:
            continue                                  # horizontal edges never cross the ray
        crosses = ((y0 > v) != (y1 > v)) & (u < (x1 - x0) * (v - y0) / (y1 - y0) + x0)
        inside ^= crosses
    return inside


SPUR = tuple((RX(x), RY(y)) for x, y in SPUR_REF)


def emblem_mask(n: int = GRID) -> np.ndarray:
    """The Q2 crescent, as a boolean mask on an n x n grid.

    n=64 is the master.  Larger n is the same geometry at finer resolution and
    is only used to check the shape against the reference logo.
    """
    Y, X = np.mgrid[0:n, 0:n].astype(np.float64) + 0.5
    u = X * (DESIGN / n)                             # design units
    v = Y * (DESIGN / n)

    bowl_cx, bowl_cy, bowl_r = RX(BOWL_CX), RY(BOWL_CY), BOWL_R * K
    void_cx, void_cy = RX(VOID_CX), RY(VOID_CY)
    void_a, void_b = VOID_A * K, VOID_B * K

    dist_outer = np.hypot(u - bowl_cx, v - bowl_cy)
    dist_void = np.sqrt(((u - void_cx) / void_a) ** 2 + ((v - void_cy) / void_b) ** 2)
    angle = np.degrees(np.arctan2(v - bowl_cy, u - bowl_cx)) % 360.0
    # clockwise from the right tip through the bottom to the left tip; the
    # 43.6-degree gap between the two tip angles is the opening at the top.
    in_arc = (angle >= TIP_RIGHT) | (angle <= TIP_LEFT)
    bowl = (dist_outer <= bowl_r) & (dist_void >= 1.0) & in_arc

    mark = bowl.copy()
    # The barb on the right-hand tip: the arm does not stop at the arc, it
    # carries on up past it and comes to a point (reference x 379..401, y 97..127).
    # It is what makes the right tip the taller of the two, exactly as in the logo.
    mark |= in_polygon(u, v, SPUR)

    # the bar across the top of the inner mark
    mark |= ((u >= RX(BAR_X0)) & (u <= RX(BAR_X1)) &
             (v >= RY(BAR_Y0)) & (v <= RY(BAR_Y1)))
    # the two prongs: full width down to TAPER_Y0, then tapering into the tail
    taper = np.clip((v - RY(TAPER_Y0)) / (RY(TAPER_Y1) - RY(TAPER_Y0)), 0.0, 1.0)
    half = LEG_HALF * K + (TIP_HALF * K - LEG_HALF * K) * taper
    for leg_x in (LEG_L, LEG_R):
        mark |= ((np.abs(u - RX(leg_x)) <= half) &
                 (v >= RY(BAR_Y0)) & (v <= RY(TAPER_Y1)))
    # The gap between the prongs: open from under the bar to the keel, closed
    # across the keel (the bowl's underside bridges it), open again below it.
    gap = np.abs(u - RX(NOTCH_CX)) < NOTCH_HALF * K
    mark &= ~(gap & (((v > RY(NOTCH_Y)) & (v < RY(KEEL_Y0))) | (v > RY(KEEL_Y1))))
    return mark


def draw_master(palette: np.ndarray) -> Image.Image:
    """The GRID x GRID master: dark stone plate, the mark cut out of pale stone."""
    n = GRID
    Y, X = np.mgrid[0:n, 0:n].astype(np.float64) + 0.5
    u = X * (DESIGN / n)                             # design units, so the stone
    v = Y * (DESIGN / n)                             # keeps its scale at any grid
    mask = emblem_mask(n)

    # ---- plate: near-black stone, coarse patches over fine grain ----
    patches = value_noise(u, v, 16.0, seed=17)
    grain = value_noise(u, v, 4.0, seed=41)
    fleck = hash_noise(X, Y, 7)
    vignette = np.hypot(u - DESIGN / 2, v - DESIGN / 2) / (DESIGN * 0.72)
    plate_lum = (3.0 + 16.0 * patches ** 1.5 + 6.0 * grain
                 - 6.0 * vignette ** 2 + 1.5 * (fleck - 0.5))
    plate = dither_to_ramp(plate_lum, PLATE_RAMP, palette, ordered=False)

    # ---- the mark: pale stone, lit from above, mottled ----
    top, bottom = RY(REF_TOP), RY(REF_BOTTOM)
    span = max(bottom - top, 1e-6)
    height = np.clip((v - top) / span, 0.0, 1.0)
    mottle = value_noise(u, v, 4.5, seed=5)
    speck = hash_noise(X, Y, 23)
    # a one-pixel bevel: lit on the upper-left rim, shadowed on the lower-right
    empty = ~mask
    rim_light = mask & np.roll(empty, (1, 1), axis=(0, 1))
    rim_shade = mask & np.roll(empty, (-1, -1), axis=(0, 1))
    ink_lum = (148.0 - 20.0 * height + 13.0 * (mottle - 0.5) + 5.0 * (speck - 0.5)
               + 16.0 * rim_light - 16.0 * rim_shade)
    ink = dither_to_ramp(ink_lum, INK_RAMP, palette)

    pixels = plate.copy()
    pixels[mask] = ink[mask]

    # weathered specks on the stone: rare chips of the brightest and darkest grey
    hot = mask & (speck > 0.93)
    pixels[hot] = palette[INK_HI]
    cold = mask & (speck < 0.05)
    pixels[cold] = palette[INK_LO]

    return Image.fromarray(pixels, "RGB")


# ---------------------------------------------------------------------------
# Output

def resize_nearest(img: Image.Image, size: int) -> Image.Image:
    return img.resize((size, size), Image.Resampling.NEAREST)


def build_ico(master: Image.Image) -> bytes:
    """A 4-entry ICO holding 16/32/48/64 as PNG blobs, sizes NEAREST-scaled.

    Windows and every browser read PNG-compressed ICO entries; doing it by hand
    rather than through PIL keeps NEAREST as the only resampling that lands in
    the file (PIL's own ICO writer resizes with a smoothing filter).
    """
    blobs = []
    for size in ICO_SIZES:
        buf = BytesIO()
        resize_nearest(master, size).save(buf, format="PNG", optimize=True)
        blobs.append(buf.getvalue())
    header = struct.pack("<HHH", 0, 1, len(ICO_SIZES))
    offset = len(header) + 16 * len(ICO_SIZES)
    entries = b""
    for size, blob in zip(ICO_SIZES, blobs):
        entries += struct.pack("<BBBBHHII", size % 256, size % 256, 0, 0, 1, 32, len(blob), offset)
        offset += len(blob)
    return header + entries + b"".join(blobs)


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--pak", default=str(PAK), help="PAK to read the palette from (default: baseq2/pak0.pak)")
    ap.add_argument("--check", action="store_true", help="draw and compare with the files on disk, write nothing")
    args = ap.parse_args(argv)

    palette, _ = read_palette(Path(args.pak))
    master = draw_master(palette)
    ico = build_ico(master)

    wanted_bytes = []
    for path, size in ICON_SIZES:
        buf = BytesIO()
        resize_nearest(master, size).save(buf, format="PNG", optimize=True)
        wanted_bytes.append((path, buf.getvalue()))

    if args.check:
        bad = 0
        for (path, blob) in wanted_bytes + [(OUT_ICO, ico)]:
            if not path.exists():
                print(f"missing {path.relative_to(ROOT)}")
                bad += 1
            elif path.read_bytes() != blob:
                print(f"differs {path.relative_to(ROOT)}")
                bad += 1
            else:
                print(f"ok      {path.relative_to(ROOT)}  {len(blob)} bytes  sha256 {hashlib.sha256(blob).hexdigest()[:16]}")
        return 1 if bad else 0

    for path, blob in wanted_bytes:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(blob)
        print(f"wrote {path.relative_to(ROOT)}  {len(blob)} bytes  sha256 {hashlib.sha256(blob).hexdigest()[:16]}")
    OUT_ICO.write_bytes(ico)
    print(f"wrote {OUT_ICO.relative_to(ROOT)}  {len(ico)} bytes  sha256 {hashlib.sha256(ico).hexdigest()[:16]}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
