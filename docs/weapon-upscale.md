# View-weapon skins at 2x, and the muzzle-collar artifact

Task t3. The 13 first-person weapons (`models/weapons/v_*/{skin,base}.pcx`) now
ship exactly 2x art inside `baseq2/pak10.pak`, their MD2s declare the doubled
skin and ST table, and the added muzzle collar is bound to the barrel it wraps
instead of a guessed 14x14 atlas patch. Entry names, paths and the count (13)
are unchanged.

## Method

**Upscale (deterministic, no dependencies).** `scripts/model-art.mjs` gained an
opt-in `--upscale-2x` mode and an exported `upscaleSkin2x()`:

- decode the pak0 PCX and build three RGB planes through its own palette,
  premultiplied by alpha (palette index 255 is the cut-out and contributes no
  colour);
- resample each plane with separable Lanczos-3 (a = 3), clamped edges, to
  exactly 2x width and height;
- unsharp mask (3x3 binomial blur, 0.55 strength) and 1.08 chroma gain about
  luma, so the doubled skin is not just softer but carries more pigment;
- re-index onto the original trailing 768-byte palette with index 255 excluded,
  then restore the cut-out as a nearest-replicated 2x mask, so every cut-out
  pixel becomes a 2x2 block and the silhouette is exact;
- encode with `texture-lib`'s `encodePcx8`, header inherited from the original
  (`bytesPerLine == width`, as the engine's row-by-pixel-count loader expects).

The same input bytes always produce the same output (`--upscale-2x` run twice
into two directories: byte-identical, 13 files, 1.6 MB of PCX).

**MD2 (pak10).** `model-geometry.mjs` doubles `skinWidth`/`skinHeight` and every
ST coordinate of each rebuilt weapon MD2, and writes the 2x PCX beside it.
Vertex and triangle counts are unchanged (baseline table in the script:
4433 -> 18034 verts, 7991 -> 32724 tris over 20 models, identical to the
committed pak10). The enemy MD2s stay byte-for-byte identical to the committed
pak10: their pauldrons keep the old fixed `steel` patch; only the 13 weapon MD2s
change.

**Muzzle collar.** The collar used to sample one shared
`findQuietPatch(skin, 150, 14)` patch (the same `steel` patch for every weapon),
so on `v_handgr` it could land on a bright hand/flat cell and read as light
blocks with a fringe. `regionForAnchor()` now decides per part:

- **face** - sample the anchor face's own UV triangle barycentrically, so the
  collar is painted with the barrel face it rides. Accepted when the region has
  4..640 texels and its max adjacent luma step is <= 72.
- **patch** - when the anchor face is too small or too loud, search quiet,
  colour-matched patches of three sizes (density-matched, larger, smaller),
  preferring edge <= 40 and |mean-faceMean| <= 20, then <= 64/36, then best
  effort; each patch is 3..16 texels square. Patch size follows the weapon's
  median face texel density, so the part is not magnified against its own model.

The same rule is applied to every added part on every weapon (260 parts, 167
bound directly to their face).

## Numbers (`node scripts/model-geometry.mjs --verify`)

Thresholds asserted by `--verify`: exactly 13 PCX + 13 MD2 entries; PCX exactly
2x; palette bytes identical; `bytesPerLine == width`; cut-out exactly 4x; MD2
skin dims equal the PCX; ST in range and normalised UV within half a 2x texel;
mesh counts at baseline; saturation strictly rises; hardware material mismatch
<= 24, edge <= 72, <= 640 texels, density >= 0.45x the weapon median.

| weapon | PCX pak0 -> pak10 | cut-out | mean sat | collar edge (old patch) | material mismatch (old) | min pitch | mesh |
|---|---|---|---|---|---|---|---|
| v_bfg | 216x195 -> 432x390 | 25 -> 100 | 0.350 -> 0.359 | 42.0 (81.6) | 14 (107) | 0.54x | 779/1384 |
| v_blast | 296x164 -> 592x328 | 1 -> 4 | 0.223 -> 0.235 | 32.0 (155.0) | 1 (132) | 0.87x | 628/1080 |
| v_chain | 264x164 -> 528x328 | 1 -> 4 | 0.213 -> 0.224 | 48.0 (7.9) | 20 (82) | 0.63x | 576/1000 |
| v_disint | 216x195 -> 432x390 | 24 -> 96 | 0.259 -> 0.283 | 56.4 (64.6) | 2 (135) | 0.54x | 779/1384 |
| v_flareg | 312x169 -> 624x338 | 32 -> 128 | 0.465 -> 0.470 | 38.1 (56.4) | 15 (117) | 0.52x | 797/1456 |
| v_handgr | 308x195 -> 616x390 | 5 -> 20 | 0.401 -> 0.414 | 52.0 (34.7) | 7 (69) | 0.51x | 902/1664 |
| v_hyperb | 296x194 -> 592x388 | 1 -> 4 | 0.292 -> 0.306 | 66.5 (53.1) | 20 (125) | 0.68x | 708/1264 |
| v_launch | 248x194 -> 496x388 | 1 -> 4 | 0.294 -> 0.307 | 58.6 (32.3) | 1 (137) | 0.49x | 864/1576 |
| v_machn | 300x194 -> 600x388 | 2 -> 8 | 0.354 -> 0.368 | 16.2 (203.0) | 18 (173) | 0.55x | 814/1452 |
| v_rail | 308x181 -> 616x362 | 1 -> 4 | 0.437 -> 0.447 | 68.3 (66.0) | 12 (45) | 0.53x | 790/1440 |
| v_rocket | 252x194 -> 504x388 | 1 -> 4 | 0.214 -> 0.224 | 36.4 (21.2) | 6 (74) | 0.64x | 810/1464 |
| v_shotg | 264x180 -> 528x360 | 27 -> 108 | 0.300 -> 0.311 | 31.0 (15.1) | 2 (63) | 0.71x | 596/1048 |
| v_shotg2 | 296x194 -> 592x388 | 1 -> 4 | 0.297 -> 0.307 | 60.5 (81.1) | 11 (176) | 0.53x | 868/1552 |

- Mean saturation over opaque pixels: **0.315 -> 0.327**, and every weapon rises.
- All 13 palettes are byte-identical; every cut-out is exactly 4x by area
  (the nearest mask, so the silhouette is the original at 2x).
- ST normalised UV drift is at most **0.50 of a 2x texel** (0.25 of an original
  texel) on every weapon; an integer ST table cannot hold the exact half-texel
  offset that would make `(st + 0.5) / size` invariant.
- Collar binding: worst material mismatch **20** (old fixed patch: 176), worst
  edge **68.3** (old patch: 203), min density **0.49x** the weapon median, no
  part over 640 texels. On the pistol, 18 of 20 parts bind directly to their
  own face with material mismatch 0 and edge 20-52; the other two use patches
  with mismatch <= 6.8. The old collar patch was up to 69 luma away from the
  pistol faces it covered - that is the light, fringed block the reference
  marked.
- Mesh counts equal the baseline for all 13 (table above); enemy MD2s in pak10
  hash-identical to the commit.

## pak10

`baseq2/pak10.pak`: 12,118,560 -> 13,770,565 bytes, **+1,652,005 bytes**
(11.56 -> 13.13 MiB). The delta is exactly the 13 added 2x PCX entries; all 7
monster MD2s are unchanged, and the 13 weapon MD2s changed only by the declared
skin size, doubled ST and the re-bound collar UVs.

## Check it

```
node scripts/model-geometry.mjs --verify         # all 13 pass, exit 0
node scripts/model-geometry.mjs --dry-run        # nothing written
node scripts/model-art.mjs --upscale-2x --only v_ --out /tmp/skins-2x
node scripts/tex-check.mjs --only models/        # 0 wrong size / unclaimed
node scripts/texture-pack.mjs --dry-run --only models/   # 125 packed, 0 failed
node scripts/model-art.mjs --engine-check --only v_      # 0 problems
node scripts/texture-pack-test.mjs               # 67 checks pass
```

## Assumptions

- Saturation is the mean of `(max-min)/max` over palette RGB for pixels whose
  index is not 255; it rises for every entry, including palettes with few
  colours (v_chain 0.213 -> 0.224).
- A 2x skin always doubles the ST table literally. The exact engine invariant
  would need half-integer ST; literal doubling keeps every sample within half a
  2x texel (a quarter of an original texel) and leaves the GL command list
  consistent.
- `texture-pack.mjs` was left untouched: the opt-in scale route lives in
  `model-art.mjs`, and the packer's exact-size gate is unchanged (67/67 tests).
- Enemy models were deliberately preserved. Their pauldron UVs still use the
  committed `steel` patch, which is why their MD2 bytes are identical.
- The reference picture's "artifact" is the collar's inherited patch. The
  numeric proof is the material/edge/density audit above; the 2x art itself was
  also checked visually against a nearest-neighbour enlargement (smoother, no
  shape or palette change).
