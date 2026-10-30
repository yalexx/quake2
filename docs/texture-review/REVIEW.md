# 4x texture set — review

## Round 2 — the material pass (298 textures, this round)

The material pass is in the shipped archives: 298 textures instead of 270,
`baseq2/pak9.pak` 25,031,035 → 41,201,057 bytes, all 298 pass
`node scripts/hires-art.mjs --check`, and
`node scripts/texture-pack.mjs --check` reports `524 packed (524 identical to
the original), 79 without art, 8 skipped, 0 failed`. The full account — the
material recipes and their counts,
the gates, what shipped, the three in-game spawn views, real-Chrome FPS on
ANGLE/Intel UHD 620, the conventions considered and the weakest remaining
materials — is in [REALISM.md](REALISM.md).

- In-game pairs: [demo1](ingame/demo1-spawn-prev-new.png),
  [demo2](ingame/demo2-spawn-prev-new.png),
  [demo3](ingame/demo3-spawn-prev-new.png); real Chrome:
  [demo1 NEW](ingame/real/demo1-NEW.png) /
  [OFF](ingame/real/demo1-OFF.png) /
  [PREV](ingame/real/demo1-PREV.png), and
  [demo2 NEW](ingame/real/demo2-NEW.png) /
  [OFF](ingame/real/demo2-OFF.png).
- Real-Chrome FPS at 1366x768: NEW 74.97 fps vs OFF 74.92 (ratio 1.001), PREV
  74.96 — every variant is pinned at the display cap (75.8 Hz measured for
  NEW), so the recorded reference of 34 vs 73 fps (0.47) did not reproduce;
  see REALISM.md §4.
- Checks run for this round: `node scripts/tex-check.mjs` — "checked 603
  pictures of 611 entries: 524 with art (42.2 MB), 298 of them at 4x (39.3 MB),
  79 without, 0 the wrong size, 0 unreadable, 0 unclaimed, 15 source
  picture(s), 8 sprite(s) drawn from their frames";
  `node scripts/texture-pack.mjs --check` — "524 packed (524 identical to the
  original), 79 without art, 8 skipped, 0 failed", both archives left alone.

---

## Round 1 — the faithful set (270 textures, previous round)

> This is the previous round's review, kept as written. Its numbers, sheets and
> dispositions describe the faithful 4x upscale; the material pass above has
> since redrawn 272 of those textures and added 28 more, for 298. The round-1
> contact sheets remain in `docs/texture-review/sheets/`.

The 270 demo textures that carry replacement art were drawn at 4x, put on contact
sheets together with the demo original and the art that was shipped before this
work, read as a set, and checked against the gates. Two textures were drawn with
the wrong recipe and were re-drawn; everything else is byte-identical to what
`scripts/hires-art.mjs` produced before this review.

### The sheets

    docs/texture-review/sheets/e1u1-01.png … e1u1-22.png   (253 textures, 12 rows a page)
    docs/texture-review/sheets/e1u2-01.png                  (9)
    docs/texture-review/sheets/e1u3-01.png                  (4)
    docs/texture-review/sheets/e2u1-01.png                  (3)
    docs/texture-review/sheets/e2u2-01.png                  (1)
    docs/texture-review/sheets/set-luminance.png            (all 270, mean colour)

One labelled row per texture with five cells: (1) the demo original from the
pristine archive, nearest-neighbour 4x; (2) the art shipped before this work
(`ee00012`), nearest 4x; (3) the new 4x art; (4) the new art tiled 2x2 at half
scale; (5) the new art box-downsampled to 1x and blown back up with nearest —
what the engine draws if `r_retexturing` is off. Rows are grouped by map and
sorted by name. `set-luminance.png` shows every texture's mean colour as a
swatch, top half the demo original and bottom half the new art, sorted by the
art's luminance; a red frame means the mean luminance moved by more than 1.5 of
255 or the hue by more than 10°.

The sheets are 21 MB in total.

### Coverage

`baseq2/pak0.pak` holds 303 WALs. 270 of them have replacement art. 249 of the
270 had replacement art before this work; the other 21 are animation frames and
family members that the old art skipped — `arrow1…3`, `arrowup1…3`, `alarm1…3`,
`endsign3`, `endsign5`, `+0btshoot2`, `+abtshoot2/3`, `+1cgrate1_1`,
`+1cgrate3_1`, `btactmach1/3`, `btelev_up3`, `lever8`, `keydran2_1` — so those
families used to flip between old art and the demo's 1x art mid-animation. They
are drawn now, which is why 21 rows on the sheets have an empty "prior art"
cell: there is nothing to put there.

