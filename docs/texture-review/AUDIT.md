# In-level audit of the 20 most-drawn textures

Step 1 of the texture-review goal: a visual audit of the twenty most-used textures
as they are drawn in Quake 2's own levels, in real Chrome, on the 4x art this
checkout packs. Every shot below is the 4x art (NEW, `r_retexturing 1`) beside the
pak0 art (OFF, `r_retexturing 0`) from the same face, eye, yaw and pitch, taken by
`scripts/texture-audit.mjs` and recorded with its renderer string in
`docs/texture-review/ingame/audit/audit.json`.

## Method

**Selection.** `assets/textures/manifest.json` names 313 texinfos across demo1,
demo2 and demo3. Counting the faces each texinfo is drawn on (`uses`) per map and
summing across the three maps gives the ranking; the top twenty entries that have
pak9 art are audited. Ties are broken by name. A texinfo whose spelling differs
in case from the pak (`e1u1/FLAT1_2` beside `e1u1/flat1_2`, and the other
uppercase spellings) has no art of its own and is skipped, as is a texinfo whose
faces are all on inline brush-entity models rather than on the world
(`e1u1/trigger`): neither can be shown in a level view. The audited twenty
therefore reach down to rank 22.

**The view.** For each entry the tool finds the largest drawn **world** face
(model 0) with that texture inside `baseq2/pak0.pak`, reading the BSP lumps Quake 2
defines (planes 1, vertexes 2, texinfo 5, faces 6, edges 11, surfedges 12,
models 13). `SURF_SKY` faces are skipped unless the entry is a sky, `SURF_NODRAW`
always. The eye is placed 96-160 units off the face centroid along the face
normal (flipped when the face's side is non-zero) -- straight out for a wall,
and stood back across the plane and level for a floor or a ceiling, so the
surface lies about 20 degrees off the view axis with the room around it. The eye and every sample along the sight line
must be in empty space (`RouteMap.worldContentsAt`), so the camera is never
inside a brush and never looks through a wall. Yaw and pitch are computed toward
the centroid in Quake 2's own convention (yaw 0 = +X, growing anticlockwise;
positive pitch looks down).

**The capture.** The open Chrome tab is driven over CDP exactly as
`scripts/texture-fps.mjs` does: one map load per (variant, map) by URL (`+map` in
the query string, never a console `map`), then per entry the single-player cheats
`notarget`, `god`, `noclip` and the engine's `teleport x y z` (with `+set cheats 1`
before `+map` -- typing `cheats 1` on the console does not take). The engine puts
the eye 32 units above the teleported origin, so the tool measures that offset
from the first teleport and re-teleports to land the eye on the planned camera,
then checks the landed eye and angles against the plan.

**Pitch: a measured limitation.** `QuakeControl.face()` turns the view with the
arrow keys, and that works. Pitch does not: this build ignores the bridge's
relative-motion mouse (`lookPitch`), and it ignores its own keyboard look commands
as well -- a key bound to `+lookup` or `+lookdown`, held 0.9 s, on a letter or an
arrow, with or without `+klook`, leaves the angle exactly where it was, while the
same keys bound to `+left`/`+right` turn the yaw 89 degrees in 0.6 s. The tool
tries the keyboard look once per view and records the achieved pitch for every
shot in `audit.json`; a floor or a ceiling is instead planned as a level view (the
eye stands H above/below the plane and D across it, surface about 20 degrees off
the axis). This is the one deviation from the brief's "pitched 35-50 degrees",
and it is the engine's limit, not the art's: the surfaces are still framed with
their neighbours, which is what the tiling, palette and brightness checks need.

**Checks per load.** WebGL2 context, unmasked renderer name containing ANGLE,
`vid_renderer gles3`, a 1366x768 drawing buffer, and -- because the live app on
:4231 serves a different checkout (its pak9 is absent) -- a scratch server on a
free port serving THIS checkout, whose served `pak9.pak` sha1 must equal the
worktree's before any shot is called current art. The tab is returned to
`http://127.0.0.1:4231/` when the run ends.

