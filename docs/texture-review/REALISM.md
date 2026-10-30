# Realism pass — the material pass, what shipped, and what the game draws

This is the review of the material pass that supersedes the 270-texture faithful
set. The faithful round is still described in [REVIEW.md](REVIEW.md), marked as
the previous round; this file covers the 298-texture set now in
`baseq2/pak0.pak` and `baseq2/pak9.pak`.

Every number below comes from a committed JSON report
(`docs/texture-review/repack.json`, `docs/texture-review/hires-report.json`,
`docs/texture-review/ingame/shots.json`,
`docs/texture-review/ingame/real/fps.json`) or is arithmetic on one, and the
source is named at each claim. Every visual statement cites a committed
screenshot. Where a step was not run, it says so.

## 1. What changed

The previous round enlarged each demo WAL with a faithful 4x filter: the
picture said what the demo's picture said, only with four times the samples.
This round keeps that faithful enlargement as a base and draws a **material**
over it. `materialFor()` (`scripts/material-classes.mjs`) names each texture's
surface from its name and the WAL's own pixels; `applyMaterial()`
(`scripts/material-lib.mjs`) draws that surface; `scripts/hires-art.mjs` runs
the whole set and gates the result.

### Materials and counts

`docs/texture-review/repack.json` (`hiresArt.materials`) and
`hires-report.json` (`summary.materials`):

| Material | Count | Knobs from `recipe.materialParams` (detail / normals / shade / ao / grunge / grain / edge / glint / wear / glow) |
| --- | ---: | --- |
| rust | 77 | rust / 7.5 / 0.27 / 0.30 / 1.0 / 0.32 / 0.32 / 0 / 0.5 / 0 |
| metal | 71 | metal / 7 / 0.30 / 0.25 / 0.8 / 0.24 / 0.24 / 1.0 / 1.0 / 0 |
| tech | 68 | tech / 6 / 0.30 / 0.22 / 0.7 / 0.36 / 0.45 / 0 / 1.0 / 0 |
| sign | 22 | faithful upscale — no material knobs |
| stone | 21 | stone / 2 / 0.50 / 0.35 / 1.0 / 0.24 / 0.60 / 0 / 0 / 0 |
| crate | 16 | crate / 7 / 0.24 / 0.25 / 0.8 / 0.18 / 0.32 / 0 / 1.0 / 0 |
| lamp | 16 | smooth / 2 / 0.30 / 0.03 / 0.1 / 0.05 / 0.05 / 0 / 0 / 1.0 |
| organic | 2 | organic / 7 / 0.24 / 0.28 / 1.0 / 0.32 / 0.28 / 0 / 0 / 0 |
| water | 2 | faithful upscale — no material knobs |
| glass | 1 | smooth / 2.5 / 0.35 / 0.10 / 0.4 / 0.02 / 0.05 / 0 / 0 / 0 |
| sky | 1 | faithful upscale — no material knobs |
| flat | 1 | faithful upscale — no material knobs |
| wood | 0 | wood / 7 / 0.25 / 0.25 / 1.0 / 0.18 / 0.30 / 0 / 0.4 / 0 |
| **all** | **298** | 272 drawn by the material recipe, 26 faithful |

`wood` has a recipe but no wooden surface in the demo, so its count is 0.
`sign`, `water`, `sky` and `flat` keep the previous round's faithful picture
and its gates: they are 22 + 2 + 1 + 1 = 26 of the 298 entries. Everything else
(272 entries) is drawn through the material pass.

### The recipe in a few lines

From `hires-report.json.recipe`, and the header of `scripts/hires-art.mjs`:

- **Base:** sRGB → linear; wrapped separable Catmull-Rom 4x; each output pixel
  clamped to the source 2x2; thresholded unsharp on linear luminance; each 4x4
  block's mean restored to the source pixel it replaces (outermost ring left
  alone).
- **Material:** relief from the base's own shading, one fixed light from the
  upper left, wrapped cavity occlusion, grunge/streaks, grain and edge wear,
  lamp glow and glass reflection — deterministic (`seed: entry.name`), wrapped
  so the texture still tiles, and guarded so the mean brightness stays put.
