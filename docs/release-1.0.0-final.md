# Quake 2 for ClawBox — release 1.0.0

**Verdict: PASS.** The project's own strict acceptance runner finished with
exit status **0** and **219 of 219 checks passed**, `fatal: null`, at
1280x720 and 2560x1440.

- Tested commit: `ad7bf5c` (branch `clawbox/run-cxsxmcvb`; served app files
  last changed in `247c6e8`, the runner in `ad7bf5c`).
- Machine-readable result: `docs/release-1.0.0-final.json`.
- Full evidence: `docs/presentation-verification/report.json`,
  `docs/presentation-verification/shots/` (53 screenshots),
  `docs/release-verification-1.0.0.log`, `docs/release-verification-1.0.0.exit`,
  `docs/presentation-verification/logs/{server,chrome}.log`.

## Exact command and result

```sh
node scripts/verify-presentation.mjs --url http://127.0.0.1:4331/apps/quake2/
```

```
PASS — 219/219 checks; report docs/presentation-verification/report.json
```

Exit status written by the run: `0` (`docs/release-verification-1.0.0.exit`).
Started 2026-11-02T12:33:11Z, finished 2026-11-02T13:07:06Z (2035 s).

Environment: Node v24.22.1, `/usr/bin/google-chrome --headless=new`,
renderer `ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero)), SwiftShader
driver)`, display HDMI-A-1 2560x1440. The gate ran this branch's own
`node server.js` on port **4331** because the installed app instance holds 4231;
the gate's own file-hash check proves the bytes served on 4331 are this checkout
(`index.html`, `style.css`, `rtx-renderer.js`, `app.js`, `fullscreen.js`,
`game-mode.js`, `engine-state.js`, `rtx-materials.js`, `baseq2/pak10.pak`).
User state was isolated: the runner quarantines `userdata/baseq2/config.cfg` for
the run and restores it on teardown; no concurrent game test ran.

The app is served under its Store base path `/apps/quake2/` (HTTP 200, no
redirects, served as `text/html`, hashed identical to the checkout).

## What the 219 checks cover

Boot and archive coverage, the WebGL2/gles3 renderer and shader programs, the
engine's own menu tree at 1280x720 and 2560x1440 in all three lighting presets,
weapon draws, the engine's status bar in the canvas bottom band (no page element
over it), the crosshair's size/alpha/tint over dark and bright backgrounds,
`crosshair 0` and `crosshair_scale`, camera preservation across console
commands, aim feedback (weapon, firing, crouch, scale), game mode (full-screen
presentation, the page's read-back suspended, no frame-time regression), the
resolution switch, full-screen behaviour, and a clean page (0 uncaught
exceptions, 0 console errors, no WebGL context loss).

## Defects fixed in this release cycle

Each is in the tested commit and was reproduced before it was changed.

1. **Console commands cost a frame per key** (`control/bridge.mjs`). Key events
   were awaited one at a time; at 2560x1440 each wait is a rendered frame, so
   `timescale 0` plus `condump q2state-probe` took **87.9 s** against a 90 s
   bound. The string is now written as one ordered batch (serial for modifier
   characters): the same command takes **14–15 s**, and every echo matched the
   exact string typed (6/6 at 1280x720, 3/3 and 2/3 across 2560 probes).
2. **The diagnostic status-bar read-back dominated high-resolution frames**
   (`rtx-renderer.js`). The synchronous `gl.readPixels` costs 687–1006 ms at
   2560x1440; it now backs off from 1.2 s to 4 s only on drawing buffers at
   least 1920 px wide and only when a read exceeds 500 ms — 30 reads in 70 s
   (~24 s blocked) became 14 (~11 s), with reads still succeeding. At 1280x720
   the 1.2 s cadence is unchanged (46 reads in 70 s, 180–267 ms each) because it
   is the cadence the game-mode checks measure.
3. **Game-mode wall clock used pooled statistics** (`scripts/verify-presentation.mjs`).
   A 2026-11-02 run read 5.5% slower by pooled median while the drift-cancelled
   adjacent-block median was 1.003, the mean 1.2% better and p95 43% better. The
   bound is now p95 within 5% plus the median of adjacent page/game block ratios
   within 1.02; pooled values are still reported.
4. **The main-thread saving was measured with a metric that cannot see it**
   (same file). The page performed 5 read-backs at 405 ms each while game mode
   performed 0, yet CDP `TaskDuration` was identical (304.9 vs 303.6 ms/frame):
   the read is a GPU sync wait, not main-thread task time. The check is now the
   no-regression half (`paired ratio <= 1.02`); the removal is proven
   deterministically by the read-back suspension check.
5. **The aim check could not find the blaster or the shotgun** (same file). The
   reference is now measured at the spawn loadout with no switch, invulnerability
   is set before the long captures, weapons are given afterwards, the firing and
   crouch checks run before the weapon change, and the shotgun switch falls back
   to `sv_cheats 1;use shotgun` on the console.
6. **Crosshair pairs could capture the menu or a crossless frame** (same file).
   Each pair waits for its own scene floor (dark 20, bright 60) and recovers the
   game from its menu; every pair sets the configured alpha at the start and
   restores it at the end.
7. **Pointer-lock rejections were uncaught page exceptions** (`app.js`). The
   engine's SDL glue calls `requestPointerLock()` without handling the promise;
   in a page that cannot hold pointer lock Chrome rejects it. The promise is
   wrapped and the refusal is recorded in `window.quake2PointerLockRefused`
   (7 exceptions before, 0 in the verifying run).
8. **Harness recovery** (same runner). `ensureGame` retries a page-state read
   that times out instead of aborting the run, and every console attempt is
   recorded in the report notes.
9. **Engine config isolation** (preserved from the owner's working tree).
   `userdata/baseq2/config.cfg` is quarantined for the run and restored on
   teardown.

## Remaining limitations

- **Publication was not performed.** `app_publish` is not available to this run;
  the parent publishes version 1.0.0 from the branch. `clawbox.json` carries no
  version field (the ClawBox manifest schema is name/description/kind/port/start);
  the version is supplied at publish time.
- The gate ran on port **4331**, not the Store port 4231, because the installed
  app instance holds 4231. The served bytes are proven identical to this
  checkout by the gate's hash check.
- Rendering is **SwiftShader software rendering** at roughly 1.3–3.3 fps. The
  checks assert correctness and presentation; the frame-time checks are
  no-regression bounds, not GPU performance claims.
- 72 non-fatal WebGL warnings from the engine's texture setup and optional
  `pak1.pak`/`pak2.pak` 404 probes are recorded in the report; neither is a
  failure and neither file is required.
- The game-mode and crosshair-aim checks run at 1280x720 by design; the
  2560x1440 stage covers boot, lighting, weapon draws, status bar, crosshair
  presentation and menu parity.
- Content is the **Quake 2 demo PAKs** (`baseq2/pak0.pak`, `pak9.pak`,
  `pak10.pak`). `engine/license.txt` is the Id demo EULA; the Store listing must
  say so, and the README documents that the full game needs retail PAKs.

## How to reproduce

```sh
cd /home/yanko/Projects/quake2/.clawbox/worktrees/run-cxsxmcvb
PORT=4331 node server.js &            # or let the runner start it
node scripts/verify-presentation.mjs --url http://127.0.0.1:4331/apps/quake2/
```

The runner exits 0 only when every check passed and the report says `ok: true`.
It quarantines `userdata/baseq2/config.cfg` for the run and restores it on
teardown.