## The twenty

| # | entry | faces (demo1/2/3) | map | face | verdict | shots |
|---|-------|-------------------|-----|------|---------|-------|
| 1 | e1u1/support1_1 | 1911 (226/1396/289) | demo2 | #6248 | ok -- the slat seam repeats in OFF too | [NEW](ingame/audit/01-e1u1_support1_1-NEW.jpg) [OFF](ingame/audit/01-e1u1_support1_1-OFF.jpg) |
| 2 | e1u1/flat1_2 | 1902 (611/316/975) | demo3 | #1175 | ok | [NEW](ingame/audit/02-e1u1_flat1_2-NEW.jpg) [OFF](ingame/audit/02-e1u1_flat1_2-OFF.jpg) |
| 3 | e1u1/metal3_3 | 1157 (0/920/237) | demo2 | #3475 | ok | [NEW](ingame/audit/03-e1u1_metal3_3-NEW.jpg) [OFF](ingame/audit/03-e1u1_metal3_3-OFF.jpg) |
| 4 | e1u1/ggrat4_4 | 1032 (192/523/317) | demo2 | #6231 | ok | [NEW](ingame/audit/04-e1u1_ggrat4_4-NEW.jpg) [OFF](ingame/audit/04-e1u1_ggrat4_4-OFF.jpg) |
| 5 | e1u1/metal2_1 | 977 (588/132/257) | demo1 | #3428 | ok -- the tile grid is the art's own, in OFF too | [NEW](ingame/audit/05-e1u1_metal2_1-NEW.jpg) [OFF](ingame/audit/05-e1u1_metal2_1-OFF.jpg) |
| 6 | e1u1/rocks19_1 | 943 (471/114/358) | demo1 | #2844 | ok -- the rock-face light break is in OFF too | [NEW](ingame/audit/06-e1u1_rocks19_1-NEW.jpg) [OFF](ingame/audit/06-e1u1_rocks19_1-OFF.jpg) |
| 7 | e1u1/floor3_1 | 708 (312/142/254) | demo1 | #5024 | ok | [NEW](ingame/audit/07-e1u1_floor3_1-NEW.jpg) [OFF](ingame/audit/07-e1u1_floor3_1-OFF.jpg) |
| 8 | e1u1/metal3_5 | 700 (357/68/275) | demo1 | #1552 | ok | [NEW](ingame/audit/08-e1u1_metal3_5-NEW.jpg) [OFF](ingame/audit/08-e1u1_metal3_5-OFF.jpg) |
| 9 | e1u1/grnx2_9 | 696 (342/287/67) | demo1 | #4512 | ok | [NEW](ingame/audit/09-e1u1_grnx2_9-NEW.jpg) [OFF](ingame/audit/09-e1u1_grnx2_9-OFF.jpg) |
| 10 | e1u1/grate1_4 | 690 (184/68/438) | demo3 | #6128 | ok | [NEW](ingame/audit/10-e1u1_grate1_4-NEW.jpg) [OFF](ingame/audit/10-e1u1_grate1_4-OFF.jpg) |
| 11 | e1u1/wgrate1_4 | 677 (0/507/170) | demo2 | #6467 | ok -- the receding smear is in OFF too | [NEW](ingame/audit/11-e1u1_wgrate1_4-NEW.jpg) [OFF](ingame/audit/11-e1u1_wgrate1_4-OFF.jpg) |
| 12 | e1u2/basic1_7 | 584 (146/258/180) | demo1 | #1961 | ok -- dim 512 u2 face, nothing broken visible | [NEW](ingame/audit/12-e1u2_basic1_7-NEW.jpg) [OFF](ingame/audit/12-e1u2_basic1_7-OFF.jpg) |
| 13 | e1u1/metal3_2 | 508 (114/186/208) | demo3 | #2460 | ok -- the sky/void cut is in OFF too | [NEW](ingame/audit/13-e1u1_metal3_2-NEW.jpg) [OFF](ingame/audit/13-e1u1_metal3_2-OFF.jpg) |
| 14 | e1u1/metal1_8 | 415 (89/162/164) | demo3 | #594 | ok -- the floor tile seam is in OFF too | [NEW](ingame/audit/14-e1u1_metal1_8-NEW.jpg) [OFF](ingame/audit/14-e1u1_metal1_8-OFF.jpg) |
| 15 | e1u1/grate2_2 | 406 (260/12/134) | demo1 | #2408 | ok | [NEW](ingame/audit/15-e1u1_grate2_2-NEW.jpg) [OFF](ingame/audit/15-e1u1_grate2_2-OFF.jpg) |
| 16 | e1u1/sky1 | 404 (214/111/79) | demo1 | #3548 | ok | [NEW](ingame/audit/16-e1u1_sky1-NEW.jpg) [OFF](ingame/audit/16-e1u1_sky1-OFF.jpg) |
| 17 | e1u1/bluwter | 387 (102/227/58) | demo2 | #5716 | ok | [NEW](ingame/audit/17-e1u1_bluwter-NEW.jpg) [OFF](ingame/audit/17-e1u1_bluwter-OFF.jpg) |
| 18 | e1u1/grate2_1 | 367 (116/0/251) | demo3 | #5740 | ok | [NEW](ingame/audit/18-e1u1_grate2_1-NEW.jpg) [OFF](ingame/audit/18-e1u1_grate2_1-OFF.jpg) |
| 19 | e1u1/grate2_5 | 327 (77/202/48) | demo2 | #204 | ok | [NEW](ingame/audit/19-e1u1_grate2_5-NEW.jpg) [OFF](ingame/audit/19-e1u1_grate2_5-OFF.jpg) |
| 20 | e1u1/grate1_3 | 311 (96/123/92) | demo2 | #101 | ok | [NEW](ingame/audit/20-e1u1_grate1_3-NEW.jpg) [OFF](ingame/audit/20-e1u1_grate1_3-OFF.jpg) |