- **Seam:** the material art's outermost ring is blended back toward the
  faithful base only where the wrap boundary would be seamier than the base's
  own.
- **Grain:** wrapped value noise, at most 3% of local luminance and 4/255
  absolute, scaled by source 3x3 variance; off for sign/arrow/text, light,
  water/warp, sky and flat/black.
- **Final clamp:** source 3x3 min/max ±4 (faithful art); the material art is
  exempt from that clamp because relief deliberately shades outside the source
  envelope, and is held by the realism gates below instead.

### The gates it holds

`hires-report.json.gates`, `.realismGates` and `.softwareGates`:

- Faithful entries: luminance Pearson ≥ 0.97, mean absolute RGB error ≤ 6, mean
  luminance within 2, seam ratio ≤ 1.15x the bilinear baseline + 0.05 (a
  boundary step ≤ 1 level in both pictures is invisible and passes), outliers
  ≤ 0.5% of pixels beyond the source 3x3 ±4, gradient ≥ 1.05x bilinear.
- Material entries: Pearson ≥ 0.9 and mean absolute RGB ≤ 10 (the pass is
  allowed to reinterpret shading), mean luminance within 2, seam against the
  faithful base, hue shift ≤ 3° over source chroma > 8, 99th-percentile chroma
  ≤ base x 1.10 + 3, bright-pixel share (channel ≥ 250) ≤ base + 0.5%, and
  detail energy ≥ 1.5x the base and ≥ 1.5 levels (lamp and glass, smooth by
  nature, need only 1.0x and 1.0 level).
- Every entry, faithful or material: the 1x picture the software renderer
  would draw (box-downsample, re-index onto the global palette) must stay
  within 2.5 mean luminance of the pristine WAL and keep ≥ 70% of its distinct
  palette indices.

`hires-report.json.summary` after the run: **298 entries, 298 passed, 0
failed**. `repack.json` records `alreadyIdentical: 298`: running
`scripts/hires-art.mjs` again wrote nothing, and the second
`node scripts/texture-pack.mjs` run wrote nothing either.

### Coverage: 270 → 298 textures

`baseq2/pak0.pak` holds 303 WALs. The previous round drew 270; this round draws
298. The 28 newly covered textures are the ones that had no art before:
`pipe1_1`, `grate2_6`, `metal1_1`, `metal1_4`, `grey1_3`, `grey_p1_3`,
`wtroof4_6`, `wgrate1_7`, `grass1_8`, `ggrat2_2`, `fmet1_2`, the
`+0…+4comp10_1` family (5), the `+0…+1cgrate2_1` family (2) and the
`+0…+9comp11_1` family (10). Animation families are drawn whole, so no
animation flips between 4x art and 1x art any more.

Five WAL entries still have no art, and they are the bookkeeping brushes the
engine never draws as surfaces: `textures/e1u1/clip.wal`,
`textures/e1u1/clip_mon.wal`, `textures/e1u1/hint.wal`,
`textures/e1u1/origin.wal` and `textures/e1u3/clip.wal`.
`hires-report.json.coverage.excluded` lists the four names (`clip`, `clip_mon`,
`hint`, `origin`; `clip` appears in both e1u1 and e1u3).
`node scripts/tex-check.mjs` reports 524 of 611 manifest entries with art; the
other 79 are those 5 WALs plus non-WAL pictures outside this pass's scope (env
cubemaps, menu/UI pics, a couple of sprite frames).

## 2. What shipped

From `docs/texture-review/repack.json` (before = the archives at
`b6c2a4f`, after = this round):

| Archive | Before | After | Change |
| --- | --- | --- | --- |
| `baseq2/pak0.pak` | 47,498,591 B, 1106 entries, 303 WALs | 47,498,591 B, 1106 entries, 303 WALs | size unchanged; the blob is different (git records it changed at the same size), because the packer re-indexes the 4x art down to the entry's 1x pixels — the material pass reaches the software/1x picture too |
| `baseq2/pak9.pak` | 25,031,035 B, 270 PNGs | 41,201,057 B, 298 PNGs | +16,170,022 B, +28 PNGs |

