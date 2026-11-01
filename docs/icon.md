# The Quake 2 app icon

The ClawBox desktop shows one picture for this app: `data/icons/quake2.png`. It
used to be a hand-drawn Q2 mark; it is now the icon the game draws itself — the
crescent emblem, cut out of the game's own 256-colour palette, on a dark stone
plate, drawn as 8-bit pixel art.

Everything is produced by one script, `scripts/draw-icon.py`, from one input:
the Quake II logo supplied as the reference picture. Re-running it writes
byte-identical files (checked by `--check`), and it reads the palette out of
`baseq2/pak0.pak` rather than carrying colours of its own.

    python3 scripts/draw-icon.py            # write favicon.png, favicon.ico,
                                            # apple-touch-180.png, icon/quake2-256.png
    python3 scripts/draw-icon.py --check    # draw again, compare byte for byte

---

## 1. The reference, measured

The reference picture is a 701x525 PNG: the QUAKE II logo — a wordmark at the
top (y 28..80) and, below it, the emblem this icon is made from.

**How the emblem was separated from the picture.** The picture is dark, mottled
stone and the emblem is dirty grey-green stone on it. Thresholding the raw
luminance shatters the emblem into pieces, because its own surface is mottled:
at a threshold of 40 the ring comes apart into a dozen components. Blurring
first (Gaussian, sigma 3, on the luminance) and then thresholding at 25 holds
the emblem together (one component of 24,373 pixels), while the wall stays
below it. The wordmark, the picture's bottom-left watermark and one bright
patch of wall at x 537..559 are excluded by region and by dropping components
under 40 pixels. Enclosed specks inside the stone smaller than 40 pixels are
filled; the gap between the two prongs is far larger than that and is kept, as
it must be — filling it in would add about a tenth of the emblem's area back
as ink, and the "II" would stop reading as two prongs.

| measurement | value |
| --- | --- |
| emblem bounding box | x 203..498, y 97..505 → **296 x 409 px** (aspect 0.724) |
| emblem ink | **24,373 px**, 20.1% of that box |
| mark colour in the picture | median RGB (38, 50, 46), luminance 9 / 47 / 103 at p10 / p50 / p90 |
| plate colour in the picture | median RGB (4, 4, 5), luminance p95 = 28 |

**The bowl.** The outer edge (212 points taken from both arms, rows 135..345)
fits a circle at **(350.5, 247) R = 146.0** with a mean error of 1.35 px and a
worst case of 8.4 px — the worst cases are where the arms meet the keel at the
bottom, which the circle does not follow. The inner edge (186 points) fits an
oval at **(349.8, 230), 127.5 x 121.5**, mean error 0.97 px. The crescent is
therefore a disc with a slightly higher, slightly smaller disc punched out of
it, and the arms taper where the two curves converge.

