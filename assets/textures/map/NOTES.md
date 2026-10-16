# New art for the demo1 map textures

105 new pictures: one for every WAL entry that `maps/demo1.bsp` actually draws,
drawn by `scripts/map-art.mjs`. The surface textures the map puts on its walls,
floors, ceilings, doors, lights, trim and grates are the ones this covers, most
used first -- `textures/e1u1/flat1_2.wal` (611 faces) down to the single-face
decals. The 39 other used-by-nobody map entries, and everything outside the map
namespace (pics, models, sprites), belong to the other art tasks.

## Where the art is, and one deliberate difference from the task text

The task asked for `assets/textures/map/<entry-name-with-slashes-as-underscores>.png`.
Art in that folder could never reach the game, so each picture is instead written
at the path `assets/textures/manifest.json` gives for its entry -- the archive
name with the extension turned into `.png`:

    textures/e1u1/flat1_2.wal  ->  assets/textures/textures/e1u1/flat1_2.png

That is the path `artPathFor()` builds and the only path `scripts/texture-pack.mjs`
packs from (`texture-pack.mjs:147-274`); a PNG elsewhere under the art directory
is reported by `scripts/tex-check.mjs` as "unclaimed", i.e. art that will never
reach the game. This note sits in `assets/textures/map/` as the task asked, and
nothing else does.

The task also said the packer downsamples art to the entry's dimensions. It does
not: `texture-pack.mjs:268` fails the whole run when a decoded PNG is not exactly
the entry's width and height. Every picture here is therefore produced at the
entry's exact size, and it is `scripts/tex-check.mjs` that proves it.

## Why the pictures are drawn rather than generated

This run's image generator refused every path it was offered with
`BLOCKED_PATH` -- a path relative to the worktree, an absolute path inside the
worktree, and an absolute path inside this run's evidence folder -- reporting
each as "outside your working folder and your evidence folder". The tool's
sandbox does not appear to include this worktree, so no generated 1024x1024
sources exist for this run and every picture here is drawn procedurally by
`scripts/map-art.mjs`, which is the fallback the task names for exactly this
situation (the reason differs: a path sandbox, not the image allowance). The
lead has been told. The generated-picture route is implemented and documented
below, so a later run that can reach the generator only has to drop its squares
in and re-run.

## How each picture was produced

Each entry gets a recipe chosen from the entry's name (see the table at the end),
drawn at the entry's own size with seeded, tileable value-noise fBm:

| family | what it draws | entries |
| --- | --- | --- |
| `floor` | slabs of concrete with dark grout, grit, stains, the odd darker slab | flat1_*, floor3_*, florr1_2 |
| `metal` | ribbed steel wall, horizontal seam with bolts, rust running down from it, scratches | metal1_*, metal2_*, metal3_*, metal5_*, metal6_* |
| `grate` | thick lattice bars over a dark void, bolts at the intersections, light on the bars' top lip | grate*, ggrat*, ggrate* |
| `rock` | ridged chunky stone with crack lines | rocks*, grnmt1_1 |
| `grass` | clumpy organic growth | grass1_7 |
| `grime` | grimy film of blotches and fine grain (the map's most-used small tile) | grnx* |
| `ceil` | ceiling panels with recessed seams, louvre slats on the big ones | ceil* |
| `pillar` | ribbed pillar with a banded foot and head | support1_1, baselt_*, pipe1_3 |
| `crate` | planked crate with a bright frame and corner bolts | box*, crate* |
| `broken` | pitted, cracked plating with impact craters | broken*, damage* |
| `color` | a flat tinted panel with a bevelled edge and scuffs | color1_*, color2_* |
| `door` | two leaves, a centre seam, a stripe, bolts | dr02_1 |
| `computer` | dark plate with rows of lit indicators | comp3_2, comp4_2 |
| `window` | dark glass in a frame with a mullion cross and reflections | wndow0_3 |
| `water` | churning ridged caustics | bluwter |
| `hazard` | worn diagonal warning chevrons | yellow1_4 |
| `light` | a bright panel in a dark frame | plite1_1 |
| `sky` | a bright band of cloud across a darker overhead | sky1 |
| `arrow` | the floor decal, drawn as an arrow | arrow0 |
| `sign` | a blank bolted plate (no lettering) | kcsign4 |
| `panel`, `concrete`, `trigger`, `pod`, `black` | base wall panels, base slab, the never-drawn trigger tile, the timed pods, and the level's black | basic1_7, cgrbase1_1, trigger, timpod*, black |

Three things make the result still look like this level rather than like noise:

* **Colour comes from the original.** Each picture is coloured along a ramp built
  from the palette colours the ORIGINAL texture uses at its 8th, 50th and 92nd
  luminance percentiles (read out of the PAK with `decodeWal` +
  `globalPalette`), so a brown wall stays brown and a green one green. The
  bright and dark accents are the original's own brightest and darkest palette
  colours.
* **Brightness and contrast are matched, not invented.** The mean luminance is
  pulled halfway onto the original's -- the level's lighting is baked into how
  bright these tiles are, and a wall that suddenly lights up would change the
  room it is in -- and the contrast is matched to about 1.2x the original's, so a
  replacement never reads as an untextured surface.
* **Everything tiles.** The noise lattices wrap at the texture's own size and the
  grid, rib and bar patterns have periods that divide it exactly, so a tile meets
  itself at the edges; the measured wrap step across the 105 pictures is at most
  about 3/255, i.e. invisible. A little per-pixel dithering is added before
  colouring, the way an eight-bit texture dithers a gradient.

Animated textures are handled deliberately. `+0cgrate1_1`, `+0cgrate3_1` and
`+0btshoot1` are left exactly as they were: the archive also holds their `+1`
siblings and the engine animates through them, so replacing only frame 0 would
make the animation flicker between new and old art. `timpod` .. `timpod8` are
drawn as one pod body with a band that moves with the frame index, so that
animation reads as a light chasing the pod instead of eight unrelated pictures.

## How it was checked

* `node scripts/tex-check.mjs` -- exit 0, `105 with art ... 0 the wrong size, 0
  unreadable, 0 unclaimed`.
* `node scripts/texture-pack.mjs --dry-run` -- `105 packed (0 identical to the
  original), ... 0 failed`; the archive's SHA-1 is unchanged
  (`b86e8878a8e8706595ceebe88b3e6b4c1ba5bcab`) and its mtime untouched, so
  nothing wrote `baseq2/pak0.pak`.
* Running `scripts/map-art.mjs` twice produces byte-identical PNGs: the art is
  deterministically redrawable.
* Each drawn picture is decoded again right after it is written and its
  dimensions checked, so an encoder that lies about its own header fails here.
* Mapping the art through the packer's own palette (`paletteMapper` +
  `rgbaToIndices`) gives an average of 15.9 distinct palette indices per texture;
  the only picture that collapses to a single colour is `e1u1/black`, which is
  what that texture is for.

## Putting art into the game, and the format it has to be

    node scripts/map-art.mjs                 # redraw every used map texture
    node scripts/map-art.mjs --list          # what each entry would get
    node scripts/map-art.mjs --sheet out.png --pairs   # original vs new
    node scripts/texture-pack.mjs            # swap the art into baseq2/pak0.pak

A Quake 2 WAL entry is a 100-byte header (`char name[32]`, `u32 width`,
`u32 height`, `u32 offsets[4]`) followed by four mip levels of eight-bit indices
and nothing else: the 303 WALs in this archive carry no palette, they are indexed
into one global palette, the last 768 bytes of `pics/colormap.pcx`. So a
replacement has to be the entry's exact width and height (the renderer indexes
the mip chain by them) and the packer re-indexes the new pixels onto that palette
for you, keeping the entry's own flags, contents and value fields. Art is
therefore just an 8-bit RGB PNG of the right size; colour fidelity is limited by
that 256-colour palette, which is why these pictures lean on bold shapes and
strong value contrast rather than fine colour detail.

If the image generator becomes usable, drop its squares in as
`assets/textures/map/<entry-name-with-slashes-as-underscores>.png` and run
`node scripts/map-art.mjs --src assets/textures/map`: each square is cropped to
the entry's aspect, its borders are blended into the pixels that would sit beside
them when tiled (so the tile is seamless) and it is box-filtered down to the
entry's size. The prompts to use per family follow the task's template, e.g.
"grim industrial sci-fi Quake 2 wall texture, gritty 1997 first-person-shooter
look, high contrast, seamless tiling, weathered concrete and rusted metal, no
text, no watermark, no logo" -- varied per family as "industrial metal floor
tread plate", "rusted corrugated steel wall", "cracked rock cliff", "heavy rusty
iron grating", "riveted steel plate", "ceiling panel".

## Entries and recipes