## What was not fixed, and why

A fix needs a defect that is clear in the shot and caused by the new art. The
verdicts above are what the pairs show, judged NEW beside OFF. Nothing in the
twenty was changed in this step: every artefact the pictures raised turned out to
be in the OFF shot as well, so it is the map or the engine, not the art --

- **e1u1/support1_1, e1u1/metal2_1** (slatted and riveted walls): the repeated
  vertical/horizontal lines are the texture's own tile grid, drawn the same way
  in OFF; the new art repeats rather than mismatches at the boundary.
- **e1u1/rocks19_1**: the vertical light break across the rock face is the map's
  brush split and lightmap, identical in OFF.
- **e1u1/wgrate1_4**: the smear along the receding slats is mipmap/filtering on a
  steep angle, identical in OFF.
- **e1u1/metal3_2**: the sky cutting to grey is the map's own void at the ledge,
  identical in OFF.
- **e1u1/metal1_8**: the floor seam in the lower right is two brushes whose
  texinfo offsets do not line up, identical in OFF.
- **e1u2/basic1_7**: the face is 512 u2 and the room is dark; the view shows no
  art to call broken either way, and that is recorded rather than counted a pass
  on texture detail.

No `MATERIAL_TUNING` row, `TEXTURE_OVERRIDES` row or any art file was changed,
and neither pak was rebuilt for this step: the audit found nothing the new art
broke. The one thing the audit could not do as briefed is pitch the floor and
ceiling views (see "Pitch" above); the engine's keyboard and mouse look both
leave the pitch where it is on this build, so those views are level and framed to
put the surface about 20 degrees off the axis.

## Environment

- Renderer per shot: recorded in `audit.json` (`renderer`); the loads used
  ANGLE (Intel, Mesa Intel(R) UHD Graphics 620 (KBL GT2), OpenGL ES 3.2), WebGL2,
  `vid_renderer gles3`, drawing buffer 1366x768.
- Load average during the capture: recorded in `audit.json` (`load`); the box is
  shared, and the run is noted here because the real-Chrome rule asks for it.
