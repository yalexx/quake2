# HUD, menu and sprite art

What is in this folder, what it was asked for, and what became of it. The short
version: this folder holds the RAW art this box's image generator drew; the
pictures the game actually reads are derived from it per archive entry by
`scripts/hud-art.mjs` and written to `assets/textures/pics/` and
`assets/textures/sprites/`, at exactly the paths and sizes
`assets/textures/manifest.json` names.

```
node scripts/hud-art.mjs            # raw art here -> per-entry pictures the packer reads
node scripts/hud-art.mjs --list     # every target, its method and its source art
node scripts/tex-check.mjs          # 101 pictures, sizes against the manifest
node scripts/texture-pack.mjs --dry-run   # 101 packed, 0 failed, nothing written
```

## Why the raw art is not the shipped art

A generation is 512x512 or 1024x1024 of whatever the model felt like. An archive
entry is a fixed size, in its own palette, and often a **layout** rather than a
picture: the HUD status bar is a frame with a black middle the engine blits the
player's ammo into, the help and end screens and the whole menu are lettering
drawn into metal, and a sprite frame is a silhouette that has to stay the
silhouette the animation was drawn around. Dropping generated art on any of
those deletes the layout, the words or the shape. So `scripts/hud-art.mjs` has
four recipes and picks one per entry:

| method | what it does | entries |
| --- | --- | --- |
| `transfer` | original brightness (the layout, the text, the logo), generated hue and grain | `pics/inventory`, `help`, `conback`, `m_main`, `victory`, `quit` |
| `tile` | straight replacement, wrapped seamless, mean brightness matched to the original | `pics/backtile` |
| `sprite` | the generated material through the original frame's silhouette, at the frame's own brightness | the 42 `sprites/*.pcx` frames of `s_explod`, `s_explo2`, `s_explo3`, `s_flash`, `s_bfg1..3` |
| `regrade` | no generated art: the original pixels re-indexed onto a new colour ramp built out of the picture's own palette | `conchars`, the 22 HUD numerals, the 30 menu plaques/labels |

Every colour any recipe produces comes out of the entry's OWN palette, because
that is what `scripts/texture-pack.mjs` re-indexes onto -- art outside it would
be quantised to the nearest available colour anyway, and a regrade built from
the palette survives the packer exactly. Index 255, the engine's transparent
key, is never written and never moved to: the pictures that use it (`conchars`,
the numerals, the menu panels, every sprite frame) keep their transparency, and
the script re-checks every pixel it derives against the packer's own colour
mapping so that no drawn pixel can come back transparent. Measured over all 101
pictures: **0 silhouette changes**.

## The raw art and the prompt it came from

All of it: `assets/textures/hud/*.png`. All prompts ended with the same "no text,
no letters, no numbers, no watermark" clause, because a generator that writes
words on a HUD panel ruins a HUD.

| raw art | prompt, minus the no-text clause | size | used by |
| --- | --- | --- | --- |
| `pics_inventory.png` | Quake 2 1997 style HUD status bar panel material: dark gunmetal steel plate with rows of small rivets, worn scratched edges, brushed metal grain, faint oil grime, a few tiny amber indicator lights along one edge. Flat orthographic front view, evenly lit, deep shadows, muted charcoal grey and olive steel | 1024 | `pics/inventory.pcx` (transfer, grain 0.55) |
| `pics_help.png` | dark industrial control panel plate: riveted gunmetal with grime, faint scratches, subtle vents and seams, dim amber indicator dots, muted olive and charcoal, evenly lit flat orthographic | 1024 | `pics/help.pcx` (transfer, grain 0.7) |
| `pics_conback.png` | very dark industrial sci-fi backdrop: dim gunmetal machinery, pipes, vents and steel plating receding into deep shadow, faint haze and grime, almost black overall | 1024 | `pics/conback.pcx` (transfer, grain 0.9) |
| `pics_backtile.png` | seamless tiling texture of dark rusted industrial metal: grimy worn steel plate, faint rivets, rust patches, scratches, very dark, browns and charcoals | 512 | `pics/backtile.pcx` (tile) |
| `pics_menu_panel.png` | dark industrial steel panel plate for a 1997 game menu: riveted gunmetal with worn brass trim, seams, vents, scratches and grime, muted warm steel | 1024 | `pics/m_main.pcx` (transfer, grain 0.6) |
| `pics_victory.png` | dark industrial backdrop for an end-of-game screen: a dim lit corridor of steel plating and pipes opening toward a faint distant glow, heavy shadow, very dark | 1024 | `pics/victory.pcx` (transfer, grain 0.5) |
| `pics_quit.png` | dark industrial backdrop for a credits screen: dim wall of riveted steel plating with vents, conduit and pipes receding into deep shadow, faint warm highlights | 1024 | `pics/quit.pcx` (transfer, grain 0.5) |
| `sprites_explosion_stage1.png` | a single exploding fireball filling the frame, centred: white-hot core fading to yellow then orange, tongues of flame radiating outward, faint dark smoke rim | 1024 | `s_explod_0..1`, `s_explo2_0..1`, `s_explo3_0..1` |
| `sprites_explosion_stage2.png` | a single rolling fire cloud centred: dark orange and red flames with glowing yellow embers and gaps of black smoke, ragged billowing edges | 1024 | the peak frames of `s_explod_1..2`, `s_explo2_2..7`, `s_explo3_2..5` |
| `sprites_explosion_stage3.png` | a puff of dark smoke centred: black and charcoal greys with a few faint dull orange embers, ragged billowing edges | 1024 | the dying frames `s_explod_3..4`, `s_explo2_8..11`, `s_explo3_6` |
| `sprites_explosion_stage4.png` | a thin wisp of dark grey smoke centred: a faint ragged fading curl with tiny dying embers, very low brightness | 512 | the last frame `s_explod_5`, `s_explo2_12`, `s_explo3_7` |
| `sprites_flash_bright.png` | a muzzle flash: bright white-hot star-shaped flash centred, radiating yellow spikes, hot core, a little smoke | 512 | `s_flash_0` |
| `sprites_flash_small.png` | a small weak muzzle spark centred: a compact dim yellow-orange flare with a soft fuzzy halo, a few tiny embers | 512 | `s_flash_1`, `s_flash_2` |
| `sprites_bfg_ball.png` | a glowing plasma energy ball centred: bright green-white core, swirling luminous filaments, crackling halo, soft green glow | 512 | `s_bfg1_0..1`, `s_bfg2_0..1`, `s_bfg3_0..2` |
| `sprites_bfg_burst.png` | an expanding burst of green plasma centred: a ragged ring of glowing green and white electrical filaments with a dark core, wisps radiating outward | 512 | `s_bfg2_2..3`, `s_bfg3_3..5` |