The 298 PNGs inside pak9 total 41,181,973 bytes of PNG
(`hiresArt.pngBytes`); the remaining 19,084 bytes of pak9 are the PAK header
and directory. Raw art bytes are 82,808,832 (`summary.artBytes`), so the PNGs
carry the same pictures in 2.01x fewer bytes. Both archives are deterministic:
`node scripts/texture-pack.mjs --check` leaves both alone, and a second
`node scripts/texture-pack.mjs` writes nothing (`repack.json.commands`).

Everything shipped came from `node scripts/hires-art.mjs` followed by
`node scripts/texture-pack.mjs`; no pak or `assets/textures/manifest.json` was
edited by hand.

## 3. In-game evidence

The headless captures (`scripts/texture-shots.mjs`, Chrome with
`--use-angle=swiftshader`, so no GPU) render three spawn views three ways:
PREV = the archives at `b6c2a4f`, NEW = this round's archives with
`r_retexturing 1`, OFF = this round's archives with `r_retexturing 0`. Each
pair is 1024x768 (786,432 pixels); `meanAbsDiff` is the mean absolute RGB
difference over those pixels. All numbers are from
`docs/texture-review/ingame/shots.json`.

| View | PREV | NEW | OFF | prev / new composite | prevVsNew meanAbsDiff (px) | newVsOff meanAbsDiff (px) | Laplacian PREV / NEW / OFF | NEW vs OFF signal-to-noise | Verdict |
| --- | --- | --- | --- | --- | ---: | ---: | --- | ---: | --- |
| demo1-spawn | `docs/texture-review/ingame/demo1-spawn-PREV.jpg` | `docs/texture-review/ingame/demo1-spawn-NEW.jpg` | `docs/texture-review/ingame/demo1-spawn-OFF.jpg` | `docs/texture-review/ingame/demo1-spawn-prev-new.png` | 1.5649 (5,372) | 1.1733 (4,469) | 63.76 / 88.89 / 71.34 | 53.37x | pak9 art drawn (NEW moves the view 53.4x the settled-frame noise, Laplacian +17.55) |
| demo2-spawn | `docs/texture-review/ingame/demo2-spawn-PREV.jpg` | `docs/texture-review/ingame/demo2-spawn-NEW.jpg` | `docs/texture-review/ingame/demo2-spawn-OFF.jpg` | `docs/texture-review/ingame/demo2-spawn-prev-new.png` | 1.8867 (17,050) | 1.7356 (20,643) | 151.99 / 192.43 / 169.37 | 26.17x | pak9 art drawn (NEW moves the view 26.2x the settled-frame noise, Laplacian +23.06) |
| demo3-spawn | `docs/texture-review/ingame/demo3-spawn-PREV.jpg` | `docs/texture-review/ingame/demo3-spawn-NEW.jpg` | `docs/texture-review/ingame/demo3-spawn-OFF.jpg` | `docs/texture-review/ingame/demo3-spawn-prev-new.png` | 0.9081 (506) | 0.7622 (282) | 27.55 / 35.43 / 32.95 | 22.35x | pak9 art drawn (NEW moves the view 22.4x the settled-frame noise, Laplacian +2.47) |

The same-view BEFORE | AFTER composites are
`docs/texture-review/ingame/demo1-before-after.png`,
`docs/texture-review/ingame/demo2-before-after.png` and
`docs/texture-review/ingame/demo3-before-after.png` (BEFORE is the pristine
demo pak0 with no pak9).

The diff reference in `shots.json` says it plainly: NEW vs OFF flips only
`r_retexturing` on the same two archives, so it is the pak9 art alone and
stands 53.37x / 26.17x / 22.35x above the same-view temporal noise (0.022 /
0.066 / 0.034; the report's verdict lines round these to 53.4x / 26.2x /
22.4x). PREV vs NEW is this team's change. `beforeVsOff` is reported
but is not a lower bound: it also includes the material pass's redraw of
pak0's 1x WALs.