| entry | faces | size | how it was made |
| --- | --- | --- | --- |
| `e1u1/flat1_2` | 611 | 64x64 | procedural:floor |
| `e1u1/metal2_1` | 588 | 64x128 | procedural:metal |
| `e1u1/rocks19_1` | 471 | 256x128 | procedural:rock |
| `e1u1/metal3_5` | 357 | 64x64 | procedural:metal |
| `e1u1/grnx2_9` | 342 | 16x16 | procedural:grime |
| `e1u1/floor3_1` | 312 | 64x64 | procedural:floor |
| `e1u1/grate2_2` | 260 | 64x64 | procedural:grate |
| `e1u1/grass1_7` | 256 | 64x64 | procedural:grass |
| `e1u1/support1_1` | 226 | 32x128 | procedural:pillar |
| `e1u1/sky1` | 214 | 32x32 | procedural:sky |
| `e1u1/metal2_4` | 212 | 64x128 | procedural:metal |
| `e1u1/ggrat4_2` | 209 | 128x128 | procedural:grate |
| `e1u1/ggrat4_4` | 192 | 16x16 | procedural:grate |
| `e1u1/grate1_4` | 184 | 64x64 | procedural:grate |
| `e1u1/broken2_3` | 167 | 64x32 | procedural:broken |
| `e1u1/trigger` | 156 | 32x32 | procedural:trigger |
| `e1u1/metal1_5` | 150 | 64x64 | procedural:metal |
| `e1u2/basic1_7` | 146 | 64x64 | procedural:panel |
| `e1u1/metal3_6` | 132 | 64x64 | procedural:metal |
| `e1u1/flat1_1` | 125 | 64x64 | procedural:floor |
| `e1u1/metal1_3` | 118 | 64x64 | procedural:metal |
| `e1u1/grate2_1` | 116 | 64x64 | procedural:grate |
| `e1u1/metal3_2` | 114 | 64x64 | procedural:metal |
| `e1u1/metal3_4` | 114 | 64x64 | procedural:metal |
| `e1u1/color1_6` | 113 | 64x64 | procedural:color |
| `e1u1/bluwter` | 102 | 64x64 | procedural:water |
| `e1u1/metal5_2` | 102 | 128x128 | procedural:metal |
| `e1u1/grate1_3` | 96 | 64x64 | procedural:grate |
| `e1u1/grate2_4` | 89 | 64x64 | procedural:grate |
| `e1u1/metal1_8` | 89 | 64x64 | procedural:metal |
| `e1u1/grate2_5` | 77 | 64x64 | procedural:grate |
| `e1u1/ggrat12_4` | 75 | 64x64 | procedural:grate |
| `e1u1/grnx2_2` | 60 | 64x64 | procedural:grime |
| `e1u1/color1_4` | 58 | 64x64 | procedural:color |
| `e1u1/timpod7` | 58 | 64x64 | procedural:pod |
| `e1u1/dr02_1` | 56 | 128x128 | procedural:door |
| `e1u1/grnx2_3` | 56 | 64x64 | procedural:grime |
| `e1u1/box1_5` | 55 | 64x64 | procedural:crate |
| `e1u1/grate2_3` | 53 | 64x64 | procedural:grate |
| `e1u1/grate1_1` | 52 | 64x64 | procedural:grate |
| `e1u1/grnx2_6` | 51 | 64x64 | procedural:grime |
| `e1u1/grate2_7` | 44 | 64x64 | procedural:grate |
| `e1u1/rocks16_2` | 44 | 128x128 | procedural:rock |
| `e1u1/metal6_1` | 41 | 128x128 | procedural:metal |
| `e1u1/ceil1_8` | 37 | 16x16 | procedural:ceil |
| `e1u1/baselt_2` | 36 | 32x128 | procedural:pillar |
| `e1u1/grnx2_7` | 36 | 64x64 | procedural:grime |
| `e1u1/timpod6` | 36 | 64x64 | procedural:pod |
| `e1u1/floor3_2` | 35 | 64x64 | procedural:floor |
| `e1u1/color2_4` | 32 | 64x64 | procedural:color |
| `e1u1/ggrate7_1` | 29 | 128x128 | procedural:grate |
| `e1u1/grnx1_2` | 29 | 128x128 | procedural:grime |
| `e1u1/baselt_b` | 27 | 16x16 | procedural:pillar |
| `e1u1/box3_1` | 24 | 64x64 | procedural:crate |
| `e1u1/color1_3` | 24 | 64x64 | procedural:color |
| `e1u1/box3_3` | 23 | 64x64 | procedural:crate |
| `e1u1/broken2_2` | 22 | 64x16 | procedural:broken |
| `e1u1/color1_2` | 22 | 64x64 | procedural:color |
| `e1u1/grnx3_2` | 21 | 128x64 | procedural:grime |
| `e1u1/box3_2` | 20 | 64x64 | procedural:crate |
| `e1u1/color1_7` | 18 | 64x64 | procedural:color |
| `e1u1/comp4_2` | 18 | 64x64 | procedural:computer |
| `e1u1/wndow0_3` | 17 | 128x128 | procedural:window |
| `e1u1/crate1_1` | 14 | 64x64 | procedural:crate |
| `e1u1/grnx3_3` | 14 | 128x64 | procedural:grime |
| `e1u1/metal5_1` | 14 | 128x128 | procedural:metal |
| `e1u1/pipe1_3` | 14 | 64x64 | procedural:pillar |
| `e1u1/broken1_1` | 13 | 64x16 | procedural:broken |
| `e1u1/box1_1` | 12 | 96x32 | procedural:crate |
| `e1u1/box1_6` | 12 | 64x64 | procedural:crate |
| `e1u1/ggrat6_1` | 12 | 128x128 | procedural:grate |
| `e1u1/grate1_6` | 12 | 64x64 | procedural:grate |
| `e1u1/grnx1_1` | 12 | 128x128 | procedural:grime |
| `e1u1/timpod2` | 12 | 32x32 | procedural:pod |
| `e1u1/ceil1_4` | 10 | 16x16 | procedural:ceil |
| `e1u1/grate2_8` | 8 | 64x64 | procedural:grate |
| `e1u1/grnx3_1` | 8 | 128x64 | procedural:grime |
| `e1u1/timpod8` | 8 | 64x64 | procedural:pod |
| `e1u1/yellow1_4` | 7 | 64x16 | procedural:hazard |
| `e1u1/box3_4` | 5 | 64x64 | procedural:crate |
| `e1u1/box3_6` | 5 | 64x64 | procedural:crate |
| `e1u1/ggrat5_2` | 5 | 128x128 | procedural:grate |
| `e1u1/broken2_4` | 4 | 64x32 | procedural:broken |
| `e1u1/damage1_2` | 4 | 128x128 | procedural:broken |
| `e1u1/ggrat6_2` | 4 | 128x128 | procedural:grate |
| `e1u1/plite1_1` | 4 | 16x16 | procedural:light |
| `e1u1/box3_5` | 3 | 64x64 | procedural:crate |
| `e1u1/comp3_2` | 3 | 64x64 | procedural:computer |
| `e1u1/crate1_6` | 3 | 64x64 | procedural:crate |
| `e1u1/damage1_1` | 3 | 128x128 | procedural:broken |
| `e1u1/ggrat5_1` | 3 | 128x128 | procedural:grate |
| `e1u1/timpod5` | 3 | 64x64 | procedural:pod |
| `e1u1/+0btshoot1` | 2 | 32x32 | skipped (animated frame) |
| `e1u1/cgrbase1_1` | 2 | 64x64 | procedural:concrete |
| `e1u1/florr1_2` | 2 | 64x64 | procedural:floor |
| `e1u1/ggrat4_3` | 2 | 16x16 | procedural:grate |
| `e1u1/kcsign4` | 2 | 128x64 | procedural:sign |
| `e1u1/metal2_2` | 2 | 64x64 | procedural:metal |
| `e1u1/metal2_3` | 2 | 64x64 | procedural:metal |
| `e1u1/metal6_2` | 2 | 128x128 | procedural:metal |
| `e1u1/timpod` | 2 | 64x64 | procedural:pod |
| `e1u1/+0cgrate1_1` | 1 | 64x32 | skipped (animated frame) |
| `e1u1/+0cgrate3_1` | 1 | 64x32 | skipped (animated frame) |
| `e1u1/arrow0` | 1 | 32x32 | procedural:arrow |
| `e1u1/black` | 1 | 16x16 | procedural:black |
| `e1u1/grnmt1_1` | 1 | 128x128 | procedural:rock |
| `e1u1/timpod3` | 1 | 32x32 | procedural:pod |
| `e1u1/timpod4` | 1 | 32x32 | procedural:pod |
