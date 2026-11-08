# 1.2.5 — the Store package, measured, booted and published

Build: `bbbab03` (the merged touch-look fix, master).
Tool: `node scripts/store-package.mjs --version 1.2.5 --out docs/release-1.2.5/store-package`.

## The tarball this checkout builds

| | |
|---|---|
| files | 88 |
| raw | 71,626,522 bytes |
| compressed | **49,958,615 bytes** (2.4 MiB under the 50 MiB cap) |
| sha256 | `708e1717b5d521936282670146b050bc2dcdd184b91b19e0fb23dc4e5ed27131` |
| reproducible | yes — a second build gives the same sha256 |

The same three exclusions every release since 1.0.0 ships with: `docs/`
(256 MB of gate evidence), `assets/` (55 MB of source art) and
`baseq2/pak9.pak` (39 MB of optional 4x wall art; `app.js` skips a missing
optional archive). Nothing else in the working tree changes.

## The boot

Extracted as `quake-2` (the Store slug, which names the install folder) and
served by its own `server.js` on port 4471:

- `/apps/quake-2/` opens with the app's start-up line: map `demo1`, cheats 0
- the keyboard is in the game (`keyDest 0`), player at `128.06, -319.94, 46.19`
- boot to a running level in **3,363 ms**
- `pak0.pak` and `pak10.pak` answer 200; the left-out `pak9.pak` answers 404
- no console errors, no page exceptions
- screenshot: `boot.png`

`store-package.json` holds every check and the full record; the suite passed
**9/9**.

## What the Store serves

Published 2026-11-08 12:57 UTC through `app_publish` (project `quake2`,
version `1.2.5`):

| | |
|---|---|
| record | https://clawbox.com/api/store/apps/quake-2 |
| version | **1.2.5** |
| published size | 50,342,726 bytes |
| published sha256 | `beaf71ba6f329dac545444d33e2c7d481889715213ede818a1e5143a97a93d78` |

The published hash differs from the local one because the publisher gzips its
own way; the downloaded package was compared against the record and against
this tree instead:

- the download's size and sha256 equal the record's
- its `mobile-controls.js` is byte-identical to this tree's
  (`9c707cd5…`), i.e. the touch-look fix ships
- its `index.html` loads `mobile-controls.js?v=look125`
- `docs/`, `assets/` and `baseq2/pak9.pak` are absent — the slim set held
- the listing's description is the new 1.2.5 blurb, not the `clawbox.json` line

The tile art is the static `https://clawbox.com/store/icons/quake-2.png`; it
was fetched and compared pixel-for-pixel with `icon/quake2-256.png`
(`mean 0.0 max 0`), so the listing's `iconUrl: null` changes nothing the owner
sees.
