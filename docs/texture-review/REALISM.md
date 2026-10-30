# Realism pass — the material pass, its weakest-ten tuning, and what the game draws

This is the review of the material pass that supersedes the 270-texture faithful
set, and of the tuning pass that followed it. The current archives are the
298-texture set in `baseq2/pak0.pak` and `baseq2/pak9.pak`; the material pass
itself is described in [REVIEW.md](REVIEW.md) as the previous round.

Every number below comes from a committed JSON report
(`docs/texture-review/repack.json`, `docs/texture-review/hires-report.json`,
`docs/texture-review/tuning.json`, `docs/texture-review/ingame/shots.json`,
`docs/texture-review/ingame/real/fps.json`) or is arithmetic on one, and the
source is named at each claim. §6's ordering is one arithmetic pass over
`hires-report.json`, run once with a one-off `node -e` snippet and no committed
script. Every visual statement cites a committed screenshot. Where a step was
not run, it says so.

## What to look at

The thing the owner opens is the ClawBox app:
**http://127.0.0.1:3005/apps/quake2/**, which answers HTTP 200 with the game page
(`id="canvas"`). In this box's game-profile Chrome it currently redirects to
`:3005/login` (no valid ClawBox session there), so the real-Chrome picture
checks below are made on the same build at **http://127.0.0.1:4231/**, which
serves the identical archives and draws gles3 on WebGL2 through ANGLE at a
1366x768 buffer. §7 has both results.

**The new art, one URL per map** (each loads with `r_retexturing 1` and no view
weapon, so the surfaces are what you see):

- <http://127.0.0.1:4231/?+map&demo1&+set&cl_gun&0&+set&crosshair&0>
- <http://127.0.0.1:4231/?+map&demo2&+set&cl_gun&0&+set&crosshair&0>
- <http://127.0.0.1:4231/?+map&demo3&+set&cl_gun&0&+set&crosshair&0>

or from the game's console: `map demo1`, `map demo2`, `map demo3` (the console
route is verified in `docs/texture-review/ingame/final/e2e.json`:
`consoleMap.readback` reads `demo2` after typing `map demo2`).

**The OFF comparison** is the same URL with `&+set&r_retexturing&0` appended:

- <http://127.0.0.1:4231/?+map&demo1&+set&r_retexturing&0>

This URL form is the one the committed OFF shots use (§3, §4). The console
toggle was also tried: typing `r_retexturing 0` reads back `0` and the frame
changes (`e2e.json`, `consoleOff`), so it takes, but the pictures cited here are
the URL-form ones.

**Views worth seeing.** The audit (`docs/texture-review/AUDIT.md`, data in
`ingame/audit/audit.json`) planned a legal eye for each of the twenty most-drawn
textures. Load the map, put the eye on the spot with the engine's single-player
`teleport x y z` (URL form: append `&+set&cheats&1` before `+map`, e.g.
`http://127.0.0.1:4231/?+set&cheats&1&+map&demo2`; typing `cheats 1` on the
console does not take), and turn with the arrow keys -- this build ignores
pitch look on keyboard and bridge mouse, so the floor and ceiling spots are
framed level (AUDIT.md, "Pitch").

| what you see | map | teleport command | view |
| --- | --- | --- | --- |
| slatted wall, the most-drawn texture | demo2 | `teleport 480 -1648 166` | wall |
| metal ceiling panel | demo2 | `teleport 681 -1783 -120` | ceiling |
| grated wall | demo2 | `teleport 588 -1760 124` | wall |
| riveted metal wall | demo1 | `teleport 160 -608 -20` | wall |
| rock face with light break | demo1 | `teleport 674 -379 195` | wall, pitch -10 |
| corridor floor | demo1 | `teleport -1957 1779 120` | floor |
| green-slat floor | demo1 | `teleport -1495 1529 -8` | floor |
| grate floor | demo3 | `teleport 319 -142 -497` | wall, pitch -14 |
| sky brush | demo1 | `teleport -58 1245 679` | ceiling |

Each row's NEW/OFF pair is in `ingame/audit/` and its verdict in AUDIT.md; all
twenty were judged `ok`, and six artefacts suspected in NEW were found in OFF
too (no `MATERIAL_TUNING` row changed).

### What still has no art

`node scripts/tex-check.mjs --json` prints `entries: 611`, `artTargets: 603`,
`withArt: 524`, `missing: 79`. The 8-entry gap between `entries` and
`artTargets` is `drawnFromFrames`: `sprites/s_explod.sp2` and its seven
siblings are sprite *scripts* that name their frames and have no pixels of their
own, so they are counted as entries but are not art targets. The 79 are, by
what they are (`missingNames`, 79 names):