**Stroke width.** The arm is 22 px across at the equator (3 and 9 o'clock) and
11 px at the tips — 5.4% and 2.7% of the emblem's height. It is the thinnest
thing in the mark, and it is what decided the drawing resolution (§2).

**The opening.** The arms stop at 242.7 degrees (left tip, reference (287,121))
and 289.0 degrees (right tip, reference (395,100)), measured from the bowl's
centre, y down. That is a **46.3-degree opening** at the top, centred at 265.9
degrees — a little left of straight up. The right tip is the taller of the two
because a narrow barb carries on above the arc: a 10 x 9 px nub at x 391..401,
y 97..106, which is what sets the emblem's top edge.

**Where the tail meets the bowl.** The two prongs are 30 px wide at the bar,
centred on x = 332.3 and x = 368.8, with a 6..12 px gap between them. They run
down through the bowl: the bowl's underside bridges them between y 351 (where
the inner oval ends) and y 372 (the keel's lowest point), and below that the
prongs separate again and taper to points at y = 505. That is the junction the
icon reproduces with an explicit keel: the gap between the prongs is closed
across rows 351..372 and open above and below it.

**The inner mark.** A bar across the top, x 308..394, y 289..301 (86 x 12 px),
with the two prongs hanging from it. Its top edge is 87 px wide and the prongs
31 px each — the mark is wider than the tail it feeds, which is why it reads as
a bar and not as two sticks.

**The palette.** The reference's colours are a photographic grey-green
(median (38, 50, 46)), not a palette. The icon uses no colour taken from it.
Instead the palette is the game's own, read out of `baseq2/pak0.pak`:

* `pics/colormap.pcx` — 256 x 320, whose **last 768 bytes are the 256-colour
  table** every WAL and most PCX pictures in the archive are indexed against.
  This is the table the mark is cut from: its grey ramp is index 0 = (0,0,0)
  through 5 = (75,75,75), 9 = (139,139,139), 12 = (187,187,187), 15 = (235,235,235).
* `pics/m_main_logo.pcx` — 36 x 42, the logo picture the game's main menu draws,
  and the closest thing the archive has to a ground-truth mark. It carries the
  same palette table; the two files agree on 246 of 256 entries. The ten that
  differ are indices 48..55 (browns) and 240/241 (the palette's test red and
  blue), where the small picture stores white. **None of the eighteen indices
  this icon uses is one of them**, and `read_palette()` asserts that rather than
  assuming it.
* m_main_logo itself is 8-bit dithered, no anti-aliasing, index 255 reserved as
  the transparent colour — the same way of drawing the mark that this icon uses.

## 2. Design decisions

**What is kept from the reference.** The silhouette, to scale: the bowl with its
46-degree opening, the arm taper, the tall barbed right tip, the bar and prongs,
the keel that bridges the prongs, the tapered tail, and the proportion of ink
to hole (20% of the bounding box). Nothing is redrawn "in the style of" the
reference; the geometry is the measurement, put through one mapping.

**What is deliberately not kept, and why.**

* *The reference's asymmetry.* It is a photograph of a printed logo: mirrored
  against itself the mask only scores 0.810 IoU, because the two arms differ by
  up to 8 px. The icon is drawn symmetric — an icon should be — which costs
  some of the agreement with the picture and buys an emblem that looks intended.
* *The speckle at the right tip.* At full size the barb is a detached nub with
  a two-pixel gap under it, an artefact of the print and the photograph. The
  icon draws it as one clean nub attached to the arm, at the same place and the
  same height, so it reads as a barbed point instead of a loose pixel.
* *The prong gap at the top.* In the reference it is 6..12 px — 0.85..1.7
  design units, narrower than a whole pixel on a 64-unit grid, where it
  quantises to nothing or to two pixels. It is drawn two master-pixels wide
  (one design unit, 10 reference pixels): within the reference's own range over
  the lower half of the prongs, where the gap widens to 30 px, and 4 px wider
  than the picture just under the bar. The alternative was a solid block
  between the bar and the keel, which reads as one slab instead of a "II".

**The grid.** The design lives in a **64-unit square**, the emblem 58 units
tall and centred, and the mapping is the only thing between the measurements
and the drawing:

    u = 32 + (x_ref - 350.5) * K      K = 58 / (505 - 97) = 0.14181 units/px
    v = 32 + (y_ref - 301.0) * K

The master is drawn on a **128 x 128** grid (two pixels per design unit) and
every asset is a NEAREST rescale of it. The resolution was chosen by measuring
both, not by taste:

| master | thinnest stroke | silhouette IoU vs the reference |
| --- | --- | --- |
| 64 x 64 (one pixel per unit) | 1.6 px | 0.797 |
| 96 x 96 | 2.4 px | 0.819 |
| **128 x 128 (two per unit)** | **3.5 px** | **0.848** |

At 64 the crescent's arm is a 1-2 px line and the mark visibly fattens and
breaks where it should taper; 128 is the coarsest grid on which the measured
stroke survives. (The ceiling for any grid: rendering the reference's own mask
at 84 x 116 and back scores 0.918, so 0.848 is a good way along.)

**The colours.** Eighteen palette indices, all from the game's table:

| role | indices | RGB |
| --- | --- | --- |
| plate: near-black stone | 0, 142, 159, 1, 47, 46, 45, 2 | (0,0,0) to (31,31,31) |
| mark: the stone it is cut from | 5, 6, 7, 8, 9, 10, 11, 12 | (75,75,75) to (187,187,187) |

The mark is lit from above (a luminance gradient down the emblem), mottled with
value noise, and bevelled one pixel along its upper-left rim and its lower-right
rim — the way an 8-bit game shades a stone relief. The plate is near-black with
a coarse mottle, a vignette and hash-scattered grain. Both are quantised onto
their ramp with dithering rather than anti-aliased: the mark uses the ordered
4x4 screen the game's own skies use, the plate a hash so its darkness scatters
like stone instead of showing the screen as a cross-hatch.

Behind the mark, the plate is 8.8 luminance and the mark 137.6 — a **129 delta**,
so the emblem reads at a glance on any wallpaper.

## 3. The asset set

| file | size | how |
| --- | --- | --- |
| `icon/quake2-256.png` | 256 x 256 | master x2, NEAREST — **the desktop icon** |
| `apple-touch-180.png` | 180 x 180 | master x1.40625, NEAREST |
| `favicon.png` | 64 x 64 | master x0.5, NEAREST |
| `favicon.ico` | 16, 32, 48, 64 | four PNG entries, each a NEAREST rescale of the master |

`index.html` links the favicon with a cache-busting tag (`favicon.png?v=icon1`)
so a browser that already has the old picture fetches this one.

The ICO is assembled by hand rather than through PIL: its own ICO writer
resizes with a smoothing filter, which would have put anti-aliased pixels in
the one file that must stay pixel-exact.

The 16 x 16 entry is the weakest of the set — at that size the crescent's arm
is a third of a pixel, and no NEAREST rescale of the master can hold it
together. It is included because ICOs are expected to carry it; the 32, 48 and
64 entries are the ones that read.

## 4. Verification

Measured, not judged (the checker is beside the evidence, `icon-check.py`):

| check | result |
| --- | --- |
| every asset opens in PIL at its exact size and mode | 256 RGB, 180 RGB, 64 RGB, ico 16/32/48/64 |
| the ICO holds all four sizes | 16, 32, 48, 64 — each a PNG entry |
| silhouette IoU, 256 icon vs the thresholded reference | **0.848** (180: 0.834; 64: 0.746) |
| ink vs plate luminance | 137.6 vs 8.8 → **delta 129** (needs 60) |
| bowl present | at the reference's widest row: ink on both edges of the mark's box, nothing in the middle |
| inner mark present | 82 px of ink across the middle where the bar is (the bar is 86 px wide in the reference) |
| tail present | two prongs below the bowl (112..121 and 134..143 at row 223) with the gap empty between them |
| served favicon byte-identical to the file | `GET /apps/quake2/favicon.png` from a server started in this checkout: HTTP 200, 2105 bytes, sha256 identical |

The one check that cannot pass from here: **port 4231 serves a different
checkout.** The desktop's Quake 2 app runs `node server.js` in
`~/Projects/quake2` (the main checkout, at the live build), not in this
worktree, so `GET /apps/quake2/favicon.png` there still returns the old
picture until this branch is the one that is deployed. Everything above about
the served file was measured against a server started from this checkout on
its own port, with the same `server.js`.

## 5. Reproducing

    python3 scripts/draw-icon.py             # needs numpy and Pillow
    python3 scripts/draw-icon.py --check     # must print ok for all four assets
    python3 scripts/draw-icon.py --pak baseq2/pak9.pak   # palette from another archive

The script uses no randomness: every "noise" value is an integer hash of the
pixel coordinates, so the bytes do not depend on the platform, the Python
version or the order of anything.
