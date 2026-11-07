# 1.2.4 verification report: the owner's mobile HUD review

The round that finishes team `team-tkonhzox`. Its t1–t5 (settings in the menu,
a quiet boot, 2x view weapons) were already on `clawbox/team-tkonhzox`; t6
(final integration, Store size, documentation) died on an API error. This
round adds the owner's annotated mobile HUD review (`318067b`,
`design/mobile-hud-review.png`) on top and redoes t6.

The acceptance criteria are in `docs/mobile-hud-review.md`. Every suite below
ran on this checkout with its own `server.js` on a spare port and its own
temp `QUAKE2_DATA_DIR`. None of them touched the live app (4231), the control
API (4233) or the kiosk browser (18801). The control API and MCP checks
looked for a live game, so their `QUAKE2_CDP_URL` was pointed at a headless
Chrome this run started (its own server on 4472). The suites' stdout is in
`logs/`.

## What each task changed, and what proved it

| Task | Commit(s) | Changed | Proof |
| --- | --- | --- | --- |
| 1 Reconcile and baseline | `05fd7e7` | `docs/mobile-hud-review.md` (six criteria, the salvage branch's contents, the baseline), `docs/mobile-hud-review/baseline/` (shots at 844x390 and 390x844, gate summary) | The input gate on a copy of `318067b`: **FAILED 31/34**, not PASSED. The failures were measured: 5c/5e are the owner's WPN note (the dropped `+exec q2touch.cfg`), and 5b was the gate's own jump timing |
| 2 Top row and full screen | `37fd1e3` | `index.html`, `style.css`, `fullscreen.js` (salvage), `game-mode.js`, `mobile-controls.js` (OPTIONS row), `server.js` (salvage `/apps/quake2/` alias), `scripts/mobile-fullscreen-test.mjs` (salvage), gate L1–L3 and 5g, menu audit, presentation gate, boot probe | `mobile-fullscreen-test` 8/8. Gate on the t2 tree: L1/L2 PASS and 5g PASS. L3 failed only because the check missed the rotate card's button (fixed in the check); 5c/5e were still the old failures |
| 3 WPN and crouch | `93ec7ea` | `app.js` (`boot()` keeps page-appended arguments), `mobile-controls.js` (WPN on `/`, CROUCH on `c`, FIRE drag-to-aim, no-switch note), `index.html`, `style.css`, gate 5a/5b/5e/5h/5i/6d, `scripts/mobile-controls-test.mjs` | Gate on the t3 tree: **PASSED 40/40** (after the console-race fix in `9920022`) |
| 4 Opacity and ergonomics | `9920022`, `bf05988` | `style.css` (`--mc-rest` 0.5, `--mc-pressed` 1, instant on press), gate A1/O1–O3, gate console wait | Gate on the t4 tree: 43/44 (O2 read the press mid-transition, so the press now jumps to full strength), then the final run below |
| 5 Integration and t6 | `1.2.4` commit | `mobile-controls.js` (MENU confirm-and-resend, no compatibility click from the pad), gate 5j and 7b, `scripts/mobile-controls-test.mjs` and `scripts/boot-probe.mjs` brought up to 1.2.3 behaviour, `scripts/store-package.mjs`, `CHANGELOG.md`, this report | The table below |

## The integrated tree

| # | Command | Result |
| --- | --- | --- |
| 1 | `CHROME_PATH=/opt/google/chrome/chrome node scripts/mobile-input-gate.mjs --phone --out docs/release-1.2.4/mobile-input-gate` | **PASSED, 45/45 checks**, exit 0; six screenshots in `mobile-input-gate/shots/` |
| 2 | `node scripts/verify-presentation.mjs --url http://127.0.0.1:4473/apps/quake2/` | PASS, 250/250 checks |
| 3 | `node scripts/menu-audit-test.mjs` | 44/44 checks (a first run was 43/44: the engine's `skill` read through the console came back empty three times; the rerun read 2) |
| 4 | `node scripts/load-menu-test.mjs` | 23/23 checks |
| 5 | `node scripts/perf-check.mjs` | 13/13 checks |
| 6 | `node scripts/engine-state-test.mjs` | 48/48 checks |
| 7 | `node scripts/route-test.mjs` | 196/196 checks |
| 8 | `QUAKE2_CDP_URL=<own headless Chrome> node scripts/control-api-test.mjs` | PASS, 23 steps, 0 skipped (a first run against a game only 4 s into its level could not yet read the status-bar digits; the rerun waited 15 s) |
| 9 | `QUAKE2_CDP_URL=<own headless Chrome> node scripts/mcp-smoke-test.mjs` | PASS, 12 steps |
| 10 | `node scripts/mobile-fullscreen-test.mjs` | 8/8 checks |
| 11 | `node scripts/mobile-controls-test.mjs` | 97/97 checks |
| 12 | `node scripts/boot-probe.mjs` | 17/17 checks |
| 13 | `node scripts/store-package.mjs --port 4471 --version 1.2.4` | PASSED, 9/9 checks: 49,952,542 bytes, sha256 `af7899a93a82af88b0072fd987f87fdb428f106b0d7a711bfa5b51d5240e9a10` |

Suites 2–9 are desktop or server checks. They ran before the last change to
`mobile-controls.js`, which is inert without a touch layer; `app.js` and
`style.css` did not change after them.

### The owner's six criteria, by check (final gate run)

| Criterion | Gate checks | Measured |
| --- | --- | --- |
| 1 Full screen in the menu | L1, L2, L3 (+ `mobile-fullscreen-test` 8/8) | No `#fullscreen-button`/`#fullscreen-hint` at 844x390, 932x430 or 390x844; the row is in VIDEO's page list. A phone touch on it enters full screen ("on") and a second touch leaves it ("off") |
| 2 PAD gone, uncluttered top row | L1–L3, 5g | Top row is MENU alone (14,8 46x44). 0 overlaps and 0 targets under 44 px at all three viewports. OPTIONS › touch controls (44 px row) turns the pad off, leaving only MENU, and back on |
| 3 WPN does something | 5a, 5c, 5e | `execing q2touch.cfg` runs; `e`, `/` and `c` are bound. Two WPN taps: `weaponIndex` 105 → 82 → 95. With only the blaster: 61 → 61 and the note "No other weapon to switch to yet" |
| 4 CROUCH like the PC's C | 5h, 5i | CROUCH at 616,276 58x58, beside JUMP at 682,276 58x58. View z −105.8 → −129.8 (24 units) while held, back to −105.8 after release, 0 units of x/y drift. Crouch-walk: 34.5 units with z still −129.3 |
| 5 Fire + move (+ aim) in one gesture | 6a, 6d, 3a, 3b | Stick + a sliding FIRE: 674.2 units moved, yaw +14.65°, ammo 159 → 128, one mouse press held. A look drag alone: yaw ±29.17°, pitch ∓17.16°, ammo 177 → 177 |
| 6 Opacity and ergonomics | O1, O2, O3, A1, 5j, 9a, L3 | Idle: all seven controls at 0.5, look surface transparent. Pressed CROUCH and stick: 1, while FIRE stays 0.5; both back to 0.5 after release. Pad off: nothing drawn but MENU (0.5). No target inside x 253–591 (844) or 280–652 (932). The MENU tap's click never reached the menu. The portrait rotate card is shown, text unchanged |

## What the integration found, and fixed

* **WPN and USE had been dead since `5fa1aa7`.** `boot()` replaced
  `Module.arguments`, which dropped the touch layer's `+exec q2touch.cfg`.
  As a result `[`/`]` stayed `invprev`/`invnext` (read from the engine
  console: `"[" = "invprev"`) and `e` was unbound. The release record for
  1.2.3 shows the old 34-check gate passing on 2026-11-04, one day before that
  commit.
* **A MENU tap could be lost** right after a quick boot. Instrumented: the
  touch layer's Escape went out at 1541 ms, key_dest never left 0 and the
  menu never opened (`mobile-fullscreen-test` failed this way 2 of 2 times on
  the t4 tree). MENU now checks the engine's key_dest; when 400 ms and 6 drawn
  frames pass with the game still owning the keyboard, it sends the Escape
  once more. In three instrumented reruns it needed the resend once. The same
  trace showed the browser's compatibility click for the tap landing on the
  menu panel that had just appeared under the finger. The pad now cancels
  its touches' default action, so no click follows (gate 5j).
* **The gate's own races:** the arming console fell inside the page's
  boot-time console watch (app.js closes any console until 8 s after the
  watch starts), and 7b's second stick press pushed the player into the wall
  the first press had reached (316.8 units, then 0.0). The gate now waits out
  the watch and pushes the second press back the way the first one came. No
  assertion was loosened.
* **Two older suites were stale against 1.2.3:** `mobile-controls-test`
  expected applied settings on the URL, and `boot-probe` expected crosshair
  pairs on the start-up line. Since `5fa1aa7` both live in `config.cfg`, on
  purpose. Both suites now check where the value really is.

## The Store package

`node scripts/store-package.mjs --port 4471 --version 1.2.4` (record:
`store-package/store-package.json`, screenshot: `store-package/boot.png`).

| | |
| --- | --- |
| Contents | Every file git lists except `docs/`, `assets/` and `baseq2/pak9.pak` (the exclusions used since 1.0.0): 71,608,784 bytes raw |
| Package | `quake2-store-1.2.4.tgz`, **49,952,542 bytes** (47.6 MiB), built from `581c478` |
| sha256 | `af7899a93a82af88b0072fd987f87fdb428f106b0d7a711bfa5b51d5240e9a10` |
| Reproducible | A second build gave the same sha256. Every mtime is the newest commit that touched a packaged file, so a docs-only commit (like the one that records this) does not change it |
| Boot | Extracted into an empty `quake-2` folder, its own `server.js` on port 4471: pak0 200 (47,498,591 bytes), pak10 200 (13,770,565 bytes), pak9 404 as intended. In a level 3.1 s after opening the bare URL, keyboard in the game, at 128.06 / −319.94 / 64.06 (demo1's start). The start-up line ends `+map demo1`, with no cheats. 0 console errors, 0 page exceptions |

The cap is the Store's 50 MiB (52,428,800 bytes) compressed. This package
leaves 2,476,258 bytes (2.4 MiB) of room; 1.0.0 had 6.8 MiB. pak10 grew with
the 2x weapon skins. The next archive or art round has to be measured
against this margin, or the package will be refused.

## Not covered

* The `own window` path of the full-screen row (criterion 1.4) was not
  exercised: the box's CSP `sandbox` header, as the menu audit's proxy
  applies it, did not stop headless Chrome from going full screen, so every
  run took the enter/leave branch.
* Nothing was merged, deployed or published. The live app on 4231 still
  serves the main checkout.
* A real phone was not used. Every touch check is Chrome's touch emulation
  driven over CDP. Weapon switches took 4–5 s there, at about 2.5 frames a
  second, which is why WPN waits for drawn frames as well as time.
* The gate's fixture still arms the player with `sv_cheats 1; give all` on
  its deathmatch fixture, as it always has. That is the only way this harness
  gets ammo and a second weapon. The app itself boots `demo1` with cheats 0
  (checked on the Store package's own start-up line).
