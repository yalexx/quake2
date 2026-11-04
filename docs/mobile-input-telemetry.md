# Mobile input telemetry: the weapon and the ammo

`window.quake2Engine.read()` (engine-state.js) reports the player's current
weapon and ammo as numbers, so the mobile input gate can assert that a touch
control changed what the engine is actually doing rather than merely that a
DOM event fired:

```js
const state = window.quake2Engine.read();
state.weaponIndex;        // integer, or null with state.weaponIndexReason
state.ammo;               // integer, or null with state.ammoReason
```

Both are read from the engine's own WASM memory. Nothing here is inferred from
the DOM or the screenshots.

## What the two numbers are

| field | source | encoding | measured meaning |
| --- | --- | --- | --- |
| `weaponIndex` | `cl.frame.playerstate.gunindex`, offset **0x058830** (362544) | int32 | the model index of the first-person weapon model, e.g. 68 = machinegun. **Not** Quake 2's 1..10 weapon number -- see the caveat below. |
| `ammo` | `cl.frame.playerstate.stats[3]`, within the 32-entry array at offset **0x058850** (362576) | int16 | the ammo count the HUD draws for the current weapon; falls when the weapon fires. |

`read()` publishes these offsets in `window.quake2Engine.offsets`:
`gunindex`, `gunframe`, `stats`, `statsCount` (32), `statsEncoding`
(`"int16"`), `statHealth` (1), `statAmmoIcon` (2), `statAmmo` (3).

When a value cannot be trusted it is `null` and carries a reason, never a
fabricated zero:

| reason | field | meaning |
| --- | --- | --- |
| `ENGINE_NOT_LOADED` | both | the wasm memory does not exist yet |
| `GUNINDEX_OUT_OF_RANGE` | `weaponIndex` | the buffer is too small to hold the word |
| `GUNINDEX_IMPLAUSIBLE` | `weaponIndex` | the word is not a model index (negative, or above 65535) |
| `STATS_OUT_OF_RANGE` | `ammo` | the buffer is too small to hold the stats array |
| `STATS_IMPLAUSIBLE` | `ammo` | the stats entry that must hold health does not, so this is not the player's stats array |

Zero is a real reading in both cases: `weaponIndex` 0 is "no weapon model yet"
(the state before the level gives the player a weapon) and `ammo` 0 is the
blaster's ammo count.

## Live trace: eight weapons, one number each

Taken from the delivered page (`engine-state.js` served from this worktree),
`?+map&demo1&+set&cl_gun&0`, after `sv_cheats 1; give all`, with each weapon
selected by its own number key and allowed 5 s to settle. Every row is the
second of two `quake2Engine.read()` calls 1 s apart -- identical in all eight
rows (`settled: true`), which rules out a lagging player state. `HUD` is a
separate read of the drawn ammo from a screenshot.

| weapon | key | `weaponIndex` | `ammo` | HUD ammo | settled |
| --- | --- | --- | --- | --- | --- |
| machinegun | 4 | 68 | 200 | 200 | yes |
| chaingun | 5 | 69 | 200 | 200 | yes |
| shotgun | 2 | 64 | 100 | 100 | yes |
| super shotgun | 3 | 70 | 100 | 100 | yes |
| railgun | 9 | 71 | 50 | 50 | yes |
| BFG10K | 0 | 72 | 200 | 200 (OCR read "2001") | yes |
| rocket launcher | 7 | 73 | 50 | 50 | yes |
| blaster | 1 | 36 | 0 | -- (nothing drawn) | yes |

Sample count: 8 weapons x 2 engine reads + 1 HUD read = 16 engine samples and
8 HUD samples. The HUD agrees with `ammo` in 6 of the 8 states; BFG10K was
misread as "2001" and the blaster draws no ammo number at all, so those two
rows rest on the engine reading alone (plus the settled second read).

## Why `weaponIndex` is `gunindex` and not a stats entry

The obvious place to look for a weapon is the stats array, and that is where
this search started. It does not hold one. Selecting all eight weapons and
capturing the whole array showed that `stats[2]` is the *ammo type's icon
index*, and groups weapons that share ammo:

| weapon | `stats[2]` (ammo icon) | `stats[3]` (ammo) |
| --- | --- | --- |
| machinegun | 14 (bullets) | 200 |
| chaingun | 14 (bullets) | 200 |
| shotgun | 9 (shells) | 100 |
| super shotgun | 9 (shells) | 100 |
| railgun | 15 (slugs) | 50 |
| BFG10K | 16 (cells) | 200 |
| rocket launcher | 17 (rockets) | 50 |
| blaster | 0 (none) | 0 |

Machinegun and chaingun are identical in the stats array, and so are shotgun
and super shotgun. That is the classic Quake 2 stat layout (`HEALTH_ICON 0`,
`HEALTH 1`, `AMMO_ICON 2`, `AMMO 3`, `ARMOR_ICON 4`, `ARMOR 5`); the total
weapon was never in it. `gunindex` is the player state's own weapon field and
it distinguishes every weapon: 36 (blaster), 64 (shotgun), 68 (machinegun), 69
(chaingun), 70 (super shotgun), 71 (railgun), 72 (BFG10K), 73 (rocket
launcher).

`weaponIndex` is therefore a **model index, not a weapon number**. Model
indices are assigned in precache order, so the same weapon can read differently
on another level; values 1..10 should not be expected, and this file does not
try to map them to weapon names. What is guaranteed, and what an input gate
needs, is that within a level the value changes when the player's weapon
changes -- including within an ammo family -- and does not change while
firing.

## Live trace: firing

Machinegun, `weaponIndex` 68, read through `quake2Engine.read()`; `+attack`
held for 600 ms and the state allowed to settle:

| moment | `weaponIndex` | `ammo` |
| --- | --- | --- |
| before the burst | 68 | 200 |
| 2.5 s after the burst | 68 | 198 |

The weapon word did not move and the ammo fell by the two rounds the burst
fired. An earlier probe that read the same stats entry directly (before this
reader existed) saw 200 -> 197 for one 600 ms burst.

The HUD's ammo is *not* a reliable witness during or just after firing on this
headless build: three consecutive screenshots after the burst read the ammo
field as 4 at the same pixel position where they read 200 before it, while the
engine said 198. Before firing all three HUD reads agreed at 200. Treat the
engine's number as authoritative and the HUD as a cross-check at rest, where
it agreed in the eight-weapon trace above.

## How the offsets were recovered

- Five snapshots of the low 2 MiB of the linear memory were taken in different
  states (spawn, machinegun, shotgun, railgun, BFG10K) and diffed offline.
  Exactly one 32-entry window changed with the weapon: at 0x058850.
- The array is **int16**, not int32 or float32: an int32 read misaligns it and
  a float32 search for the ammo value finds nothing. 32 entries x 2 bytes = 64
  bytes, ending exactly where the next field of the player state begins.
- Identity checks: entry 1 read 100 -- the health the HUD drew -- in every
  state, and entry 3 matched the HUD's ammo in the settled states above.
- `gunindex` sits immediately before `gunframe`, `blend[4]` (floats), `fov`
  (90.0f) and `rdflags`, and the stats array follows at 0x058850. It was
  confirmed by switching weapons and reading it back: distinct for all eight.
- Timing: under headless SwiftShader a weapon switch takes up to ~5 s to reach
  the player state. A gate that reads immediately after a touch will see the
  previous weapon; it must poll or settle. The trace above reads twice a
  second apart and requires both to agree.

The game-side edict was **not** located on this build. The documented layout
(`control/edicts.mjs`: base 0x35ea250, stride 892, health +0x1e0) did not
reproduce -- the game heap moves between boots, a self-naming scan across the
image found no stride-892 run, and a vieworg-anchored scan found only copies of
the view origin. So health is cross-checked against the HUD, not the edict.
For the same reason `health` and `armour` remain `null` in `read()`: this pass
did not recover them and will not invent them.

## Reproducing

```sh
node scripts/engine-state-test.mjs      # vm/synthetic memory, no browser
```

The live traces were taken with a page served from this worktree on a free
port, headless Chrome (`CHROME_PATH=/opt/google/chrome/chrome`, free debug
port), `?+map&demo1&+set&cl_gun&0`, and `sv_cheats 1; give all` through the
page's console. Probe scripts and their JSON reports are in the run's evidence
folder (`probe18.mjs`/`p18-report.json` for the eight-weapon trace,
`probe19.mjs`/`p19-report.json` for the firing trace).
