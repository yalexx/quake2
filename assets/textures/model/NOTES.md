# Model, weapon, item and monster skins -- new art (task t3)

Every entry this task owns is a PCX inside `baseq2/pak0.pak`: a single UV atlas
picture, not a seamless tiling wall. There are 125 of them -- the weapon
models (first-person `v_*` and world `g_*`), the items (health, armour, ammo,
power-ups, keys), the monsters, and the objects, debris and gibs.

The art for each entry is at the path `assets/textures/manifest.json` names for it
(`assets/textures/models/...`), which is where `scripts/tex-check.mjs` looks and
where `scripts/texture-pack.mjs` (t1) reads it from. `scripts/model-art.mjs` is the
tool that produced it, and this directory is its staging area and its record.

## What actually happened: no generated picture shipped

The plan was one generated picture per entry, from the prompt table below. This
box's image generator refused every path this run could legally write, each with
`BLOCKED_PATH` ("outside your working folder and your evidence folder"):

- `assets/textures/model/models_weapons_v_handgr_skin.png` (relative),
- `/home/yanko/Projects/quake2/.clawbox/worktrees/t3-1/assets/textures/model/...` (this run's own folder),
- `/home/yanko/clawbox/data/coding-agent-artifacts/run-s8f6xhmo/...` (this run's evidence folder),
- `/home/yanko/clawbox/data/coding-agent-inputs/run-s8f6xhmo/...` (the inputs folder),
- and a bare `models_weapons_v_handgr_skin.png`.

So no generated picture exists for any entry, and **the whole set ships the node
route instead**: `node scripts/model-art.mjs --fallback` redraws each of the 125
original pictures from its own pixels, at its own size, and re-indexes the result
onto that entry's own palette. The subject is untouched -- every pair sits in the
same registration as the original, which is what makes this safe to swap in -- and
what changes is the surface: contrast, colour, relief and grime.

## Method

1. **Generate** (the plan of record, for a run whose image generator works). One
   picture per entry at `assets/textures/model/<entry name with / as _>.png`, from
   the prompt in the table below: the subject the original drew, described as the
   flat UV skin sheet it has to be, in the style of a Quake 2 1997 asset.
2. **Build.** `node scripts/model-art.mjs --build` cover-fit crops each generation to
   the entry's aspect (so a square picture is never squashed into 308x165) and
   area-averages it onto the entry's exact dimensions from the manifest.
3. **Fallback.** `node scripts/model-art.mjs --fallback` fills every entry with no
   generated picture of its own, by its family's art direction (the table below).
   The grading happens in luminance and the colour difference is carried through
   untouched, because contrasting each channel separately would move saturated
   colours along their own axes -- a red that gains green reads orange -- and an
   entry would come out recoloured rather than re-lit. The contrast curve is pivoted
   at the middle of that picture's own range, not at 128, with black and white
   pinned: a low-key picture, whose whole histogram sits below 128, would be pushed
   further down by a curve pivoted at 128 and come out flatter than it started.
   Then a saturation push (a scale of the colour difference, which cannot turn a
   hue), a directional relight that reads the luminance gradient as a surface normal
   and lights it from the upper left, an unsharp pass, fine value noise and -- on
   metal -- a deterministic scatter of thin bright scratches. Every pixel the
   original left at palette index 255 is put back to that index's colour, so a
   skin's cut-out stays a cut-out.

What that adds up to, measured over the 125 entries (the tool prints these numbers):

- **contrast**: mean luminance spread rises in every family -- metal 31.1 to 36.2,
  organic 23.4 to 29.6, energy 72.0 to 74.5, fabric 26.4 to 34.0 -- and only 5
  entries out of 125 end up with a narrower spread than they started with (plus the
  deliberately untouched `objects/black`);
- **still the same picture**: Pearson r between each original and its replacement is
  0.955 to 0.992 per family, and never below 0.923 for any entry -- this is a grading
  of the art, not a substitute for it;
- **hue**: mean shift 2.8 to 5.0 degrees over the pixels that have a hue at all, worst
  single entry 10.7 degrees, so no entry was recoloured;
- **against the palette**: re-indexing onto the entry's own 256 colours costs a mean
  2.5 to 5.7 of 255 per channel, with the error diffused rather than banded.
4. **Snap to the palette.** Both routes end here: the packer re-indexes every pixel
   onto the palette the entry's own PCX carries, by nearest colour, so the art is
   snapped first with Floyd-Steinberg error diffusion. The PNG then holds exactly
   the colours that palette can say and the packer's snap is a no-op on every
   pixel: what the contact sheet shows is what the engine shows.
5. **Check.** See the checks below; none of them writes to the archive.

## Family parameters

| family | entries | saturation | contrast curve | relight | unsharp | grain | scratches |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `metal` | 76 | 1.22 | 0.52 | 0.35 | 0.26 | 0.032 | 30 |
| `organic` | 35 | 1.3 | 0.58 | 0.38 | 0.32 | 0.05 | 0 |
| `energy` | 12 | 1.3 | 0.32 | 0.18 | 0.2 | 0.022 | 0 |
| `fabric` | 1 | 1.16 | 0.48 | 0.28 | 0.34 | 0.055 | 0 |
| `flat` | 1 | 1 | 0 | 0 | 0 | 0 | 0 |

A picture's family comes from its own name: `objects/black` is flat (left alone),
the flashes, smoke, explosions, laser and the armour energy field are energy, the
monsters, gibs and corpses are organic, the banner is fabric, and everything else --
weapons, items, ammo, keys, barrels, debris, props and ships -- is metal.

## Coverage

- 125 entries belong to this task (all PCX, all under `models/`).
- 0 have a generated picture; 125 have art in `assets/textures/models/`.
- Nothing is left at the original art: every entry of this task has a new picture
  and every one of them is a different picture from the archive's, so the pack
  replaces all 125 of them.

## Entries

| entry | size | palette | family | art | prompt |
| --- | --- | --- | --- | --- | --- |
| `models/weapons/v_bfg/skin.pcx` | 216x195 | `pcx:65a6fbc2e70b` | `metal` | refreshed in node | a flat UV skin sheet for a huge heavy energy cannon: scratched gunmetal plating with a green-glowing core and warning stripes, Quake 2 1997 first-person-shooter asset, weathered sci-fi metal and grime, flat studio lighting, centred subject, no text, no watermark, no logo |
| `models/weapons/v_blast/skin.pcx` | 296x164 | `pcx:a13dc155ee7a` | `metal` | refreshed in node | a flat UV skin sheet for a plasma blaster: scorched gunmetal with a heated glowing chamber and vents, Quake 2 1997 first-person-shooter asset, weathered sci-fi metal and grime, flat studio lighting, centred subject, no text, no watermark, no logo |
| `models/weapons/v_chain/skin.pcx` | 264x164 | `pcx:65a6fbc2e70b` | `metal` | refreshed in node | a flat UV skin sheet for a six-barrelled rotary chain gun: scratched steel, rotating barrel cluster, feed belt and armour plates, Quake 2 1997 first-person-shooter asset, weathered sci-fi metal and grime, flat studio lighting, centred subject, no text, no watermark, no logo |
| `models/weapons/v_disint/skin.pcx` | 216x195 | `pcx:65a6fbc2e70b` | `metal` | refreshed in node | a flat UV skin sheet for an energy rifle: scratched steel with a crackling discharge emitter and glowing coils, Quake 2 1997 first-person-shooter asset, weathered sci-fi metal and grime, flat studio lighting, centred subject, no text, no watermark, no logo |
| `models/weapons/v_flareg/base.pcx` | 312x169 | `pcx:38cdb21b71f6` | `metal` | refreshed in node | a flat UV skin sheet for a flare gun: scratched gunmetal, a fat short barrel and an orange warning band, Quake 2 1997 first-person-shooter asset, weathered sci-fi metal and grime, flat studio lighting, centred subject, no text, no watermark, no logo |
| `models/weapons/v_handgr/skin.pcx` | 308x195 | `pcx:65a6fbc2e70b` | `metal` | refreshed in node | a flat UV skin sheet for a handheld energy blaster pistol: gunmetal with scratches, side panels, seams, rivets and a glowing blue power cell, Quake 2 1997 first-person-shooter asset, weathered sci-fi metal and grime, flat studio lighting, centred subject, no text, no watermark, no logo |
| `models/weapons/v_hyperb/skin.pcx` | 296x194 | `pcx:65a6fbc2e70b` | `metal` | refreshed in node | a flat UV skin sheet for a hyperblaster energy gun: scratched steel with glowing blue capacitor cells and vents, Quake 2 1997 first-person-shooter asset, weathered sci-fi metal and grime, flat studio lighting, centred subject, no text, no watermark, no logo |
| `models/weapons/v_launch/skin.pcx` | 248x194 | `pcx:65a6fbc2e70b` | `metal` | refreshed in node | a flat UV skin sheet for a grenade launcher: chunky scratched gunmetal, a revolving cylinder, sight rail and rivets, Quake 2 1997 first-person-shooter asset, weathered sci-fi metal and grime, flat studio lighting, centred subject, no text, no watermark, no logo |
| `models/weapons/v_machn/skin.pcx` | 300x194 | `pcx:65a6fbc2e70b` | `metal` | refreshed in node | a flat UV skin sheet for a heavy machine gun: gunmetal with scratches, a box magazine, cooling vents and rivets, Quake 2 1997 first-person-shooter asset, weathered sci-fi metal and grime, flat studio lighting, centred subject, no text, no watermark, no logo |
| `models/weapons/v_rail/skin.pcx` | 308x181 | `pcx:65a6fbc2e70b` | `metal` | refreshed in node | a flat UV skin sheet for an electromagnetic railgun: gunmetal with scratches, copper coil windings along the barrel and glowing rails, Quake 2 1997 first-person-shooter asset, weathered sci-fi metal and grime, flat studio lighting, centred subject, no text, no watermark, no logo |
| `models/weapons/v_rocket/skin.pcx` | 252x194 | `pcx:65a6fbc2e70b` | `metal` | refreshed in node | a flat UV skin sheet for a shoulder-fired rocket launcher: scarred olive-drab metal tube, warning stripes, grips and rivets, Quake 2 1997 first-person-shooter asset, weathered sci-fi metal and grime, flat studio lighting, centred subject, no text, no watermark, no logo |
| `models/weapons/v_shotg/skin.pcx` | 264x180 | `pcx:65a6fbc2e70b` | `metal` | refreshed in node | a flat UV skin sheet for a pump-action shotgun: blued steel with scratches, a wooden pump grip, seams and shell ports, Quake 2 1997 first-person-shooter asset, weathered sci-fi metal and grime, flat studio lighting, centred subject, no text, no watermark, no logo |
| `models/weapons/v_shotg2/skin.pcx` | 296x194 | `pcx:65a6fbc2e70b` | `metal` | refreshed in node | a flat UV skin sheet for a bulky double-barrelled super shotgun: heavy scratched steel, twin barrels, rivets and a wooden stock, Quake 2 1997 first-person-shooter asset, weathered sci-fi metal and grime, flat studio lighting, centred subject, no text, no watermark, no logo |
| `models/monsters/berserk/skin.pcx` | 244x194 | `pcx:8bc2b5bf2858` | `organic` | refreshed in node | a flat UV skin sheet for a hulking Strogg berserker: scarred mottled hide, armour plating, blade arms and rusted studs, Quake 2 1997 first-person-shooter asset, weathered sci-fi metal and grime, flat studio lighting, centred subject, no text, no watermark, no logo |
| `models/monsters/berserk/pain.pcx` | 244x194 | `pcx:8bc2b5bf2858` | `organic` | refreshed in node | a flat UV skin sheet for a hulking Strogg berserker: scarred mottled hide, armour plating, blade arms and rusted studs, Quake 2 1997 first-person-shooter asset, weathered sci-fi metal and grime, flat studio lighting, centred subject, no text, no watermark, no logo |
| `models/monsters/gunner/skin.pcx` | 292x195 | `pcx:788ff81a8f08` | `organic` | refreshed in node | a flat UV skin sheet for a heavy Strogg gunner: thick riveted armour plating, a machine-gun arm, scars and grime, Quake 2 1997 first-person-shooter asset, weathered sci-fi metal and grime, flat studio lighting, centred subject, no text, no watermark, no logo |
| `models/monsters/gunner/pain.pcx` | 292x195 | `pcx:a13dc155ee7a` | `organic` | refreshed in node | a flat UV skin sheet for a heavy Strogg gunner: thick riveted armour plating, a machine-gun arm, scars and grime, Quake 2 1997 first-person-shooter asset, weathered sci-fi metal and grime, flat studio lighting, centred subject, no text, no watermark, no logo |
| `models/monsters/infantry/skin.pcx` | 276x194 | `pcx:a13dc155ee7a` | `organic` | refreshed in node | a flat UV skin sheet for a scrawny Strogg infantry soldier: worn body armour over mottled hide, straps and grime, Quake 2 1997 first-person-shooter asset, weathered sci-fi metal and grime, flat studio lighting, centred subject, no text, no watermark, no logo |
| `models/monsters/infantry/pain.pcx` | 276x194 | `pcx:a13dc155ee7a` | `organic` | refreshed in node | a flat UV skin sheet for a scrawny Strogg infantry soldier: worn body armour over mottled hide, straps and grime, Quake 2 1997 first-person-shooter asset, weathered sci-fi metal and grime, flat studio lighting, centred subject, no text, no watermark, no logo |
| `models/monsters/parasite/skin.pcx` | 284x195 | `pcx:788ff81a8f08` | `organic` | refreshed in node | a flat UV skin sheet for a Strogg parasite: lean mottled alien hide with bony chitin plates and slick wet texture, Quake 2 1997 first-person-shooter asset, weathered sci-fi metal and grime, flat studio lighting, centred subject, no text, no watermark, no logo |
| `models/monsters/parasite/pain.pcx` | 284x195 | `pcx:788ff81a8f08` | `organic` | refreshed in node | a flat UV skin sheet for a Strogg parasite: lean mottled alien hide with bony chitin plates and slick wet texture, Quake 2 1997 first-person-shooter asset, weathered sci-fi metal and grime, flat studio lighting, centred subject, no text, no watermark, no logo |
| `models/monsters/soldier/skin_lt.pcx` | 288x195 | `pcx:8bc2b5bf2858` | `organic` | refreshed in node | a flat UV skin sheet for a lightly armoured Strogg trooper: pale mottled hide with thin armour plates and straps, Quake 2 1997 first-person-shooter asset, weathered sci-fi metal and grime, flat studio lighting, centred subject, no text, no watermark, no logo |
| `models/monsters/soldier/skin_ltp.pcx` | 288x195 | `pcx:8bc2b5bf2858` | `organic` | refreshed in node | a flat UV skin sheet for a Strogg cyborg marine trooper: riveted armour plating over mottled grey hide, worn panel seams, Quake 2 1997 first-person-shooter asset, weathered sci-fi metal and grime, flat studio lighting, centred subject, no text, no watermark, no logo |
| `models/monsters/soldier/skin.pcx` | 288x195 | `pcx:65a6fbc2e70b` | `organic` | refreshed in node | a flat UV skin sheet for a Strogg cyborg marine trooper: riveted armour plating over mottled grey hide, worn panel seams, Quake 2 1997 first-person-shooter asset, weathered sci-fi metal and grime, flat studio lighting, centred subject, no text, no watermark, no logo |
| `models/monsters/soldier/pain.pcx` | 288x195 | `pcx:65a6fbc2e70b` | `organic` | refreshed in node | a flat UV skin sheet for a Strogg cyborg marine trooper: riveted armour plating over mottled grey hide, worn panel seams, Quake 2 1997 first-person-shooter asset, weathered sci-fi metal and grime, flat studio lighting, centred subject, no text, no watermark, no logo |
| `models/monsters/soldier/skin_ss.pcx` | 288x195 | `pcx:8bc2b5bf2858` | `organic` | refreshed in node | a flat UV skin sheet for a black-armoured Strogg special-forces trooper: dark plating, mottled hide and studded rivets, Quake 2 1997 first-person-shooter asset, weathered sci-fi metal and grime, flat studio lighting, centred subject, no text, no watermark, no logo |
| `models/monsters/soldier/skin_ssp.pcx` | 288x195 | `pcx:8bc2b5bf2858` | `organic` | refreshed in node | a flat UV skin sheet for a Strogg cyborg marine trooper: riveted armour plating over mottled grey hide, worn panel seams, Quake 2 1997 first-person-shooter asset, weathered sci-fi metal and grime, flat studio lighting, centred subject, no text, no watermark, no logo |
| `models/monsters/tank/skin.pcx` | 308x194 | `pcx:788ff81a8f08` | `organic` | refreshed in node | a flat UV skin sheet for a Strogg tank walker mech: thick riveted armour plating, hydraulic hoses, scorch marks and grime, Quake 2 1997 first-person-shooter asset, weathered sci-fi metal and grime, flat studio lighting, centred subject, no text, no watermark, no logo |
| `models/monsters/tank/pain.pcx` | 308x194 | `pcx:788ff81a8f08` | `organic` | refreshed in node | a flat UV skin sheet for a Strogg tank walker mech: thick riveted armour plating, hydraulic hoses, scorch marks and grime, Quake 2 1997 first-person-shooter asset, weathered sci-fi metal and grime, flat studio lighting, centred subject, no text, no watermark, no logo |
| `models/monsters/flyer/skin.pcx` | 312x183 | `pcx:38cdb21b71f6` | `organic` | refreshed in node | a flat UV skin sheet for a Strogg flying drone: armoured plating over hide, rotor wing panels and rivets, Quake 2 1997 first-person-shooter asset, weathered sci-fi metal and grime, flat studio lighting, centred subject, no text, no watermark, no logo |
| `models/monsters/flyer/pain.pcx` | 312x183 | `pcx:65a6fbc2e70b` | `organic` | refreshed in node | a flat UV skin sheet for a Strogg flying drone: armoured plating over hide, rotor wing panels and rivets, Quake 2 1997 first-person-shooter asset, weathered sci-fi metal and grime, flat studio lighting, centred subject, no text, no watermark, no logo |
| `models/weapons/g_bfg/skin.pcx` | 308x165 | `pcx:65a6fbc2e70b` | `metal` | refreshed in node | a flat UV skin sheet for a heavy energy cannon pick-up: scratched plating with a green-glowing core, Quake 2 1997 first-person-shooter asset, weathered sci-fi metal and grime, flat studio lighting, centred subject, no text, no watermark, no logo |
| `models/weapons/g_blast/base.pcx` | 312x183 | `pcx:65a6fbc2e70b` | `metal` | refreshed in node | a flat UV skin sheet for a plasma blaster pick-up: scorched gunmetal with a glowing chamber, Quake 2 1997 first-person-shooter asset, weathered sci-fi metal and grime, flat studio lighting, centred subject, no text, no watermark, no logo |
| `models/weapons/g_chain/skin.pcx` | 308x168 | `pcx:65a6fbc2e70b` | `metal` | refreshed in node | a flat UV skin sheet for a rotary chain gun pick-up: scratched steel, a barrel cluster, feed belt and armour plates, Quake 2 1997 first-person-shooter asset, weathered sci-fi metal and grime, flat studio lighting, centred subject, no text, no watermark, no logo |
| `models/weapons/g_disint/skin.pcx` | 308x165 | `pcx:65a6fbc2e70b` | `metal` | refreshed in node | a flat UV skin sheet for an energy rifle pick-up: scratched steel with a glowing emitter, Quake 2 1997 first-person-shooter asset, weathered sci-fi metal and grime, flat studio lighting, centred subject, no text, no watermark, no logo |
| `models/weapons/g_flareg/base.pcx` | 304x194 | `pcx:65a6fbc2e70b` | `metal` | refreshed in node | a flat UV skin sheet for a flare gun pick-up: scratched gunmetal and an orange warning band, Quake 2 1997 first-person-shooter asset, weathered sci-fi metal and grime, flat studio lighting, centred subject, no text, no watermark, no logo |
| `models/weapons/g_hyperb/skin.pcx` | 292x194 | `pcx:65a6fbc2e70b` | `metal` | refreshed in node | a flat UV skin sheet for a hyperblaster pick-up: scratched steel with glowing blue capacitor cells, Quake 2 1997 first-person-shooter asset, weathered sci-fi metal and grime, flat studio lighting, centred subject, no text, no watermark, no logo |
| `models/weapons/g_launch/skin.pcx` | 308x176 | `pcx:65a6fbc2e70b` | `metal` | refreshed in node | a flat UV skin sheet for a grenade launcher pick-up: chunky scratched gunmetal, a revolving cylinder and rivets, Quake 2 1997 first-person-shooter asset, weathered sci-fi metal and grime, flat studio lighting, centred subject, no text, no watermark, no logo |
| `models/weapons/g_machn/skin.pcx` | 312x106 | `pcx:65a6fbc2e70b` | `metal` | refreshed in node | a flat UV skin sheet for a machine gun pick-up: gunmetal with scratches, a box magazine, cooling vents and rivets, Quake 2 1997 first-person-shooter asset, weathered sci-fi metal and grime, flat studio lighting, centred subject, no text, no watermark, no logo |
| `models/weapons/g_rail/skin.pcx` | 292x194 | `pcx:65a6fbc2e70b` | `metal` | refreshed in node | a flat UV skin sheet for a railgun pick-up: gunmetal with scratches, coil windings and glowing rails, Quake 2 1997 first-person-shooter asset, weathered sci-fi metal and grime, flat studio lighting, centred subject, no text, no watermark, no logo |
| `models/weapons/g_rocket/skin.pcx` | 284x194 | `pcx:65a6fbc2e70b` | `metal` | refreshed in node | a flat UV skin sheet for a rocket launcher pick-up: scarred olive-drab tube, warning stripes and rivets, Quake 2 1997 first-person-shooter asset, weathered sci-fi metal and grime, flat studio lighting, centred subject, no text, no watermark, no logo |
| `models/weapons/g_shotg/skin.pcx` | 184x132 | `pcx:65a6fbc2e70b` | `metal` | refreshed in node | a flat UV skin sheet for a shotgun pick-up: blued steel with scratches, a wooden stock, seams and shell ports, Quake 2 1997 first-person-shooter asset, weathered sci-fi metal and grime, flat studio lighting, centred subject, no text, no watermark, no logo |
| `models/weapons/g_shotg2/skin.pcx` | 308x169 | `pcx:788ff81a8f08` | `metal` | refreshed in node | a flat UV skin sheet for a super shotgun pick-up: heavy scratched steel, twin barrels, rivets and a wooden stock, Quake 2 1997 first-person-shooter asset, weathered sci-fi metal and grime, flat studio lighting, centred subject, no text, no watermark, no logo |
| `models/items/armor/body/skin.pcx` | 308x154 | `pcx:8bc2b5bf2858` | `metal` | refreshed in node | a flat UV skin sheet for a heavy body-armour vest: thick riveted steel plates and quilted padding, Quake 2 1997 first-person-shooter asset, weathered sci-fi metal and grime, flat studio lighting, centred subject, no text, no watermark, no logo |
| `models/items/armor/combat/skin.pcx` | 312x120 | `pcx:8bc2b5bf2858` | `metal` | refreshed in node | a flat UV skin sheet for a combat armour cuirass: riveted steel plates, worn seams and a glowing power stud, Quake 2 1997 first-person-shooter asset, weathered sci-fi metal and grime, flat studio lighting, centred subject, no text, no watermark, no logo |
| `models/items/armor/jacket/skin.pcx` | 308x127 | `pcx:65a6fbc2e70b` | `metal` | refreshed in node | a flat UV skin sheet for a flak jacket: quilted kevlar panels, straps, buckles and grime, Quake 2 1997 first-person-shooter asset, weathered sci-fi metal and grime, flat studio lighting, centred subject, no text, no watermark, no logo |
| `models/items/armor/shard/skin.pcx` | 120x76 | `pcx:788ff81a8f08` | `metal` | refreshed in node | a flat UV skin sheet for a small armour shard: glowing blue crystal in a scratched metal mount, Quake 2 1997 first-person-shooter asset, weathered sci-fi metal and grime, flat studio lighting, centred subject, no text, no watermark, no logo |
| `models/items/armor/screen/skin.pcx` | 264x124 | `pcx:788ff81a8f08` | `metal` | refreshed in node | a flat UV skin sheet for a powered energy-screen generator: metal casing, glowing coils and a control panel, Quake 2 1997 first-person-shooter asset, weathered sci-fi metal and grime, flat studio lighting, centred subject, no text, no watermark, no logo |
| `models/items/armor/shield/skin.pcx` | 232x124 | `pcx:788ff81a8f08` | `metal` | refreshed in node | a flat UV skin sheet for a powered combat shield unit: riveted metal casing, a glowing energy cell and warning stripes, Quake 2 1997 first-person-shooter asset, weathered sci-fi metal and grime, flat studio lighting, centred subject, no text, no watermark, no logo |
| `models/items/armor/effect/skin.pcx` | 104x68 | `pcx:8bc2b5bf2858` | `energy` | refreshed in node | a flat UV skin sheet for an energy armour field: a shimmering shimmer of glowing energy over faint plates, Quake 2 1997 first-person-shooter asset, weathered sci-fi metal and grime, flat studio lighting, centred subject, no text, no watermark, no logo |
| `models/items/healing/medium/skin.pcx` | 184x84 | `pcx:788ff81a8f08` | `metal` | refreshed in node | a flat UV skin sheet for a medic kit box: white metal casing, a red cross, worn corners and a glowing health readout, Quake 2 1997 first-person-shooter asset, weathered sci-fi metal and grime, flat studio lighting, centred subject, no text, no watermark, no logo |
| `models/items/healing/stimpack/skin.pcx` | 152x92 | `pcx:788ff81a8f08` | `metal` | refreshed in node | a flat UV skin sheet for a stimpak syringe of green nanite medicine: metal casing, glowing green health stripes and a gauge, Quake 2 1997 first-person-shooter asset, weathered sci-fi metal and grime, flat studio lighting, centred subject, no text, no watermark, no logo |
| `models/items/healing/large/skin.pcx` | 200x100 | `pcx:788ff81a8f08` | `metal` | refreshed in node | a flat UV skin sheet for a large trauma kit case: battered metal, a red cross and glowing green health indicators, Quake 2 1997 first-person-shooter asset, weathered sci-fi metal and grime, flat studio lighting, centred subject, no text, no watermark, no logo |
| `models/items/mega_h/skin.pcx` | 232x132 | `pcx:788ff81a8f08` | `metal` | refreshed in node | a flat UV skin sheet for a mega-health canister: purple metal casing with glowing bio-hazard stripes and a gauge, Quake 2 1997 first-person-shooter asset, weathered sci-fi metal and grime, flat studio lighting, centred subject, no text, no watermark, no logo |
| `models/items/quaddama/skin.pcx` | 168x148 | `pcx:3f6daf29a67d` | `metal` | refreshed in node | a flat UV skin sheet for a quad-damage power-up idol: dark corroded metal with carved runes and red glowing eyes, Quake 2 1997 first-person-shooter asset, weathered sci-fi metal and grime, flat studio lighting, centred subject, no text, no watermark, no logo |
| `models/items/invulner/skin.pcx` | 312x80 | `pcx:3f6daf29a67d` | `metal` | refreshed in node | a flat UV skin sheet for an invulnerability power-up: a scratched metal ring around a glowing shimmering core, Quake 2 1997 first-person-shooter asset, weathered sci-fi metal and grime, flat studio lighting, centred subject, no text, no watermark, no logo |
| `models/items/silencer/skin.pcx` | 184x52 | `pcx:65a6fbc2e70b` | `metal` | refreshed in node | a flat UV skin sheet for a barrel suppressor: matte black metal with fine scratches and a heat shield, Quake 2 1997 first-person-shooter asset, weathered sci-fi metal and grime, flat studio lighting, centred subject, no text, no watermark, no logo |
| `models/items/breather/skin.pcx` | 200x76 | `pcx:65a6fbc2e70b` | `metal` | refreshed in node | a flat UV skin sheet for a rebreather oxygen mask: rubber straps, metal tanks, a glass visor and gauges, Quake 2 1997 first-person-shooter asset, weathered sci-fi metal and grime, flat studio lighting, centred subject, no text, no watermark, no logo |
| `models/items/enviro/skin.pcx` | 308x116 | `pcx:65a6fbc2e70b` | `metal` | refreshed in node | a flat UV skin sheet for a sealed environmental space suit: armoured fabric, metal joints, hoses and a visored helmet, Quake 2 1997 first-person-shooter asset, weathered sci-fi metal and grime, flat studio lighting, centred subject, no text, no watermark, no logo |
| `models/items/band/skin.pcx` | 216x100 | `pcx:65a6fbc2e70b` | `metal` | refreshed in node | a flat UV skin sheet for a power band bracer: armoured metal with a glowing power cell and straps, Quake 2 1997 first-person-shooter asset, weathered sci-fi metal and grime, flat studio lighting, centred subject, no text, no watermark, no logo |
| `models/items/pack/skin.pcx` | 200x132 | `pcx:3f6daf29a67d` | `metal` | refreshed in node | a flat UV skin sheet for an ammunition backpack: canvas and metal with belts of rounds and a battered lid, Quake 2 1997 first-person-shooter asset, weathered sci-fi metal and grime, flat studio lighting, centred subject, no text, no watermark, no logo |
| `models/items/adrenal/skin.pcx` | 216x124 | `pcx:788ff81a8f08` | `metal` | refreshed in node | a flat UV skin sheet for an adrenaline injector: metal canister with glowing red fluid and warning stripes, Quake 2 1997 first-person-shooter asset, weathered sci-fi metal and grime, flat studio lighting, centred subject, no text, no watermark, no logo |
| `models/items/ammo/bullets/medium/skin.pcx` | 136x60 | `pcx:65a6fbc2e70b` | `metal` | refreshed in node | a flat UV skin sheet for a box of bullet rounds: cardboard carton with loose brass cartridges and stencilled markings, Quake 2 1997 first-person-shooter asset, weathered sci-fi metal and grime, flat studio lighting, centred subject, no text, no watermark, no logo |
| `models/items/ammo/cells/medium/skin.pcx` | 104x100 | `pcx:65a6fbc2e70b` | `metal` | refreshed in node | a flat UV skin sheet for a crate of energy cells: metal casing with glowing blue cells and vents, Quake 2 1997 first-person-shooter asset, weathered sci-fi metal and grime, flat studio lighting, centred subject, no text, no watermark, no logo |
| `models/items/ammo/grenades/medium/skin.pcx` | 168x84 | `pcx:788ff81a8f08` | `metal` | refreshed in node | a flat UV skin sheet for a bandolier of fragmentation grenades: green segmented shells, pins and a canvas strap, Quake 2 1997 first-person-shooter asset, weathered sci-fi metal and grime, flat studio lighting, centred subject, no text, no watermark, no logo |
| `models/items/ammo/mines/skin.pcx` | 216x92 | `pcx:65a6fbc2e70b` | `metal` | refreshed in node | a weathered sci-fi ammo mines item, Quake 2 1997 first-person-shooter asset, weathered sci-fi metal and grime, flat studio lighting, centred subject, no text, no watermark, no logo |
| `models/items/ammo/nuke/skin.pcx` | 232x156 | `pcx:788ff81a8f08` | `metal` | refreshed in node | a weathered sci-fi ammo nuke item, Quake 2 1997 first-person-shooter asset, weathered sci-fi metal and grime, flat studio lighting, centred subject, no text, no watermark, no logo |
| `models/items/ammo/rockets/medium/skin.pcx` | 168x148 | `pcx:65a6fbc2e70b` | `metal` | refreshed in node | a flat UV skin sheet for a rack of rockets: olive metal tubes with red warheads and fins, Quake 2 1997 first-person-shooter asset, weathered sci-fi metal and grime, flat studio lighting, centred subject, no text, no watermark, no logo |
| `models/items/ammo/shells/medium/skin.pcx` | 200x60 | `pcx:788ff81a8f08` | `metal` | refreshed in node | a flat UV skin sheet for an open box of shotgun shells: red plastic shells with brass bases, Quake 2 1997 first-person-shooter asset, weathered sci-fi metal and grime, flat studio lighting, centred subject, no text, no watermark, no logo |
| `models/items/ammo/slugs/medium/skin.pcx` | 168x76 | `pcx:65a6fbc2e70b` | `metal` | refreshed in node | a flat UV skin sheet for a box of railgun slugs: steel darts in a metal tray with stencilled markings, Quake 2 1997 first-person-shooter asset, weathered sci-fi metal and grime, flat studio lighting, centred subject, no text, no watermark, no logo |
| `models/items/c_head/skin.pcx` | 168x132 | `pcx:3f6daf29a67d` | `metal` | refreshed in node | a flat UV skin sheet for a severed commander's head: mottled skin, a metal implant plate and blood, Quake 2 1997 first-person-shooter asset, weathered sci-fi metal and grime, flat studio lighting, centred subject, no text, no watermark, no logo |
| `models/items/keys/target/skin.pcx` | 192x194 | `pcx:3f6daf29a67d` | `metal` | refreshed in node | a flat UV skin sheet for a target key card: metal plate with a painted bullseye marking and worn edges, Quake 2 1997 first-person-shooter asset, weathered sci-fi metal and grime, flat studio lighting, centred subject, no text, no watermark, no logo |
| `models/items/keys/data_cd/skin.pcx` | 200x100 | `pcx:8bc2b5bf2858` | `metal` | refreshed in node | a flat UV skin sheet for a data CD-ROM in a metal case: iridescent disc surface and stencilled markings, Quake 2 1997 first-person-shooter asset, weathered sci-fi metal and grime, flat studio lighting, centred subject, no text, no watermark, no logo |
| `models/items/keys/power/skin.pcx` | 184x116 | `pcx:8bc2b5bf2858` | `metal` | refreshed in node | a flat UV skin sheet for a power cube: metal casing around a glowing energy core with warning stripes, Quake 2 1997 first-person-shooter asset, weathered sci-fi metal and grime, flat studio lighting, centred subject, no text, no watermark, no logo |
| `models/items/keys/pyramid/skin.pcx` | 152x92 | `pcx:65a6fbc2e70b` | `metal` | refreshed in node | a flat UV skin sheet for a pyramid-shaped alien artefact: dark etched metal with glowing engraved lines, Quake 2 1997 first-person-shooter asset, weathered sci-fi metal and grime, flat studio lighting, centred subject, no text, no watermark, no logo |
| `models/items/keys/spinner/skin.pcx` | 176x195 | `pcx:8bc2b5bf2858` | `metal` | refreshed in node | a flat UV skin sheet for a spinner key: two-bladed metal rotor with rivets and worn edges, Quake 2 1997 first-person-shooter asset, weathered sci-fi metal and grime, flat studio lighting, centred subject, no text, no watermark, no logo |
| `models/items/keys/pass/skin.pcx` | 168x124 | `pcx:8bc2b5bf2858` | `metal` | refreshed in node | a flat UV skin sheet for a magnetic key card pass: plastic card with a data stripe and stencilled markings, Quake 2 1997 first-person-shooter asset, weathered sci-fi metal and grime, flat studio lighting, centred subject, no text, no watermark, no logo |
| `models/items/keys/key/skin.pcx` | 200x132 | `pcx:65a6fbc2e70b` | `metal` | refreshed in node | a flat UV skin sheet for a small brass security key: worn metal with notched teeth and a stamped tag, Quake 2 1997 first-person-shooter asset, weathered sci-fi metal and grime, flat studio lighting, centred subject, no text, no watermark, no logo |
| `models/items/keys/red_key/red_skin.pcx` | 200x132 | `pcx:3f6daf29a67d` | `metal` | refreshed in node | a flat UV skin sheet for a red data key: a key card in a scratched red metal housing with glowing contacts, Quake 2 1997 first-person-shooter asset, weathered sci-fi metal and grime, flat studio lighting, centred subject, no text, no watermark, no logo |
| `models/objects/laser/skin.pcx` | 88x124 | `pcx:65a6fbc2e70b` | `energy` | refreshed in node | a flat UV skin sheet for a glowing energy bolt: hot red-white plasma with a bright core, Quake 2 1997 first-person-shooter asset, weathered sci-fi metal and grime, flat studio lighting, centred subject, no text, no watermark, no logo |
| `models/objects/rocket/skin.pcx` | 288x195 | `pcx:65a6fbc2e70b` | `metal` | refreshed in node | a flat UV skin sheet for a rocket: olive casing, a red warhead, fins and exhaust nozzle, Quake 2 1997 first-person-shooter asset, weathered sci-fi metal and grime, flat studio lighting, centred subject, no text, no watermark, no logo |
| `models/objects/bomb/skin.pcx` | 288x195 | `pcx:65a6fbc2e70b` | `metal` | refreshed in node | a flat UV skin sheet for a heavy bomb: dark metal casing with a nose fuse and stencilled markings, Quake 2 1997 first-person-shooter asset, weathered sci-fi metal and grime, flat studio lighting, centred subject, no text, no watermark, no logo |
| `models/objects/grenade/skin.pcx` | 40x44 | `pcx:65a6fbc2e70b` | `metal` | refreshed in node | a flat UV skin sheet for a small grenade: green segmented shell with a pin and lever, Quake 2 1997 first-person-shooter asset, weathered sci-fi metal and grime, flat studio lighting, centred subject, no text, no watermark, no logo |
| `models/objects/grenade2/skin.pcx` | 72x68 | `pcx:65a6fbc2e70b` | `metal` | refreshed in node | a flat UV skin sheet for a primed grenade: green segmented shell with a pin, lever and a glowing fuse, Quake 2 1997 first-person-shooter asset, weathered sci-fi metal and grime, flat studio lighting, centred subject, no text, no watermark, no logo |
| `models/objects/flash/skin.pcx` | 168x84 | `pcx:3f6daf29a67d` | `energy` | refreshed in node | a flat UV skin sheet for a muzzle flash: hot white and orange expanding gas with soft edges, Quake 2 1997 first-person-shooter asset, weathered sci-fi metal and grime, flat studio lighting, centred subject, no text, no watermark, no logo |
| `models/objects/smoke/skin.pcx` | 168x76 | `pcx:a13dc155ee7a` | `energy` | refreshed in node | a flat UV skin sheet for a puff of smoke: soft grey billows, Quake 2 1997 first-person-shooter asset, weathered sci-fi metal and grime, flat studio lighting, centred subject, no text, no watermark, no logo |
| `models/objects/explode/skin.pcx` | 136x52 | `pcx:65a6fbc2e70b` | `energy` | refreshed in node | a flat UV skin sheet for a burst of explosion fire: orange flame and black smoke, Quake 2 1997 first-person-shooter asset, weathered sci-fi metal and grime, flat studio lighting, centred subject, no text, no watermark, no logo |
| `models/objects/r_explode/skin1.pcx` | 184x76 | `pcx:3f6daf29a67d` | `energy` | refreshed in node | a flat UV skin sheet for a rocket explosion fireball: orange flame, black soot and glowing embers, Quake 2 1997 first-person-shooter asset, weathered sci-fi metal and grime, flat studio lighting, centred subject, no text, no watermark, no logo |
| `models/objects/r_explode/skin2.pcx` | 184x76 | `pcx:3f6daf29a67d` | `energy` | refreshed in node | a flat UV skin sheet for a rocket explosion fireball: orange flame, black soot and glowing embers, Quake 2 1997 first-person-shooter asset, weathered sci-fi metal and grime, flat studio lighting, centred subject, no text, no watermark, no logo |
| `models/objects/r_explode/skin3.pcx` | 184x76 | `pcx:3f6daf29a67d` | `energy` | refreshed in node | a flat UV skin sheet for a rocket explosion fireball: orange flame, black soot and glowing embers, Quake 2 1997 first-person-shooter asset, weathered sci-fi metal and grime, flat studio lighting, centred subject, no text, no watermark, no logo |
| `models/objects/r_explode/skin4.pcx` | 184x76 | `pcx:3f6daf29a67d` | `energy` | refreshed in node | a flat UV skin sheet for a rocket explosion fireball: orange flame, black soot and glowing embers, Quake 2 1997 first-person-shooter asset, weathered sci-fi metal and grime, flat studio lighting, centred subject, no text, no watermark, no logo |
| `models/objects/r_explode/skin5.pcx` | 184x76 | `pcx:3f6daf29a67d` | `energy` | refreshed in node | a flat UV skin sheet for a rocket explosion fireball: orange flame, black soot and glowing embers, Quake 2 1997 first-person-shooter asset, weathered sci-fi metal and grime, flat studio lighting, centred subject, no text, no watermark, no logo |
| `models/objects/r_explode/skin6.pcx` | 184x76 | `pcx:3f6daf29a67d` | `energy` | refreshed in node | a flat UV skin sheet for a rocket explosion fireball: orange flame, black soot and glowing embers, Quake 2 1997 first-person-shooter asset, weathered sci-fi metal and grime, flat studio lighting, centred subject, no text, no watermark, no logo |
| `models/objects/r_explode/skin7.pcx` | 184x76 | `pcx:3f6daf29a67d` | `energy` | refreshed in node | a flat UV skin sheet for a rocket explosion fireball: orange flame, black soot and glowing embers, Quake 2 1997 first-person-shooter asset, weathered sci-fi metal and grime, flat studio lighting, centred subject, no text, no watermark, no logo |
| `models/objects/barrels/skin.pcx` | 276x194 | `pcx:a13dc155ee7a` | `metal` | refreshed in node | a flat UV skin sheet for a battered steel explosive barrel: rust, dents, hazard stripes and a stencilled marking, Quake 2 1997 first-person-shooter asset, weathered sci-fi metal and grime, flat studio lighting, centred subject, no text, no watermark, no logo |
| `models/objects/minelite/light1/base.pcx` | 120x100 | `pcx:a13dc155ee7a` | `metal` | refreshed in node | a flat UV skin sheet for a glowing overhead hazard lamp: riveted metal base and a glowing red lens, Quake 2 1997 first-person-shooter asset, weathered sci-fi metal and grime, flat studio lighting, centred subject, no text, no watermark, no logo |
| `models/objects/minelite/light2/base.pcx` | 120x84 | `pcx:a13dc155ee7a` | `metal` | refreshed in node | a flat UV skin sheet for an industrial indicator lamp: riveted metal base and a glowing amber lens, Quake 2 1997 first-person-shooter asset, weathered sci-fi metal and grime, flat studio lighting, centred subject, no text, no watermark, no logo |
| `models/objects/debris1/skin.pcx` | 104x60 | `pcx:65a6fbc2e70b` | `metal` | refreshed in node | a flat UV skin sheet for a chunk of torn metal debris: scratched grey steel and ripped edges, Quake 2 1997 first-person-shooter asset, weathered sci-fi metal and grime, flat studio lighting, centred subject, no text, no watermark, no logo |
| `models/objects/debris2/skin.pcx` | 72x28 | `pcx:65a6fbc2e70b` | `metal` | refreshed in node | a flat UV skin sheet for a chunk of rubble: shattered brown brick and grey concrete, Quake 2 1997 first-person-shooter asset, weathered sci-fi metal and grime, flat studio lighting, centred subject, no text, no watermark, no logo |
| `models/objects/debris3/skin.pcx` | 136x60 | `pcx:65a6fbc2e70b` | `metal` | refreshed in node | a flat UV skin sheet for smashed crate debris: splintered wood planks and rusty nails, Quake 2 1997 first-person-shooter asset, weathered sci-fi metal and grime, flat studio lighting, centred subject, no text, no watermark, no logo |
| `models/objects/dmspot/skin.pcx` | 232x132 | `pcx:3f6daf29a67d` | `metal` | refreshed in node | a flat UV skin sheet for an arena spawn pad: armoured metal plate with a painted emblem and worn paint, Quake 2 1997 first-person-shooter asset, weathered sci-fi metal and grime, flat studio lighting, centred subject, no text, no watermark, no logo |
| `models/objects/dmspot/skin2.pcx` | 232x132 | `pcx:3f6daf29a67d` | `metal` | refreshed in node | a flat UV skin sheet for a second arena spawn pad: darker metal plate with a painted emblem and worn paint, Quake 2 1997 first-person-shooter asset, weathered sci-fi metal and grime, flat studio lighting, centred subject, no text, no watermark, no logo |
| `models/objects/banner/skin.pcx` | 260x195 | `pcx:788ff81a8f08` | `fabric` | refreshed in node | a flat UV skin sheet for a torn hanging banner: faded fabric with a crude painted emblem and frayed edges, Quake 2 1997 first-person-shooter asset, weathered sci-fi metal and grime, flat studio lighting, centred subject, no text, no watermark, no logo |
| `models/objects/satellite/skin.pcx` | 312x177 | `pcx:788ff81a8f08` | `metal` | refreshed in node | a flat UV skin sheet for a communications satellite: metal casing, blue solar panels, a dish and rivets, Quake 2 1997 first-person-shooter asset, weathered sci-fi metal and grime, flat studio lighting, centred subject, no text, no watermark, no logo |
| `models/objects/black/skin.pcx` | 308x147 | `pcx:3f6daf29a67d` | `flat` | refreshed in node | a flat UV skin sheet that is flat black, unlit void, Quake 2 1997 first-person-shooter asset, weathered sci-fi metal and grime, flat studio lighting, centred subject, no text, no watermark, no logo |
| `models/objects/gibs/arm/skin.pcx` | 120x92 | `pcx:788ff81a8f08` | `organic` | refreshed in node | a flat UV skin sheet for a severed arm: torn cloth, mottled skin and blood, Quake 2 1997 first-person-shooter asset, weathered sci-fi metal and grime, flat studio lighting, centred subject, no text, no watermark, no logo |
| `models/objects/gibs/bone/skin.pcx` | 200x44 | `pcx:a13dc155ee7a` | `organic` | refreshed in node | a flat UV skin sheet for a bare gnawed bone: pale weathered bone texture, Quake 2 1997 first-person-shooter asset, weathered sci-fi metal and grime, flat studio lighting, centred subject, no text, no watermark, no logo |
| `models/objects/gibs/bone2/skin.pcx` | 136x44 | `pcx:65a6fbc2e70b` | `organic` | refreshed in node | a flat UV skin sheet for a broken rib bone: pale weathered bone and gristle, Quake 2 1997 first-person-shooter asset, weathered sci-fi metal and grime, flat studio lighting, centred subject, no text, no watermark, no logo |
| `models/objects/gibs/chest/skin.pcx` | 264x124 | `pcx:788ff81a8f08` | `organic` | refreshed in node | a flat UV skin sheet for a severed torso: torn cloth, mottled skin and blood, Quake 2 1997 first-person-shooter asset, weathered sci-fi metal and grime, flat studio lighting, centred subject, no text, no watermark, no logo |
| `models/objects/gibs/gear/skin.pcx` | 104x52 | `pcx:65a6fbc2e70b` | `organic` | refreshed in node | a flat UV skin sheet for torn machinery: gears, cables and a torn metal casing, Quake 2 1997 first-person-shooter asset, weathered sci-fi metal and grime, flat studio lighting, centred subject, no text, no watermark, no logo |
| `models/objects/gibs/head/skin.pcx` | 136x100 | `pcx:788ff81a8f08` | `organic` | refreshed in node | a flat UV skin sheet for a severed head: mottled skin, hair and blood, Quake 2 1997 first-person-shooter asset, weathered sci-fi metal and grime, flat studio lighting, centred subject, no text, no watermark, no logo |
| `models/objects/gibs/head2/skin.pcx` | 136x100 | `pcx:788ff81a8f08` | `organic` | refreshed in node | a flat UV skin sheet for a mangled severed head: torn skin, bone and blood, Quake 2 1997 first-person-shooter asset, weathered sci-fi metal and grime, flat studio lighting, centred subject, no text, no watermark, no logo |
| `models/objects/gibs/head2/player.pcx` | 136x100 | `pcx:788ff81a8f08` | `organic` | refreshed in node | a flat UV skin sheet for a mangled severed head: torn skin, bone and blood, Quake 2 1997 first-person-shooter asset, weathered sci-fi metal and grime, flat studio lighting, centred subject, no text, no watermark, no logo |
| `models/objects/gibs/leg/skin.pcx` | 136x140 | `pcx:788ff81a8f08` | `organic` | refreshed in node | a flat UV skin sheet for a severed leg: torn cloth, a boot and mottled skin, Quake 2 1997 first-person-shooter asset, weathered sci-fi metal and grime, flat studio lighting, centred subject, no text, no watermark, no logo |
| `models/objects/gibs/skull/skin.pcx` | 152x100 | `pcx:3f6daf29a67d` | `organic` | refreshed in node | a flat UV skin sheet for a bare human skull: pale weathered bone with dark eye sockets, Quake 2 1997 first-person-shooter asset, weathered sci-fi metal and grime, flat studio lighting, centred subject, no text, no watermark, no logo |
| `models/objects/gibs/sm_meat/skin.pcx` | 56x20 | `pcx:65a6fbc2e70b` | `organic` | refreshed in node | a flat UV skin sheet for a scrap of raw meat: red flesh and gristle, Quake 2 1997 first-person-shooter asset, weathered sci-fi metal and grime, flat studio lighting, centred subject, no text, no watermark, no logo |
| `models/objects/gibs/sm_metal/skin.pcx` | 104x28 | `pcx:65a6fbc2e70b` | `organic` | refreshed in node | a flat UV skin sheet for a scrap of torn metal plate: scratched steel and a ripped edge, Quake 2 1997 first-person-shooter asset, weathered sci-fi metal and grime, flat studio lighting, centred subject, no text, no watermark, no logo |
| `models/deadbods/dude/dead1.pcx` | 288x195 | `pcx:f1244ddc5f49` | `organic` | refreshed in node | a flat UV skin sheet for the body of a dead soldier: torn camouflage fatigues over mottled skin, a helmet and blood stains, Quake 2 1997 first-person-shooter asset, weathered sci-fi metal and grime, flat studio lighting, centred subject, no text, no watermark, no logo |
| `models/ships/viper/skin.pcx` | 304x195 | `pcx:f1244ddc5f49` | `metal` | refreshed in node | a flat UV skin sheet for a sleek angular fighter craft: riveted armour plating, a canopy and engine nozzles, Quake 2 1997 first-person-shooter asset, weathered sci-fi metal and grime, flat studio lighting, centred subject, no text, no watermark, no logo |
| `models/ships/bigviper/skin.pcx` | 304x195 | `pcx:f1244ddc5f49` | `metal` | refreshed in node | a flat UV skin sheet for a large angular fighter craft: heavy riveted armour plating, a canopy and engine nozzles, Quake 2 1997 first-person-shooter asset, weathered sci-fi metal and grime, flat studio lighting, centred subject, no text, no watermark, no logo |
| `models/ships/strogg1/skin.pcx` | 312x171 | `pcx:8bc2b5bf2858` | `metal` | refreshed in node | a flat UV skin sheet for a battle-worn dropship: hulking riveted armour, scorch marks, a canopy and thrusters, Quake 2 1997 first-person-shooter asset, weathered sci-fi metal and grime, flat studio lighting, centred subject, no text, no watermark, no logo |
| `models/monsters/parasite/segment/skin.pcx` | 248x36 | `pcx:38cdb21b71f6` | `organic` | refreshed in node | a flat UV skin sheet for the segmented chitin tail of a Strogg parasite: ridged mottled plates, Quake 2 1997 first-person-shooter asset, weathered sci-fi metal and grime, flat studio lighting, centred subject, no text, no watermark, no logo |
| `models/monsters/parasite/tip/base.pcx` | 248x52 | `pcx:38cdb21b71f6` | `organic` | refreshed in node | a flat UV skin sheet for the armoured stinger tip of a Strogg parasite's tail: hard chitin and a barb, Quake 2 1997 first-person-shooter asset, weathered sci-fi metal and grime, flat studio lighting, centred subject, no text, no watermark, no logo |
| `models/monsters/tank/../ctank/skin.pcx` | 308x194 | `pcx:788ff81a8f08` | `organic` | refreshed in node | a flat UV skin sheet for a heavier Strogg tank walker mech: extra-thick riveted armour plating, hoses and scorch marks, Quake 2 1997 first-person-shooter asset, weathered sci-fi metal and grime, flat studio lighting, centred subject, no text, no watermark, no logo |
| `models/monsters/tank/../ctank/pain.pcx` | 308x194 | `pcx:788ff81a8f08` | `organic` | refreshed in node | a flat UV skin sheet for a heavier Strogg tank walker mech: extra-thick riveted armour plating, hoses and scorch marks, Quake 2 1997 first-person-shooter asset, weathered sci-fi metal and grime, flat studio lighting, centred subject, no text, no watermark, no logo |

## Checks run on this art

```
node scripts/tex-check.mjs --only models/ --quiet
  checked 125 pictures of 611 entries: 125 with art (2.3 MB), 0 without,
  0 the wrong size, 0 unreadable, 0 unclaimed

node scripts/model-art.mjs --engine-check
  pack-simulated 125 entr(y|ies), 0 problem(s)

node scripts/texture-pack.mjs --dry-run --only models/
  125 packed (0 identical to the original), 0 without art, 0 skipped, 0 failed
  would write baseq2/pak0.pak: 46.4 MB, 1106 entries, 125 replaced
```

`--dry-run` builds the whole archive in memory and writes nothing, so
`baseq2/pak0.pak` is untouched by this task (sha1
`b86e8878a8e8706595ceebe88b3e6b4c1ba5bcab`, the same as it arrived). `node server.js`
still answers 200 at `/apps/quake2/` and at `/`, and serves the unchanged 48 MB pak.

The art itself was looked at as well as measured: `node scripts/model-art.mjs
--preview --out <file.png>` writes a contact sheet with each original beside its
replacement, as the engine will show it. Four sheets -- weapons (first-person and
world), monsters, items, objects and effects -- were written to the run's evidence
folder and read back, pair by pair. Every pair was the same subject in the same
registration, the replacement tile the sharper and higher-contrast one, and none of
them corrupted, misregistered or turned into noise; the two things the reading
flagged were that the shadows had gone deeper and that the bloodier monster frames
had warmed, which is what a contrast-and-saturation refresh does.

Those four looks were taken one revision earlier, in which the contrast curve was
applied to each channel; the revision that is on disk contrasts luminance only and
pivots the curve at each picture's own mid, for exactly those two reasons (a
per-channel curve moves hue, and a curve pivoted at 128 flattens a low-key
picture). The final revision was looked at too: this box's vision endpoint answered
three times without a description while the change was being made (`ENDPOINT_DOWN`),
and then read the sheet back, pair by pair, as the same subject in every pair and
the right tile the cleaner, sharper, higher-contrast one with no corruption. Where
the eye and the numbers can both be had, the numbers above say the same thing for
all 125 entries, and the pass is pixel-for-pixel -- every output pixel is a function
of the input pixel that was there and of its immediate neighbours -- so nothing in
the art can have moved.

## Format notes

- A model skin is an 8-bit RLE **PCX** with the picture's own 768-byte palette at
  the end of the file; the header is 128 bytes and `bytesPerLine` is the width, not
  the width rounded up (this engine's row decoder reads by pixel count, so a pad
  byte would smear the picture). `scripts/texture-lib.mjs` reads and writes it.
- A skin is a single UV atlas: the polygons' UVs are painted straight into this
  rectangle, so the art has to read as a picture of the subject -- the point of the
  prompts above -- rather than as a seamless tiling texture like a wall.
- The transparent index is 255. A skin's cut-out is the palette entry the engine
  treats as see-through, so art for a skin must keep those pixels at 255; both
  routes here guarantee it, and `texture-pack.mjs`'s `--alpha` default (keep the
  original where the art is transparent) is a second guard on the same rule.
- The engine loads a skin from `baseq2/pak0.pak` and nowhere else, so a replacement
  only counts once `scripts/texture-pack.mjs` has put it into the archive: run it
  after this art is on disk.