- **5 never-drawn WALs** -- `textures/e1u1/clip.wal`, `textures/e1u1/clip_mon.wal`,
  `textures/e1u1/hint.wal`, `textures/e1u1/origin.wal`, `textures/e1u3/clip.wal`.
  Collision, hint and origin brushes: the engine never draws them as surfaces,
  and `hires-report.json.coverage.excluded` lists them as excluded.
- **6 env cubemaps** -- `env/unit1_{rt,ft,lf,bk,up,dn}.pcx`, the six faces of
  the reflection cube map. They are sampled as a reflection, not drawn as a
  surface; this pass has no cubemap recipe.
- **66 menu/UI pics** -- `pics/*.pcx`: HUD and inventory icons (`pics/i_*`,
  `pics/a_*`, `pics/p_*`, `pics/k_*`), weapon icons (`pics/w_*`), menu cursors
  (`pics/m_cursor*.pcx`), `pics/help`, `pics/net`, `pics/turtle`, `pics/ch1-3`,
  `pics/field_3`, `pics/i_help.pcx`, and `pics/colormap.pcx` (the palette source,
  not a picture).
  This pass covers world surfaces only; the UI is out of scope.
- **2 sprite frames** -- `sprites/s_bubble_0.pcx` and `sprites/s_bubble_1.pcx`,
  frames of `sprites/s_bubble.sp2`. Sprite frames are drawn by the engine's
  sprite path, not by the world texture path this pass redraws; they are the
  only sprite frames left unsupplied.

## 1. What changed

The previous round enlarged each demo WAL with a faithful 4x filter: the
picture said what the demo's picture said, only with four times the samples.
That round then drew a **material** over it. `materialFor()`
(`scripts/material-classes.mjs`) names each texture's surface from its name and
the WAL's own pixels; `applyMaterial()` (`scripts/material-lib.mjs`) draws that
surface; `scripts/hires-art.mjs` runs the whole set and gates the result.

This round changes no recipe. It sets **per-entry** knobs for the ten weakest
materials of §6 — 14 textures in all — in `MATERIAL_TUNING`
(`scripts/hires-art.mjs`), merged over `MATERIAL_PARAMS[material]` by
`applyMaterial({params})` (`tuning.json.how`). No global knob and no gate was
changed, and every other entry draws byte for byte what it drew before.
`tuning.json.summary` records `improved: 14, unchanged: [], passed: 14,
failed: 0`. §6 gives the gate table, the knobs and the new margins.

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

The tuning changes no entry's material; the counts are the material pass's.
The table's knobs are the unchanged global defaults in
`recipe.materialParams`; the per-entry overrides are listed in §6. `wood` has a
recipe but no wooden surface in the demo, so its count is 0. `sign`, `water`,
`sky` and `flat` keep the previous round's faithful picture and its gates: they
are 22 + 2 + 1 + 1 = 26 of the 298 entries. Everything else (272 entries,
including the 14 tuned ones) is drawn through the material pass.

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

The tuning changed none of these gates; it moved the 14 entries toward the
middle of them. `hires-report.json.summary` after the tuned full run:
**298 entries, 298 passed, 0 failed**. `repack.json` records
`alreadyIdentical: 298`: running `scripts/hires-art.mjs` again wrote nothing,
and the second `node scripts/texture-pack.mjs` run wrote nothing either.

### Coverage: 270 → 298 textures

`baseq2/pak0.pak` holds 303 WALs. The faithful round drew 270; the material
round drew 298. The 28 newly covered textures are the ones that had no art
before: `pipe1_1`, `grate2_6`, `metal1_1`, `metal1_4`, `grey1_3`, `grey_p1_3`,
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
`node scripts/tex-check.mjs --json` prints `entries: 611`, `artTargets: 603`,
`withArt: 524`, `missing: 79`: 524 of the 603 art targets carry art and the
other 79 are the 5 WALs above plus non-WAL pictures outside this pass's scope
(6 env cubemaps, 66 menu/UI pics, 2 sprite frames — listed by kind and name in
"What to look at" above). The 8 entries that are not art targets are the
`drawnFromFrames` SP2 sprite scripts, which name their frames and hold no
pixels of their own.

## 2. What shipped

From `docs/texture-review/repack.json`. **Before is `7e21a48`**, the archives
the material round shipped; after is this round:

| Archive | Before (7e21a48) | After (this round) | Change |
| --- | --- | --- | --- |
| `baseq2/pak0.pak` | 47,498,591 B, 1106 entries, 303 WALs | 47,498,591 B, 1106 entries, 303 WALs | size unchanged; the blob is different (`git diff --stat 7e21a48` reports a binary change at that size), because the packer re-indexes the tuned 4x art down to each entry's 1x WAL — the tuning reaches the software/1x picture too |
| `baseq2/pak9.pak` | 41,201,057 B, 298 PNGs | 41,216,186 B, 298 PNGs | **+15,129 B**, same 298 entries |

