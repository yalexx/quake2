# Changelog

What changed and why, newest first. The state of the art pipeline -- what is in
the archive, where the art lives, the commands and the measurements behind them
-- is in [Texture art](README.md#texture-art); the per-namespace records are in
`assets/textures/*/NOTES.md`. This file is the record of the defects found on the
way and what closed them, because those are the parts a reader cannot recover
from the files as they now stand.

## Texture art in the game

### Shipped

- **475 of the manifest's 603 pictures are now inside `baseq2/pak0.pak`**, in
  place of the demo's own: the walls, floors, ceilings and trim of all three
  levels, the weapons, monsters and items, the HUD status bar, the menu, the
  console font and the sprite animations. The other **631 entries are byte for
  byte what they were**. Archive sha1 `9ddbf5276c7f8fbc3b3e719f97b0fc05a3ee51ea`,
  reproducible from the archive as the demo shipped it
  (`b86e8878a8e8706595ceebe88b3e6b4c1ba5bcab`) plus this repository's art and
  nothing else.
- `scripts/map-art.mjs` now draws the surfaces of **every map in the archive**,
  not just `maps/demo1.bsp`: 141 more entries, so demo2's and demo3's walls and
  floors are new too.

### Fixed

- **The model, weapon, item and monster skins were shipping mangled art.** What
  was committed for them was 99.8% off the entries' own palettes -- 2652 of 2657
  distinct colours on one skin -- so `scripts/texture-pack.mjs` snapped every
  pixel to the nearest colour at pack time and the archive stopped being the art
  on disk. **Cause:** the art on disk was not what `scripts/model-art.mjs`
  produces (the tool's own output is fully on-palette; its `--fallback` route
  reproduces commit `44c1dd4` byte for byte on all 125 entries, which is how this
  was established). **Fix:** re-derived all 125 entries with the repository's own
  tool. The skins now keep the original's structure instead of being replaced:
  Pearson r 0.93 to 0.97 per family over the packed pixels (the tool's own
  measure before packing reads 0.955 to 0.992), against a mean of ~0 for the art
  they had.
- **Skin cut-outs were being punched through, and lost.** The dither that snaps
  a skin onto its palette was free to choose **index 255** -- the engine's
  transparent colour -- as the "nearest" colour for a mid-brown pixel, so an
  opaque pixel came back see-through; separately the stale art above had dropped
  1814 pixels of the cut-out on `models/monsters/parasite/tip/base.pcx` alone and
  invented 1076 on `models/monsters/infantry/skin.pcx`. **Fix:** index 255 is out
  of the dither's search (`palettise(..., { exclude: [TRANSPARENT_INDEX] })`) and
  the original's real cut-out is set back afterwards (`restoreCutout`), which is
  the other half of the rule `texture-pack.mjs` already applied. **Measured over
  all 475 packed entries: 0 silhouette faults of any size**, from 76.
- **26 tiles were shipping flatter than the surface they replaced.** A generated
  1024x1024 picture cropped to an entry's aspect and box-averaged onto a 16x16 or
  32x32 entry becomes a single tone: `textures/e1u1/ceil1_4` (16x16) arrived at
  luminance spread 4.0 against the original's 58.5, and `sky1` at 3.8 with mean
  luminance 35 against 201 -- which is why the sky read as night. **Fix:** drawn
  again procedurally, which draws at the entry's own size. The test is on what
  *ships*, through the packer's own re-indexing; every textured entry is now at
  half its original contrast or better, except three animated frames (left whole
  on purpose) and two entries at 46% and 48% whose originals are the set's
  highest-contrast (sd 90.6 and 87.5, against the recipes' 42-43).
- **`tex-check.mjs --only` reported every other namespace's art as "art no entry
  claims"** (350 of them for `--only models/`), which is how a genuinely stray
  picture hides in plain sight. A run now claims the entries it did not check.
- **The 15 pictures under `assets/textures/hud/` were reported as unclaimed.**
  They are not orphans: they are the generation sources `scripts/hud-art.mjs`
  derives the HUD, menu and sprite entries from, and it reproduces the 101
  shipped pictures from them exactly. The source folders are now declared
  (`SOURCE_ART_DIRS` in `scripts/texture-lib.mjs`) and counted as `sourceArt`,
  while anything else under the art directory that no entry claims is still
  reported -- checked with a planted stray file.

### Left alone, on purpose

128 pictures stay on the art the demo shipped: 66 `pics/*.pcx` (item and weapon
icons, menu cursors, status glyphs, `colormap.pcx`, `field_3.pcx`), 51 WALs no
map in the archive draws, 6 `env/` sky faces, the 3 animated frames whose
families are left whole (redrawing frame 0 of an animation makes it flicker) and
`sprites/s_bubble_0..1`. The reason for each group is in the NOTES file for its
namespace.

### Tooling and tests

- `scripts/tex-lib-test.mjs` -- the checker's own rules: source art against art
  no entry claims, the `--only` claim, and the two gates that stop a run (a
  wrong-size picture, and `--require-all`).
- `scripts/texture-pack-test.mjs` -- what the packer refuses and what it leaves
  behind, including that a refused run writes no archive and that `--out` never
  touches its input. Its last check proves it: the shipped archive is compared
  byte for byte with the blob the commit holds.
- `scripts/map-art-test.mjs` -- which surfaces the map art covers, that a shared
  texture carries every map's uses, and that the animated frames are still
  refused.
- `README.md` gained the [Texture art](README.md#texture-art) section (it had
  none), naming the tools, the three routes the art came from and how to check
  the result; the three `assets/textures/*/NOTES.md` are in sync with what
  shipped.