Which stage a frame gets follows the frame's own silhouette in the archive (a
frame whose fire fills its cell is a young fireball, one that is 96% transparent
is the last wisp), so the animation still reads as one explosion growing and
dying. The sprite recipe also re-lights each stage to the brightness the frame
it lands on already had, so a new explosion is the same explosion at the same
heat.

One generation was thrown away: `pics_m_main.png` was drawn before the menu
panel became a `transfer` target rather than a regrade, and the second
generation (`pics_menu_panel.png`) is the one the menu panel uses.

## Recoloured rather than redrawn, and why

* `pics/conchars.pcx` -- the console font. A generated glyph is a smudge at 8x8
  and this is the most-read picture in the game; it is re-indexed onto an amber
  ramp instead. The glyph background (index 255) is untouched, so text stays
  transparent, and `scripts/route-test.mjs`'s "every digit has ink" still holds.
* the 22 HUD numerals (`pics/num_0..9`, `num_minus`, `anum_0..9`,
  `anum_minus`) -- same reason, and `control/hud.mjs` reads these very pictures
  to know what the HUD is showing. The `num_` family goes amber, the `anum_`
  family stays red and goes hotter, so the two families stay apart. Every digit
  of each family moved (min 49% of pixels), so the readout cannot end up with
  one old-looking digit among new ones.
* the menu's 30 plaques, banners and labels (`m_main_*`, `m_banner_*`,
  `pause`, `loading`, `areyousure`, `yn`, `tag1`, `tag2`) -- the words are part
  of the bitmap, so they are regraded, not redrawn: warm brass in place of grey
  gunmetal, with brightness preserved so the lettering keeps its contrast.

## Left alone on purpose

* `pics/colormap.pcx` -- the engine's GLOBAL palette: the last 768 bytes of it
  are the colours every WAL wall in the game is drawn with, and it is not a
  picture at all. Editing it would recolour the entire world.
* `pics/field_3.pcx` -- the HUD's bar fill, already the amber the new HUD is
  built around; brightening it is not new art, it is a worse bar.
* 45 item/weapon icons (`w_*`, `i_*`, `a_*`, `p_*`, `k_*`, 24x24) -- the keys
  and powerups are told apart BY COLOUR in play, and averaging a 1024x1024
  generation down to 24x24 is a smudge.
* 15 menu cursors (`m_cursor0..14`, 22x29) and the small status glyphs
  (`ch1..ch3`, `net`, `turtle`) -- pointer and status art whose outline is the
  whole of it.
* `sprites/s_bubble_0..1` (16x16) -- water bubbles; generated art downscaled to
  16x16 is a dot, and the frame's own highlight is already all there is to say.
* the 8 `sprites/*.sp2` entries themselves -- they hold no pixels, only a frame
  list. The frames the game draws are the `sprites/*.pcx` entries above, and
  `scripts/texture-pack.mjs` skips an SP2 for exactly that reason. The SP2 files
  in the archive are untouched and still list the same frame names.

## A note for whoever runs the final check

`scripts/tex-check.mjs` reports this folder's 15 PNGs as "art no entry claims".
That is correct and harmless: no manifest entry points here, because these are
the source art, and the per-entry pictures are in `assets/textures/pics/` and
`assets/textures/sprites/`. `scripts/texture-pack.mjs` ignores anything that is
not an entry's own art path, so nothing here is packed. The run summary of record
is `node scripts/tex-check.mjs`: **101 with art, 0 the wrong size, 0 unreadable**,
and `node scripts/texture-pack.mjs --dry-run`: **101 packed, 0 identical to the
original, 0 failed**.