The 298 PNGs inside pak9 total **41,197,102 bytes** of PNG
(`repack.json.hiresArt.pngBytes`, `hires-report.json.summary.pngBytes`); the
remaining 19,084 bytes of pak9 are the PAK header and directory (41,216,186 −
41,197,102). Raw art bytes are **82,808,832** (`summary.artBytes`, 27,602,944
pixels at 4x in `summary.artPixels`), so the PNGs carry the same pictures in
2.01x fewer bytes (82,808,832 / 41,197,102 = 2.010). Both archives are
deterministic: `node scripts/texture-pack.mjs --check` leaves both alone, and a
second `node scripts/texture-pack.mjs` writes nothing (`repack.json.commands`).

Everything shipped came from `node scripts/hires-art.mjs` followed by
`node scripts/texture-pack.mjs`; no pak or `assets/textures/manifest.json` was
edited by hand.

The audit round that followed (`AUDIT.md`, step 1 of this goal) changed no art
file and neither archive -- every suspected defect turned out to be in the OFF
picture too. On disk now: `baseq2/pak0.pak` **47,498,591 B**
(sha1 `3fce7386fe188b9176984bec676e950123aa6280`) and `baseq2/pak9.pak`
**41,216,186 B** (sha1 `e2f2a6efb1a3d06f4711897bc6ef1daf0e228f3d`), the sizes
this round shipped.

## 3. In-game evidence

The headless captures (`scripts/texture-shots.mjs`, Chrome with
`--use-angle=swiftshader`, so no GPU) render three spawn views three ways:
PREV = the archives at **`7e21a48`**, NEW = this round's archives with
`r_retexturing 1`, OFF = this round's archives with `r_retexturing 0`. Each
pair is 1024x768 (786,432 pixels); `meanAbsDiff` is the mean absolute RGB
difference over those pixels, in 0–255 levels. All numbers are from
`docs/texture-review/ingame/shots.json` (`prevRevision: 7e21a48`).

| View | Images | PREV vs NEW meanAbsDiff (pixels) | NEW vs OFF meanAbsDiff (pixels) | Laplacian PREV / NEW / OFF | NEW vs OFF signal-to-noise | Verdict (`shots.json`) |
| --- | --- | ---: | ---: | --- | ---: | --- |
| demo1-spawn | [PREV](ingame/demo1-spawn-PREV.jpg) / [NEW](ingame/demo1-spawn-NEW.jpg) / [OFF](ingame/demo1-spawn-OFF.jpg) / [PREV vs NEW](ingame/demo1-spawn-prev-new.png) | 0.0232 (387) | 1.1732 (4,469) | 88.89 / 90.93 / 69.31 | 12.64x | pak9 art drawn (NEW moves the view 12.6x the settled-frame noise, Laplacian +21.62) |
| demo2-spawn | [PREV](ingame/demo2-spawn-PREV.jpg) / [NEW](ingame/demo2-spawn-NEW.jpg) / [OFF](ingame/demo2-spawn-OFF.jpg) / [PREV vs NEW](ingame/demo2-spawn-prev-new.png) | 0.0509 (1,372) | 1.7248 (20,017) | 193.97 / 193.07 / 167.78 | 22.75x | pak9 art drawn (NEW moves the view 22.8x the settled-frame noise, Laplacian +25.29) |
| demo3-spawn | [PREV](ingame/demo3-spawn-PREV.jpg) / [NEW](ingame/demo3-spawn-NEW.jpg) / [OFF](ingame/demo3-spawn-OFF.jpg) / [PREV vs NEW](ingame/demo3-spawn-prev-new.png) | 0 (0) | 0.7625 (282) | 33.13 / 33.13 / 30.66 | 762.51x | pak9 art drawn (NEW moves the view 762.5x the settled-frame noise, Laplacian +2.47) |

The same-view BEFORE | AFTER composites are
[demo1](ingame/demo1-before-after.png),
[demo2](ingame/demo2-before-after.png) and
[demo3](ingame/demo3-before-after.png) (BEFORE is the pristine demo pak0 with
no pak9; `shots.json.pak.pristine` is 49,951,322 bytes).