The remaining 33 WALs have never had any replacement art: `clip`, `clip_mon`,
`hint` and `origin` (helper textures no mapper sees), `pipe1_1`, `grate2_6`,
`metal1_1`, `metal1_4`, `grey1_3`, `grey_p1_3`, `wtroof4_6`, `wgrate1_7`,
`grass1_8`, `ggrat2_2`, `fmet1_2`, and the complete animation families
`+0…+4comp10_1`, `+0…+1cgrate2_1` and `+0…+9comp11_1` (e1u1 31, e1u3 2). They
keep drawing the 1x art from pak0. `textureTargets()` only aims at textures that
already have a PNG, so bringing them in is a change of scope for the generator,
not a repair of the set that was reviewed here.

### Flags and dispositions

| Texture | What was seen | Evidence | Disposition |
| --- | --- | --- | --- |
| `textures/e1u1/trigger.wal` | The only red swatch on the luminance sheet (+1.52), and the picture is a brown sign reading "Trig" — a text sign drawn with the generic recipe because the name matches no sign pattern. | `meanAbsRgb` 1.73 (the set's highest) with grain allowed and the hardest unsharp on 32x32 of two colours. | **Changed**: `TEXTURE_OVERRIDES` gives it the `sign/arrow/text` recipe. `meanAbsRgb` 1.73 → 1.62, seam ratio 0.04 → 0, luminance bias 1.54 → 1.57. The bias itself cannot be removed — see below. |
| `textures/e1u1/baslt3_1.wal` | A fluorescent tube in a metal frame, the same fixture as the `baselt_*` lights, but the name matches no light pattern, so it was drawn as generic: grain and hard edge work on a glowing surface. | `meanAbsRgb` 0.45 → 0.28 and `gradient` 1.208 → 1.198 under the light recipe, all gates still pass. | **Changed**: `TEXTURE_OVERRIDES` gives it `light`. The rebuilt sheet and a native-size page read it as a glowing tube. |
| `textures/e1u1/plite1_3.wal` | The vision pass called a halo on this light. | Checked at native size: the art's luminance leaves the source 3x3 range by at most **4.5 of 255**, on **0.0%** of pixels beyond 8 levels; bias 0.04, `meanAbsRgb` 0.26. That is interpolation across a two-pixel light edge, not a rim. | Rejected, no change. |
| `arrow0…3`, `arrowup0…3`, `+0btshoot1/2` | An extra check (beyond the gates) measured how far the 4x luminance strays outside its source 3x3 range. | Worst is `arrowup2`: 15.2 levels on 0.68% of pixels more than 8 levels out; `+0btshoot1` 17.5, `baselt_4` 12.7, `timpod3` 8.8. A parameter grid (tension 0.5 → 0, sharpen 0.32 → 0.1) cuts it to 13.2 / 11.7 but never to bilinear's 0.3, and every step costs edge sharpness. | No change. The excursing pixels sit *between* the two colours meeting at the edge (e.g. `(55,249,23)` between black and `(0,255,0)`), not brighter than both, and the gate's per-channel ±4 clamp reports **0** outliers in the whole set. The arrows read as arrows on the sheets. |
| `sky1`, `timpod`, `yellow1_2`, `alarm0/1`, `basemap` | Seam questions on the tiled cell. | Art/bilinear seam ratio: worst in the set **1.076** (`alarm1`), limit 1.15; median **0.846**. `sky1`'s own wrap step is 15x its interior in the demo and 9.0x in the art — the demo's seam is inherited, not added. | No change. Nothing on the sheets showed an added seam. |

The `trigger` bias deserves its own note because it is the one number a
through-the-gates review would still point at. It is not the filter: a 15-point
grid over `tension` 0.5→0 and `sharpen` 0.32→0.1 moves the bias only between 1.49
and 1.57. It comes from the step that restores each 4x4 block's mean to the
source pixel, which leaves the outermost ring alone — on a 32x32 texture of two
palette indices that ring is a large share of the picture. It is 0.6% of full
scale, well inside gate 2 (±2), and the texture is two flat colours, so it is
documented rather than papered over by tuning one knob until the swatch turns
grey.

### Per group

Nothing was flagged in e1u2, e1u3, e2u1 or e2u2: nine, four, three and one
texture, all clean on every gate and consistent under the vision pass. e1u1
flagged two of its 253 (both above) and changed both.

Final gate values, from `docs/texture-review/hires-report.json` after the two
changes. Limits: Pearson ≥ 0.97, `meanAbsRgb` ≤ 6, luminance bias ≤ 2, seam ratio
≤ 1.15x bilinear, outliers ≤ 0.5% beyond the source 3x3 ±4, gradient ≥ 1.05.

| Group | Textures | Pearson min / median | meanAbsRgb max / median | Luma bias max / median | Seam ratio max / median | Outliers max / median | Gradient min* / median |
| --- | --- | --- | --- | --- | --- | --- | --- |
| e1u1 | 253 | 0.9941 / 0.9997 | 1.6185 / 0.1141 | 1.5682 / 0.0666 | 1.076 / 0.847 | 0 / 0 | 1.000* / 1.4535 |
| e1u2 | 9 | 0.9986 / 0.9997 | 0.5490 / 0.0717 | 0.3738 / 0.0514 | 1.060 / 0.825 | 0 / 0 | 1.3744 / 1.4486 |
| e1u3 | 4 | 0.9983 / 0.9998 | 0.3229 / 0.1410 | 0.2069 / 0.0457 | 0.926 / 0.833 | 0 / 0 | 1.2760 / 1.5048 |
| e2u1 | 3 | 0.9986 / 0.9999 | 0.2642 / 0.0624 | 0.2315 / 0.0406 | 0.900 / 0.825 | 0 / 0 | 1.4133 / 1.4356 |
| e2u2 | 1 | 1.0000 / 1.0000 | 0.0229 / 0.0229 | 0.0046 / 0.0046 | 0.762 / 0.762 | 0 / 0 | 1.5050 / 1.5050 |
| **all** | **270** | **0.9941 / 0.9997** | **1.6185 / 0.1069** | **1.5682 / 0.0628** | **1.076 / 0.846** | **0 / 0** | **1.000\* / 1.4542** |

\* `black.wal` is a uniform texture and is reproduced exactly, so its gradient is
1.000 by construction; the lowest gradient on a textured surface is
`wsupprt1_14` at 1.1366, and the highest is `pip01_1` at 1.767. Hue is stable
across the set: the largest mean-hue move is **1.1°**.

### What "better" means in this review

- **Fidelity to the demo.** Every row's cell 1 and cell 5 are the same picture at
  1x: Pearson ≥ 0.994 and a mean absolute RGB error of at most 1.62 of 255 mean
  the mip is the demo's own image, not an interpretation of it.
- **More detail, not more noise.** Gradient (a Laplacian energy ratio of the 1x
  mip against the demo) is 1.05–1.77 for every textured surface: the in-game mip
  carries the demo's structure a little more crisply, and no texture gained
  structure the demo does not have (Pearson stays ≥ 0.994).
- **No invented objects.** The art is drawn from the demo's own pixels, clamped
  to the source 3x3 ±4 with 0 outliers, so nothing is added that was not there.
- **Old art vs new.** On several rows the art shipped before this work was a
  different or blurred design (`wgrate1_8`, `wsupprt1_14`, `endsign6`,
  `trigger`); the new art restores the demo's own look at 4x, and no page
  description called the old art better than the new. The old art was also
  missing 21 animation frames, which the new set fills in.
- **Reads as it should.** From the page descriptions: grates read as grates and
  vents, crates as crates (with the stencilled eagle), lights as glowing tubes,
  water as water, blood and grime as blood and grime, diamond plate and hazard
  stripes as themselves. Text stays legible at 4x: "INSTALLATION", "COM CENTER",
  "UNSTABLE RADIATION", "BASEMAP" with its "GRAYFOX" label, "Trig", "KUTPES",
  "SECURITY".

## Reproduce

    node scripts/hires-art.mjs            # draw the 298 through the material pass; a second run writes nothing
    node scripts/texture-pack.mjs         # rebuild baseq2/pak0.pak and baseq2/pak9.pak
    node scripts/texture-shots.mjs        # headless PREV/NEW/OFF pairs into docs/texture-review/ingame/
    node scripts/texture-fps.mjs          # real-Chrome FPS and screenshots into docs/texture-review/ingame/real/

Checking after the fact: `node scripts/hires-art.mjs --check` (298 pass, 0
fail), `node scripts/texture-pack.mjs --check` (524 of 524 identical, 0 failed),
`node scripts/tex-check.mjs` (0 the wrong size, 0 unreadable, 0 unclaimed).
The round-1 contact sheets are built with `node scripts/texture-sheet.mjs`;
they were not rebuilt for this round. For the round-1 set, `--check` reported
**270 pass, 0 fail** at the time, and the round-1 entries in
`hires-report.json` record that recipe, its class parameters and the two
overrides.
