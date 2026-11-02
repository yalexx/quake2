# Store package for 1.0.0

Published 2026-11-02 to the ClawBox Store as `quake-2` 1.0.0 (verified).
Store record: size 45,619,022 bytes, sha256
`c38b8cd6a5d029572b5cdd26f7418a6d68376ae3033da0fdfcda97c942bcc1d7`.

## The 50 MB cap decided the contents

`packProject` (clawbox `src/lib/store-publish.ts`) packs the files git lists —
tracked plus untracked-but-not-ignored — into one tar.gz and refuses anything
over `PACKAGE_MAX_BYTES` (50 MiB compressed, 256 MiB raw). The verified 1.0.0
tree does not fit: `baseq2` is 96.0 MB and the gate screenshots under `docs/`
are another 193 MB.

Measured with `gzip -6`, the runtime files alone:

| file | raw | gzip |
| --- | --- | --- |
| `baseq2/pak0.pak` (demo data, required) | 45.2 MB | 33.4 MB |
| `baseq2/pak9.pak` (4x wall art, optional) | 39.3 MB | 39.2 MB |
| `baseq2/pak10.pak` (rebuilt models, optional) | 11.5 MB | 7.8 MB |
| `engine/` (WASM) | 2.8 MB | 0.7 MB |
| app code, icons, control, scripts | ~2 MB | ~1 MB |

So the shipped package is pak0 + pak10 + engine + code = **43.1 MB**. `pak9` is
left out: it is 39 MB of nearly-incompressible PNG wall art and including it
would put the package at ~82 MB, over the cap.

`app.js` already treats pak9 and pak10 as optional archives (`OPTIONAL_PAKS`,
a 404 is skipped), so the game runs without it — the walls are drawn from
pak0's own textures instead of the 4x set. Nothing in the repository was
changed: `pak9`, `assets/textures` and `docs/` stay tracked on disk and are
only kept out of the tarball for the length of the publish.

### Reproducing the publish

```sh
cd ~/Projects/quake2
cp .gitignore /tmp/gi.bak
printf 'docs/\nassets/\nbaseq2/pak9.pak\n' >> .gitignore
git rm -r -q --cached docs assets baseq2/pak9.pak
git add .gitignore && git commit -m "Store package: slim tarball"
git ls-files -z --cached --others --exclude-standard | tr '\0' '\n' > /tmp/list
tr '\n' '\0' < /tmp/list | tar --null -T - -czf /tmp/pkg.tgz   # expect ~43 MB
# publish version X.Y.Z from the Coding Agent / app_publish, then restore:
git reset --hard <the commit before the slim one>
mv /tmp/gi.bak .gitignore
```

## The exact tarball was booted, not just the source tree

`/tmp/pkg.tgz` was extracted to an empty folder, served with `PORT=4399 node
server.js`, and loaded in headless Chrome 156 (SwiftShader) at
`?+map&demo1&+set&crosshair&0`:

- `pak0` 200 (47,498,591 bytes), `pak10` 200 (12,118,560 bytes), `pak9` 404 as expected
- booted into the demo in **4 s**: `keyDest game`, position 128.06 / -319.94 / 64.06
- canvas 1366x768, status "Running..."
- **0 page exceptions, 0 console errors**
- screenshot `docs/store-package-1.0.0-boot.png`: 53,096 distinct colours,
  mean luma 41.7, p5 5.9, p95 105.4 — a rendered scene, not a blank page
- full reading: `docs/store-package-1.0.0-smoke.json`

## What this does not cover

- The 219/219 gate (`docs/release-1.0.0-final.json`) ran on the full tree with
  pak9 present. The Store build differs only by that optional archive; the
  smoke test above is the evidence for the shipped bytes.
- The Store build was not installed from the Store on a second box. The local
  desktop app (port 4231, serving this checkout) is unchanged and still has pak9.