The diff reference in `shots.json` says it plainly: NEW vs OFF flips only
`r_retexturing` on the same two archives, so it is the pak9 art alone and
stands 12.64x / 22.75x / 762.51x above the same-view temporal noise (0.0928 /
0.0758 / 0.001; the divisor is the larger shot's settle noise, floored at 0.001,
and demo3's two settled frames are identical, hence 0.001). PREV vs NEW is this
round's tuning alone: **0.0232 (387 pixels) / 0.0509 (1,372) / 0**, at or below
the same-view noise in all three views. The tuned textures carry few pixels at
these spawn points, so the headless views do not show the tuning; the gate
table in §6 is where it is measured. `beforeVsOff` is reported
(1.2373 / 1.4376 / 0.5898) but is not a lower bound: it also includes the
material pass's redraw of pak0's 1x WALs. The BEFORE shots' Laplacians are
57.16 / 134.31 / 27.10.

Two views that were queued were dropped, not captured: `demo1-base2` and
`demo2-base3b` (`shots.json.summary.droppedViews`). This round therefore has
three headless views, not five.

## 4. Performance on the real GPU

From `docs/texture-review/ingame/real/fps.json`. The page was the live game at
`http://127.0.0.1:4231/` (PREV on a private copy at `http://127.0.0.1:40327/`),
in real Chrome, with the desktop GPU.

- Renderer:
  `ANGLE (Intel, Mesa Intel(R) UHD Graphics 620 (KBL GT2), OpenGL ES 3.2)`,
  WebGL 2.0 (`webgl2: true`), `glVersion "WebGL 2.0 (OpenGL ES 3.0 Chromium)"`.
  Every variant ran `vid_renderer gles3` (`variants.NEW.cvars`), and every
  per-map check repeats `webgl2: true`, that renderer and `gles3`.
- Measured drawing buffer: **1366x768** (`environment.measuredDrawingBuffer`,
  `renderer.drawingBuffer`); window `inner` was 1248x668, `dpr` 1, and the
  committed PNGs are 1248x668 — the page's own size, not the drawing buffer.
- The served pak9 is the shipped one:
  `environment.servedPak9.contentLength` is 41,216,186, its `sha1Served`
  equals `sha1Local` (`matches: true`), and every NEW/OFF run reports
  `pak9InEngine 41216186`. PREV reports 41,201,057.
- **Load record:** the run did not have an idle box. Before Chrome work the
  1-minute load average was 5.56 on 8 cores (`cpuBusy` 0.34); it peaked at
  8.39 during the run, 16 of the 54 recorded windows were over the busy
  threshold, and the report's own warning is: *"the machine was busy before
  Chrome work started: load average 5.56 (1 min) on 8 cores, above half the
  core count; frame timings from this run are not representative of an idle
  box."* The numbers below are quoted from the report as measured, with that
  qualification.

Method, copied from the report: hard renderer checks; one settled screenshot
per view (`timescale 0`); capped fps from `GLctx.clear` (one per rendered
frame) plus the engine's `MainLoop_runner` requestAnimationFrame callback;
work per frame from the runner timed with `performance.now` and `gl.finish`;
uncapped fps from `GLctx.clear` with `vid_maxfps 0` (the engine clamps to 999)
and `MainLoop_runner` routed through a `MessageChannel`; GPU milliseconds from
`EXT_disjoint_timer_query_webgl2` when available; 5 s warm-up, then 3 × 10 s
at the cap and 2 × 5 s uncapped; HTTP cache disabled.

Capped frame rate, medians of three 10 s samples per map:

| Variant | pak9 in engine | demo1 | demo2 | demo3 | Median (`comparison`) | Measured display rAF |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| NEW | 41,216,186 | 74.96 | 74.96 | 74.99 | **74.96** | 76.1 Hz |
| OFF | 41,216,186 | 74.97 | 74.99 | 74.98 | **74.98** | 75.6 Hz |
| PREV | 41,201,057 | 74.96 | 74.94 | 74.98 | 74.96 (arithmetic) | 75.8 Hz |

Every capped median is 74.94–74.99 fps while the measured display rAF is
75.6–76.1 Hz, so capped fps cannot separate the variants.

### The one performance answer

**Headroom: 12.04 ms/frame, and NEW costs −0.3 ms/frame against OFF (−21.4%).**
`comparison` computes the budget as 1000 / 76.1 Hz = **13.141 ms/frame**, the
median work per frame across the three maps as **1.1 ms** for NEW and
**1.4 ms** for OFF (from the runner with `gl.finish`), and
`headroomMs = 12.04`. The cap does hide this if only fps is read: the uncapped
loop raised the median frame rate to **298.44 fps for NEW and 298.38 fps for
OFF**, against 74.96 / 74.98 capped, which is why the report's verdict is
`kind: "headroom"` and not a capped-fps statement. Per map the work medians are
NEW 1.1 / 1.6 / 1.0 ms and OFF 1.4 / 1.5 / 1.1 ms (demo1 / demo2 / demo3);
the uncapped medians are NEW 298.44 / 233.3 / 389.18 fps and OFF 298.38 /
250.04 / 349.25 fps. The two variants move in both directions across maps, so
the −0.3 ms headline is within this run's load noise; what the evidence
supports is "no added work measurable at 1366x768 on this GPU, with about
12 ms/frame spare under the cap", not a cost model for another buffer or GPU.
`fps.json.tuning` says `triggered: false` (no cvar tuning applied), and its
recommendation is to use the work-per-frame numbers, not capped fps.

The earlier frame-rate reference is withdrawn (`fps.json.reference.withdrawn:
true`): it was measured while the machine was busy with a coding team, it did
not reproduce, and it is not used here.

### The real-Chrome demo3 NEW/OFF pair

Files: [demo3-NEW.png](ingame/real/demo3-NEW.png),
[demo3-OFF.png](ingame/real/demo3-OFF.png),
[demo3-PREV.png](ingame/real/demo3-PREV.png), labelled
[demo3-NEW-vs-OFF.png](ingame/real/demo3-NEW-vs-OFF.png) and
[demo3-PREV-vs-NEW.png](ingame/real/demo3-PREV-vs-NEW.png). From
`fps.json.pairs.demo3`, on 833,664-pixel lossless PNGs:

- **NEW vs OFF:** `meanAbsDiff` **1.009**, 1,417 changed pixels
  (`changedShare` 0.0017), noise floor **0.043**, ratio **23.46** — the pak9
  art stands clear of the settle noise by a wide margin.
- **PREV vs NEW:** `meanAbsDiff` **0.042**, 1,096 changed pixels (0.0013),
  ratio **0.97** — at the noise floor. This round's tuning is not
  distinguishable from the settle noise in the demo3 view, matching the
  headless result in §3.
- The same pattern holds on demo1: NEW vs OFF 1.471 (ratio 49.02), PREV vs NEW
  0.028 (0.96). demo2 is also a settled diff pair: NEW vs OFF 2.156 (26,291
  pixels, noise 0.072, ratio 29.95).

**What the demo3 frames show**, read from the committed images above: both are
the same dark octagonal tunnel of riveted rusted wall panels, with a lit
stone-block corridor seen through the central octagon. In
[demo3-NEW.png](ingame/real/demo3-NEW.png) the panel seams, rivets and the
stone block joints are crisp and finely graded; in
[demo3-OFF.png](ingame/real/demo3-OFF.png) the same surfaces are blocky and
soft (the 1x art), while the geometry is identical. One qualification from
looking at the pair: the OFF frame shows a soldier standing on the lit ledge
and the HUD at health 95, while the NEW frame shows no soldier and health 100,
so the two real frames are not the same game state; the 1,417 changed pixels
include that soldier and the HUD digits, not only textures. The surface change
still dominates the mean diff (1.009 levels), and the headless demo3 pair in
§3 — same state, 0.7625 levels over 282 pixels — is the cleaner texture-only
comparison.

**What the other real frames show:** [demo1-NEW.png](ingame/real/demo1-NEW.png)
is large riveted and embossed brown wall panels, a polished reflective tiled
floor, a diagonal structural beam, and a lit emblem window with an orange
vertical glow; [demo1-OFF.png](ingame/real/demo1-OFF.png) has the same
geometry with the panel relief blurred away and the floor softer;
[demo1-PREV.png](ingame/real/demo1-PREV.png) is visually the same as NEW
(`fps.json.pairs.demo1.PREVvsNEW.meanAbsDiff` 0.028, below the 0.03 settle
noise). [demo2-NEW.png](ingame/real/demo2-NEW.png) is the demo2 spawn seen
through a heavy riveted doorway: stencilled crates and containers, a live
enemy, a corpse on the floor, HUD at health 100.

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
| Mipmaps + anisotropic filtering | clean minification and oblique surfaces | `glGenerateMipmap` and `GL_EXT_texture_filter_anisotropic` / `r_anisotropic` are in `ref_gles3.wasm`; every headless shots run had `gl_texturemode GL_LINEAR_MIPMAP_LINEAR` (`shots.json.engineState`), and the real-Chrome runs report `vid_renderer gles3` | **Mipmaps adopted and in use; anisotropy available but not measured or changed here.** |
| PAK texture compression | smaller archives | the PAK format is an offset/size directory with no compression field (`scripts/texture-lib.mjs`); the engine does not decompress entries | **Not possible in the PAK.** The only compression used is the PNG's own zlib: 82,808,832 B of raw art → 41,197,102 B of PNG (2.01x). |
| Lightmap-aware brightness | shading that respects each surface's baked light | the generator never opens a BSP lightmap, and per-lightmap baking would need an engine change | **Partially adopted — as an invariant.** Mean luminance stays within 2 of the demo's (gate 2) and within 2.5 after the 1x palette re-index, so the lightmap multiplies the same average radiance as before. |

## 6. Weakest remaining materials

This round tuned the ten weakest materials from the material pass's report —
14 textures, because `+0…+4comp10_1` is an animation family drawn with one
recipe. All numbers in the table come from `docs/texture-review/tuning.json`
(each entry's `metrics`, before and after) and the after values agree with the
tuned `hires-report.json`. The measure of a "remaining margin" is the gate's
own units: for a floor gate, how far the value sits above the floor; for a
ceiling gate, how far below the limit. Gates were never loosened.

| Entry | Material | Gate tuned (limit) | Before → after | Remaining margin | Knobs set | Also improved |
| --- | --- | --- | --- | --- | --- | --- |
| `textures/e1u1/wsupprt1_14.wal` | lamp | detailEnergy ≥ 1.0x base (lamp's smooth floor; 1.5x elsewhere) | **1.010x → 1.214x** | +21.4% over the floor | `glow 0.55`, `grain 0.15` | meanAbsRgb 6.4409 → 3.8265 (limit 10) |
| `textures/e1u1/grnx2_5.wal` | metal | detailEnergy ≥ 1.5x base | **1.520x → 1.645x** | +9.7% over the floor | `grain 0.32` | — |
| `textures/e1u1/grnx3_3.wal` | metal | seam ratio ≤ base × 1.15 + 0.05 (0.3128) | **0.3100 → 0.2497** | 0.0631 (20.2% of the limit) | `grain 0.30` | detail 1.545x → 1.652x; seam margin was 0.9% before |
| `textures/e1u2/metal11_3.wal` | rust | hue shift ≤ 3° (over source chroma > 8) | **2.5433° → 2.0266°** | 0.9734° (32.4%) | `normals 4`, `wear 0.2`, `grungeDesat 0.08` | brightShare 0.006 → 0.0049 (limit 0.0070) |
| `textures/e1u1/florr1_2.wal` | stone | meanAbsRgb ≤ 10 | **5.0122 → 3.7591** | 6.2409 levels (62.4%) | `ao 0.25`, `grunge 0.95`, `grain 0.32`, `edge 0.55` | detail 3.254x → 3.353x |
| `textures/e1u1/+0btshoot2.wal` | tech | meanAbsRgb ≤ 10 | **4.9447 → 4.3278** | 5.6722 levels (56.7%) | `normals 3`, `grunge 0.5` | hue 1.9925° → 1.8117°; brightShare 0.013 → 0.0128 (limit 0.0187) |
| `textures/e1u1/color1_2.wal` | rust | 99th-pct chroma ≤ base × 1.1 + 3 (93.2; base 82) | **88 → 86** | 7.2 (7.7% of the limit) | `edge 0.15`, `desat 0.01`, `grain 0.36` | detail 2.908x |
| `+0…+4comp10_1` (5 entries) | tech | 99th-pct chroma ≤ 103.1 (base 91 × 1.1 + 3) | **+0 97→94, +1 98→94, +2 98→95, +3 97→94, +4 97→94** | 9.1 / 9.1 / 8.1 / 9.1 / 9.1 (7.9–8.8%) | `edge 0.2`, `desat 0.012` (one recipe for all five) | meanAbsRgb +0 2.43 → 2.35 |
| `textures/e1u1/wgrate1_8.wal` | rust | mean luminance bias ≤ 2 | **0.9465 → 0.0219** | 1.9781 (98.9%) | `bias -1`, `grain 0.38` | detail 1.589x → 1.678x |
| `textures/e1u1/pip01_1.wal` | rust | Pearson ≥ 0.9 | **0.9008 → 0.9359** | 0.0359 (3.99%) | `normals 3`, `grain 0.34`, `edge 0.36` | detail 4.865x → 4.880x |

**No entry was left unchanged.** `tuning.json.summary` is `improved: 14,
unchanged: [], passed: 14, failed: 0`; every tuned entry's `pass` is true.
One related entry was deliberately not touched: `textures/e1u1/+abtshoot2.wal`
is `+0btshoot2`'s toggle partner (a switchable face, not an animation frame),
so it keeps its own art; it is not one of the ten and none of these knobs
applies to it.

### The new weakest margins

The tuning moved these entries off the bottom of the set. Recomputing the same
kind of margin once over the tuned `docs/texture-review/hires-report.json`
(one `node -e` pass, no committed script, no contact sheets, no visual sweep):
for each of the 272 material entries take the **tightest** gate and express
its margin as a fraction of that gate's own limit — `(value − floor) / floor`
for a floor gate, `(limit − value) / limit` for a ceiling gate; a seam whose
boundary step is ≤ 1 level in both pictures passes by construction and is
excluded. Lower is tighter. The ten tightest are now all entries the ten did
**not** include:

| Rank | Entry | Material | Tightest gate | After | Limit | Margin |
| ---: | --- | --- | --- | ---: | ---: | ---: |
| 1 | `textures/e1u1/grnx2_9.wal` | metal | Pearson | 0.9056 | ≥ 0.9 | 0.62% |
| 2 | `textures/e1u1/comp3_5.wal` | tech | seam ratio | 0.6324 | ≤ 0.6365 | 0.64% |
| 3 | `textures/e1u1/wmtal3_5.wal` | rust | Pearson | 0.9059 | ≥ 0.9 | 0.66% |
| 4 | `textures/e1u1/ggrat4_4.wal` | metal | Pearson | 0.9060 | ≥ 0.9 | 0.67% |
| 5 | `textures/e1u1/wbasic1_4.wal` | stone | Pearson | 0.9143 | ≥ 0.9 | 1.59% |
| 6 | `textures/e1u1/pip01_4.wal` | rust | Pearson | 0.9161 | ≥ 0.9 | 1.79% |
| 7 | `textures/e1u1/grate2_1.wal` | metal | seam ratio | 1.0131 | ≤ 1.0321 | 1.84% |
| 8 | `textures/e1u1/box1_1.wal` | crate | Pearson | 0.9171 | ≥ 0.9 | 1.90% |
| 9 | `textures/e1u1/timpod.wal` | tech | Pearson | 0.9219 | ≥ 0.9 | 2.43% |
| 10 | `textures/e1u1/wswall1_2.wal` | metal | detail ratio | 1.539x | ≥ 1.5x | 2.63% |

The tuned entries' new positions by the same measure (rank of 272): `pip01_1`
23rd (Pearson 0.9359, 3.99%), `color1_2` 72nd (Pearson 0.9597, 6.63%),
`florr1_2` 86th (Pearson 0.9656, 7.29%), the comp10 family 113th–164th
(7.86–8.83%), `grnx3_3` 182nd (9.20%), `grnx2_5` 209th (9.62%), `wgrate1_8`
247th (10.08%), `metal11_3` 270th (10.61%), `+0btshoot2` 271st (10.84%) and
`wsupprt1_14` 272nd (10.91%). The tightest gate for most entries is now
Pearson, which is the measure that most often sits closest to its own floor.

Still with **no art at all**: `textures/e1u1/clip.wal`,
`textures/e1u1/clip_mon.wal`, `textures/e1u1/hint.wal`,
`textures/e1u1/origin.wal` and `textures/e1u3/clip.wal`. These are the
collision, hint and origin brushes; they are never drawn as surfaces, so
giving them art would add bytes and no picture.

## 7. End-to-end check of what the owner opens

`node scripts/e2e-check.mjs` (committed) writes
`docs/texture-review/ingame/final/e2e.json` and its screenshots. It ran after
the audit round; the archives on disk are the ones in §2.

**HTTP.** Both entry points answer, with the game page and not an error or login
page: `http://127.0.0.1:3005/apps/quake2/` returns **200**,
`text/html; charset=utf-8`, and its body contains `id="canvas"`;
`http://127.0.0.1:4231/` returns **200**, `text/html; charset=utf-8`, and its
body contains `id="canvas"`.

**Served archives.** Fetching both archives through both origins gives this
checkout's bytes:

| origin | `baseq2/pak0.pak` | `baseq2/pak9.pak` |
| --- | --- | --- |
| `:3005/apps/quake2/` | 47,498,591 B, sha1 `3fce7386…` | 41,216,186 B, sha1 `e2f2a6ef…` |
| `:4231/` | 47,498,591 B, sha1 `3fce7386…` | 41,216,186 B, sha1 `e2f2a6ef…` |

Both equal the local files, so `:4231` (the main checkout's service) is serving
the same archives this worktree ships — the merged work has reached the served
folder. The service was not restarted.

**Real Chrome.** In the open window (CDP `http://127.0.0.1:9222`), the `:4231`
load `?+map&demo1…` booted and passed every check, with the renderer string read
from the page itself: `ANGLE (Intel, Mesa Intel(R) UHD Graphics 620 (KBL GT2),
OpenGL ES 3.2)`, WebGL2, `vid_renderer gles3`, drawing buffer **1366x768**,
`baseq2/pak9.pak` in the engine FS **41,216,186 B**, and `mapname` `demo1`.
Screenshot: `ingame/final/e2e-live4231-demo1.png`. The console checks
(`r_retexturing 0` read back `0` and changed the frame; `map demo2` loaded
demo2) are `e2e-live4231-r_retexturing-0-console.png` and
`e2e-live4231-console-map-demo2.png`. The tab was left on
`http://127.0.0.1:4231/`.

**The app URL does not boot in this window.** In real Chrome,
`http://127.0.0.1:3005/apps/quake2/` redirects to
`http://127.0.0.1:3005/login?redirect=%2Fapps%2Fquake2%2F`: the game-profile
Chrome has no valid ClawBox session, so no canvas ever appears there
(`e2e.json.chrome.app3005.finalUrl`, screenshot
`ingame/final/e2e-app3005-login.png`). The HTTP checks above still hold — the
proxy serves the app page with `id="canvas"` to a request without a browser
session — but **no renderer claim is made for the app URL in a browser**, and
no login was attempted. The `:4231` evidence above is the real-Chrome evidence
for what the game draws.

Load while this ran: `e2e.json.load` — the box was busy (readings 5.2-6.1 on
8 cores), so the run waited between readings.

**Frame time.** `node scripts/texture-fps.mjs --out docs/texture-review/ingame/final
--prev 9d9d725` re-measured on the shipped archives (`9d9d725` is the archives
before the audit round, which changed neither pak). Result:
**headroom 11.88 ms/frame**, work per frame **1.4 ms NEW vs 1.5 ms OFF**
(`costMs` −0.1, −6.7%), capped medians 74.99 / 74.93 fps, uncapped **308.13**
NEW vs **337.78** OFF. Against `ingame/real/fps.json` (12.04 ms headroom at a
76.1 Hz cap, 1.1 ms NEW vs 1.4 ms OFF, uncapped ~298 fps) the verdict holds:
no added work measurable at 1366x768 and about 12 ms/frame spare under the cap.
The load warning fired again: *"the machine was busy before Chrome work
started: load average 6.72 (1 min) on 8 cores, above half the core count; frame
timings from this run are not representative of an idle box"*, and every one of
the 54 recorded windows was above the threshold (peak 8.02). The box never got
quieter than load 5.2 while this run was going, so no quieter re-run was
possible before the time budget ran out; both runs are quoted and the numbers
are read with that qualification.

## What this evidence does not cover

- The demo3 real-Chrome NEW frame is not the same game state as OFF/PREV (the
  OFF/PREV frames show a soldier on the ledge and health 95; NEW shows neither
  and health 100). The pair's 1.009-level mean diff is dominated by the
  surfaces, but its changed pixels include that soldier and the HUD. The
  headless demo3 pair, which is state-matched, carries the texture-only
  comparison.
- The FPS run's own load record says the machine was busy (load average 5.56
  before Chrome, peaks 8.39, 16 of 54 windows over the busy threshold), and the
  report warns the timings are not representative of an idle box. The 12.04 ms
  headroom is therefore indicative; the per-map uncapped rates move in both
  directions. No measurement was made at a larger drawing buffer.
- No anisotropy, mipmap-level or texture-filtering change was measured; the
  runs used `GL_LINEAR_MIPMAP_LINEAR` as recorded, and `r_anisotropic` was not
  touched.
- No contact sheets and no vision sweep of the 298 new textures; the visual
  claims are limited to the real-Chrome frames cited in §4 and the demo3
  headless pair in §3.
- No art, pak or manifest change was made in this documentation round; the
  archives are the ones named in §2. The audit round (§2) changed no art and
  no pak either.
- The §7 frame-time re-run was made on a busy box (load 6.72 before Chrome,
  peak 8.02, every window over the threshold). The box never fell below load
  5.2 during the run, so the asked-for quieter re-run could not be made; the
  §7 numbers are quoted with the report's warning, and the work-per-frame
  difference of −0.1 ms is inside that noise.
- The app URL `:3005/apps/quake2/` is verified over HTTP only, not in a browser:
  the open window's profile redirects it to `/login`, and no login was attempted
  (no credentials, and changing the device's session is out of scope). Its
  real-Chrome boot therefore remains unverified; the `:4231` evidence covers the
  same archives and the same renderer path.
- The end-to-end check is a snapshot of one moment: HTTP status, served bytes,
  renderer and canvas size at the time it ran. It says nothing about through-play
  stability, demo playback, or a different browser or GPU.
- The server was not restarted to make `:4231` serve the new archives; its
  sha1 match is evidence it already does.