Two views that were queued were dropped, not captured:
`demo1-base2` and `demo2-base3b` (`shots.json.summary.droppedViews`). This
round therefore has three headless views, not five.

## 4. Performance on the real GPU

From `docs/texture-review/ingame/real/fps.json`. The page was the live game
at `http://127.0.0.1:4231/` (PREV on a private copy at `http://127.0.0.1:43867/`),
in real Chrome, with the desktop GPU:

- Renderer: `ANGLE (Intel, Mesa Intel(R) UHD Graphics 620 (KBL GT2), OpenGL ES 3.2)`,
  WebGL 2.0 (`webgl2: true`), `glVersion "WebGL 2.0 (OpenGL ES 3.0 Chromium)"`.
- Measured drawing buffer: **1366x768** (the page's `drawingBuffer`; window
  `inner` was 1248x668, `dpr` 1, and the committed PNGs are 1248x668 — the
  page's own size, not the drawing buffer).
- Method, copied from the report: GLctx.clear calls (one per rendered frame)
  plus the engine's `MainLoop_runner` requestAnimationFrame callback, in the
  live page; 5 s warm-up then 3 x 10 s standing still at spawn, median; HTTP
  cache disabled.
- The served pak9 is the shipped one: `environment.servedPak9` is 41,201,057
  bytes both on disk and in the engine (`matches: true`), and every NEW/OFF
  run reports `pak9InEngine 41201057`. PREV reports 25,031,035.

| Variant | Map | pak9 in engine | Median FPS (3 x 10 s) | Drawing buffer | Screenshot |
| --- | --- | ---: | ---: | --- | --- |
| NEW | demo1 | 41,201,057 | **74.97** | 1366x768 | `docs/texture-review/ingame/real/demo1-NEW.png` |
| NEW | demo2 | 41,201,057 | **74.92** | 1366x768 | `docs/texture-review/ingame/real/demo2-NEW.png` |
| OFF | demo1 | 41,201,057 | **74.92** | 1366x768 | `docs/texture-review/ingame/real/demo1-OFF.png` |
| OFF | demo2 | 41,201,057 | **74.97** | 1366x768 | `docs/texture-review/ingame/real/demo2-OFF.png` |
| PREV | demo1 | 25,031,035 | **74.96** | 1366x768 | `docs/texture-review/ingame/real/demo1-PREV.png` |
| PREV | demo2 | 25,031,035 | **74.98** | 1366x768 | `docs/texture-review/ingame/real/demo2-PREV.png` |

Ratios:

- demo1 NEW/OFF = **1.001** (`fps.json.comparison.ratio`); demo2 NEW/OFF =
  0.999 (74.92 / 74.97, computed from the medians above).
- demo1 NEW/PREV = 1.000 (74.97 / 74.96); demo2 NEW/PREV = 0.999 (74.92 /
  74.98).
- The previous set's recorded reference is 34 fps vs 73 fps, ratio **0.47**
  (`fps.json.reference`). The reference did **not** reproduce today: the
  previous set itself measured 74.96 fps at demo1 in this session. Every
  variant is pinned at the display cap — the report's measured refresh figures
  are 75.8 Hz (NEW), 74.3 Hz (OFF) and 75.6 Hz (PREV), and every median is
  within 1 fps of those figures.

So the honest reading is narrower than "1.001 vs 0.47": at 1366x768 on this
GPU, with the frame cap in place, the new set costs **no measurable frame
rate**, but the test also has no headroom to show what it would cost. The new
pak9 is 16,170,022 bytes larger and holds 28 more 4x textures; nothing here
says it is free at uncapped rates or at a larger buffer.

**Tuning:** none. `fps.json.tuning` says `triggered: false`, reason "NEW 74.97
fps vs OFF 74.92 fps (ratio 1.001) is not under 29 fps or 0.40; no tuning
applied". `fps.json.recommendations` says keep the shipped pak9. If a real
cost figure is wanted, the measurement to make is an uncapped one (or a larger
drawing buffer); this run did not make it.

**What the real frames show** (read from the committed PNGs above; all three
demo1 frames are the same spawn view, so the art is the difference):

- `docs/texture-review/ingame/real/demo1-NEW.png`: riveted, rusted wall
  panels; a polished square-tiled floor reflecting the room; a glowing orange
  vertical beam behind a broken window; a small console/crate on the floor.
- `docs/texture-review/ingame/real/demo1-OFF.png`: the same spawn view with
  the 1x surfaces, same geometry and brown/amber palette.
- `docs/texture-review/ingame/real/demo1-PREV.png`: the same spawn view with
  the previous round's art.
- `docs/texture-review/ingame/real/demo2-NEW.png`: the demo2 spawn, seen
  through a heavy riveted doorway; stencilled crates and containers, blood on
  the floor, a live enemy and a corpse, HUD at health 16 / armor 0.

`fps.json` warns that the demo2 frames are not pixel-identical across variants
(`settleDiff` 23.619 for NEW and 33.643 for OFF: a live enemy and a damage
flash). Demo2 is therefore an FPS measurement only, not a diff pair. The
demo1 frames settled at 0.467 / 0.376 / 0.184. No real-Chrome capture of
demo3 was made; demo3 exists only in the headless set above.

## 5. Conventions considered

The build is Qwasm2 (a Yamagi Quake II port) on gles3/WebGL2. Claims about what
the engine can do were checked against this build's own binaries — `strings
engine/ref_gles3.wasm` and `engine/index.wasm` — not taken from documentation.
The Yamagi project page (`https://github.com/yquake2/yquake2`) was opened for
this note; the specific `doc/010_cvars.md` path returned 404, so no
documentation claim is made from it.

| Convention | What it would add | What this build can do | Decision |
| --- | --- | --- | --- |
| Quake II RTX-style material layering (albedo / roughness / metallic / emissive as separate maps) | physically based response per material | one texture per surface, looked up through `r_retexturing`; no roughness/metallic/emissive map name or loader appears in `ref_gles3.wasm`'s strings, and there is no WebGPU or engine rebuild | **Partially adopted — baked into the one albedo.** Relief shading, glint, wear, edge damage, lamp glow and glass reflection are drawn into the 4x albedo; no separate channels ship. |
| Yamagi `r_retexturing` | swap a WAL for a named PNG/PCX in the same archive | `r_retexturing` is in `ref_gles3.wasm`; pak9 holds `textures/...png` beside pak0's WALs, and the shots flip exactly that cvar | **Adopted.** This is the whole shipping mechanism; NEW vs OFF is the measurement of it. |
| Yamagi detail textures (a second texture blended at close range) | extra close-range detail without a full 4x set | no detail-texture cvar or identifier appears in `ref_gles3.wasm`'s strings | **Not possible without an engine rebuild.** The detail is baked into the albedo instead and held by the detail-energy gate. |
| Mipmaps + anisotropic filtering | clean minification and oblique surfaces | `glGenerateMipmap` and `GL_EXT_texture_filter_anisotropic` / `r_anisotropic` are in `ref_gles3.wasm`; every shots/fps run had `gl_texturemode GL_LINEAR_MIPMAP_LINEAR` (`shots.json.engineState`) | **Mipmaps adopted and in use; anisotropy available but not measured or changed here.** |
| PAK texture compression | smaller archives | the PAK format is an offset/size directory with no compression field (`scripts/texture-lib.mjs`); the engine does not decompress entries | **Not possible in the PAK.** The only compression used is the PNG's own zlib: 82,808,832 B of raw art → 41,181,973 B of PNG (2.01x). |
| Lightmap-aware brightness | shading that respects each surface's baked light | the generator never opens a BSP lightmap, and per-lightmap baking would need an engine change | **Partially adopted — as an invariant.** Mean luminance stays within 2 of the demo's (gate 2) and within 2.5 after the 1x palette re-index, so the lightmap multiplies the same average radiance as before. |

## 6. Weakest remaining materials

Computed once from `docs/texture-review/hires-report.json` with a one-off
`node --input-type=module -e` snippet (no new script, no contact sheets, no
visual sweep). These are **margins, not failures**: all 298 entries pass. The
list is grouped by the gate that is tightest — the detail floor first, then
hue/colour, chroma, luminance, and structural correlation last — and each line
gives the number and why it is the weak point.

1. **`textures/e1u1/wsupprt1_14.wal` (lamp).** The pass adds the least detail
   of any material entry — `detailEnergy` 4.5342 against base 4.4894,
   **1.010x** on the smooth floor of 1.0x — while moving more absolute colour
   than anything else:
   `meanAbsRgb` **6.4409** of the material gate's 10 (it would fail the
   faithful set's 6), luminance bias 0.8964 of 2. A flat light has little
   relief to find; the pass is mostly its lighting.
2. **`textures/e1u1/grnx2_5.wal` (metal).** Lowest detail gain on a textured
   surface: `detailEnergy` 3.4553 vs base 2.2731 = **1.520x**, only 1.3% above
   the 1.5x floor.
3. **`textures/e1u1/grnx3_3.wal` (metal).** `detailEnergy` 1.545x, and a seam
   ratio of 0.31 against the base's 0.2285 — the highest seam-to-base ratio
   among the grnx textures (the per-axis gate still passes).
4. **`textures/e1u2/metal11_3.wal` (rust).** Largest hue shift in the set:
   **2.5433° of the 3° limit**, with `meanAbsRgb` 4.9107 and a bright-pixel
   share of 0.006 against 0.007 allowed (86%).
5. **`textures/e1u1/florr1_2.wal` (stone).** `meanAbsRgb` **5.0122**, the
   second-largest colour move (half the material allowance), with
   `detailEnergy` 3.254x — a floor that gained a lot of lighting.
6. **`textures/e1u1/+0btshoot2.wal` (tech).** `meanAbsRgb` 4.9447 and hue
   shift 1.9925°, plus `brightShare` 0.013 against 0.0187 allowed — a
   shooter-panel face that already had bright pixels, so the headroom is small.
7. **`textures/e1u1/color1_2.wal` (rust).** 99th-percentile chroma 88 over a
   base of 82: **94.4%** of the allowance (82 x 1.10 + 3 = 93.2) — the closest
   chroma margin outside the comp10 family.
8. **`+0…+4comp10_1` (tech, 5 entries).** Chroma 97–98 over a base of 91,
   i.e. **94.1–95.1%** of the 103.1 allowance — the tightest chroma family in
   the set.
9. **`textures/e1u1/wgrate1_8.wal` (rust).** Largest luminance bias among
   material entries, **0.9465 of the 2 allowed** (`trigger`, a faithful sign,
   is higher at 1.5682 and is the faithful round's documented case), with
   `detailEnergy` 1.589x — the pass brightened this grate the most while
   gaining little texture.
10. **`textures/e1u1/pip01_1.wal` (rust).** Lowest Pearson correlation to its
    own base, **0.9008 against the material floor of 0.9**
    (`grnx2_9` is next at 0.9056), with `detailEnergy` 4.865x: the most
    structurally reinterpreted picture in the set. The 0.9 floor is
    deliberately looser than the faithful set's 0.97, so this is the closest
    margin in relative terms, not necessarily the most visible defect.

Still with **no art at all**: `textures/e1u1/clip.wal`,
`textures/e1u1/clip_mon.wal`, `textures/e1u1/hint.wal`,
`textures/e1u1/origin.wal` and `textures/e1u3/clip.wal`. These are the
collision, hint and origin brushes; they are never drawn as surfaces, so
giving them art would add bytes and no picture.

## What this evidence does not cover

- No real-Chrome view of demo3; only demo1 and demo2 were captured on the GPU,
  and demo2's frames are not pixel-identical across variants (live enemy,
  damage flash), so its screenshot is not a diff pair.
- The FPS test is pinned at the 75.8 Hz display cap, so it can prove "no
  measurable cost here", not "no cost".
- No contact sheets and no vision sweep of the 298 new textures; the visual
  claims are limited to the four real-Chrome frames cited in §4.
