// GPL-2.0-or-later. Raster extensions for the shipped Qwasm2 GLES3 shaders.
// No WASM edits, global WebGL prototype patches, geometry changes, or ray tracing.
(() => {
  'use strict';
  const canvas = document.getElementById('canvas');
  const status = document.getElementById('rtx-status');
  const lightingButtons = Array.from(document.querySelectorAll('[data-lighting]'));
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem('quake2-raster-look') || '{}'); } catch (_) { /* opaque iframe */ }
  const params = new URLSearchParams(location.hash.slice(1));
  let enabled = params.has('rtx') ? params.get('rtx') !== 'off' : saved.enabled !== false;
  let preset = params.get('quality') || saved.quality || 'performance';
  if (!['performance', 'high'].includes(preset)) preset = 'performance';
  const report = { version: 'raster-3', worldShaders: 0, postShaders: 0, modelShaders: 0, modelReliefShaders: 0,
    skyShaders: 0, matchedTextures: 0, materials: {}, failures: [], postDraws: 0, worldDraws: 0, modelDraws: 0,
    modelTextureDraws: {}, lastModelSkinDraws: {}, skyDraws: 0, uiDraws: 0, fboSkips: 0, suppressedDraws: 0, supported: false };
  let gl, current, textureUnit = 0, dirty = true, sceneDirty = false, composite = null;
  let worldThisFrame = false, skyPending = true, lastModelSkins = [];
  // `cls.key_dest` as this frame found it, sampled once at the frame's clear so
  // a draw call never pays for a memory read. 0 is the game, 1 the console and
  // 3 the engine's own menu: the interface the dark panel replaces. While
  // either of the latter owns the keyboard their 2D draws are dropped, so the
  // engine's menu and console can never be seen -- see skipInterface().
  let frameKeyDest = 0;
  const textures = new WeakMap(), textureSizes = new WeakMap(), programs = new Map(), shaders = new WeakMap(), bound = [];
  // Per material: specular strength, roughness, fixture emission, relief scale.
  // The albedo relief is inferred from the texture's own luminance; a rougher
  // surface keeps more of it and a polished one flattens it. Nothing here adds
  // geometry, a normal map, a shadow or a new light.
  const profile = {
    metal: [0.86, 0.40, 0, 1.00], rust: [0.30, 0.70, 0, 1.10], tech: [0.56, 0.46, 0, 1.00],
    lamp: [0.30, 0.26, 1, 0.30], glass: [0.72, 0.16, 0, 0.45], stone: [0.06, 0.90, 0, 1.20],
    crate: [0.10, 0.82, 0, 0.95], wood: [0.05, 0.92, 0, 1.00], organic: [0.08, 0.78, 0, 0.85],
    sign: [0.10, 0.60, 0, 0.70], flat: [0, 1, 0, 0.50], water: [0.65, 0.20, 0, 0.60],
    sky: [0, 1, 0, 0]
  };
  const MATTE = [0.16, 0.72, 0, 0.90];
  // Weapon and monster skins are not in the wall-texture catalog, so they get
  // one restrained sheen rather than a guessed material.
  const MODEL = [0.45, 0.42, 0, 0.80];
  function statusText() {
    return report.failures.length ? 'Original renderer · effect unavailable' :
      !report.supported ? 'Requires the GLES3 renderer' :
      !enabled ? 'Original lighting' :
      preset === 'high' ? 'Raster lighting · High · no ray tracing' : 'Raster lighting · Performance · no ray tracing';
  }
  function update() {
    dirty = true;
    const active = enabled ? preset : 'off';
    for (const button of lightingButtons) button.setAttribute('aria-pressed', String(button.dataset.lighting === active));
    if (status) status.textContent = statusText();
    try { localStorage.setItem('quake2-raster-look', JSON.stringify({ enabled, quality: preset })); } catch (_) { /* optional persistence */ }
  }
  function mode() { return enabled && report.supported && !report.failures.length ? (preset === 'high' ? 2 : 1) : 0; }
  for (const button of lightingButtons) {
    button.addEventListener('click', () => {
      const value = button.dataset.lighting;
      enabled = value !== 'off';
      if (value === 'high' || value === 'performance') preset = value;
      update();
    });
  }
  window.quake2RTX = {
    set(on, level = preset) { enabled = !!on; preset = level === 'high' ? 'high' : 'performance'; update(); return this.status(); },
    status() { return { ...report, enabled: mode() > 0, quality: preset, mode: mode(),
      programs: Array.from(programs.values()).map(p=>p.kind) }; }
  };
  update();

  // `cls.key_dest` for the frame being drawn. The engine does not clear
  // between menu frames, so a frame's clear is not a reliable sampler; this
  // re-reads at most every 100 ms. The state is a single word in the engine's
  // memory, so the read is cheap, and a menu that opens or closes is never
  // more than a tenth of a second from being seen.
  let keyDestSampledAt = -Infinity;
  function readKeyDest() {
    try {
      const state = window.quake2Engine && window.quake2Engine.read ? window.quake2Engine.read() : null;
      return state && typeof state.keyDest === 'number' ? state.keyDest : 0;
    } catch (_) { return 0; }
  }
  function keyDestNow() {
    const now = performance.now();
    if (now - keyDestSampledAt >= 100) {
      keyDestSampledAt = now;
      frameKeyDest = readKeyDest();
    }
    return frameKeyDest;
  }

  // -------------------------------------------------------------------------
  // The live HUD numbers. The engine draws health, armour and ammo with its own
  // digit pictures (`pics/num_*.pcx` and `pics/anum_*.pcx`) and exposes no way
  // to read them: there is no console command and this build exports no cvar or
  // command accessor. The dark interface needs the values, so this reads the
  // status bar back out of the framebuffer and recognises the engine's own
  // glyphs -- the same technique control/hud.mjs uses for its screenshots,
  // here on the canvas itself.
  //
  // The glyphs are read from the game's own archive, handed over by app.js
  // before it drops the pak buffers. Nothing is embedded: the font the reader
  // matches is the font the engine draws.
  // -------------------------------------------------------------------------
  const HUD_CELL = { width: 15, height: 23 }; // the digit pictures' own size
  // Q2 draws health right-aligned in a fixed field; measured on this build the
  // number ends at this fraction of the canvas width (control/hud.mjs carries
  // the same measurement for its screenshots). It is only used to tell the
  // health number from the others when the bar carries more than one.
  const HEALTH_FIELD = 573 / 1366;
  const HUD_MIN_SCORE = 0.62;
  const hud = {
    families: null,
    fields: null, // { health: {right}, armour: {right}, ammo: {right} }
    last: { health: null, armour: null, ammo: null, readAt: null },
    reads: 0, misses: 0, lastError: null,
  };

  function pakEntries(buffer) {
    if (!buffer || buffer.length < 12) return new Map();
    const dv = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
    const directory = dv.getUint32(4, true);
    const length = Math.min(dv.getUint32(8, true), buffer.length - directory);
    const entries = new Map();
    for (let at = directory; at + 64 <= directory + length; at += 64) {
      let end = at;
      while (end < at + 56 && buffer[end] !== 0) end++;
      const name = new TextDecoder('latin1').decode(buffer.subarray(at, end)).toLowerCase();
      const offset = dv.getUint32(at + 56, true);
      const size = dv.getUint32(at + 60, true);
      if (name && offset + size <= buffer.length) entries.set(name, buffer.subarray(offset, offset + size));
    }
    return entries;
  }

  // One 8-bit PCX picture: header, RLE rows padded to bytesPerLine, and a
  // palette at the end. The glyph's ink is every index that is neither the
  // transparent index (255) nor the picture's own background, which is the most
  // common remaining index -- exactly the pixels the engine blits.
  function decodePcx(bytes) {
    const width = bytes[8] | (bytes[9] << 8);
    const height = bytes[10] | (bytes[11] << 8);
    const bytesPerLine = bytes[66] | (bytes[67] << 8);
    if (!width || !height || !bytesPerLine) return null;
    const total = bytesPerLine * height;
    const raw = new Uint8Array(total);
    let at = 128, n = 0;
    while (n < total && at < bytes.length) {
      let value = bytes[at++];
      if ((value & 0xC0) === 0xC0) {
        const run = value & 0x3F;
        value = bytes[at++];
        for (let k = 0; k < run && n < total; k++) raw[n++] = value;
      } else raw[n++] = value;
    }
    const histogram = new Map();
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      const value = raw[y * bytesPerLine + x];
      histogram.set(value, (histogram.get(value) || 0) + 1);
    }
    let background = 0, seen = -1;
    for (const [value, count] of histogram) {
      if (value === 255) continue;
      if (count > seen) { seen = count; background = value; }
    }
    const mask = new Uint8Array(width * height);
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      const value = raw[y * bytesPerLine + x];
      mask[y * width + x] = value !== 255 && value !== background ? 1 : 0;
    }
    return { width, height, mask };
  }

  // A glyph's half of a normalised cross-correlation, computed once.
  function prepareGlyph(glyph) {
    const n = glyph.width * glyph.height;
    const centred = new Float32Array(n);
    let shapeMean = 0;
    for (let i = 0; i < n; i++) shapeMean += 2 * glyph.mask[i] - 1;
    shapeMean /= n;
    let variance = 0;
    for (let i = 0; i < n; i++) {
      const value = 2 * glyph.mask[i] - 1 - shapeMean;
      centred[i] = value;
      variance += value * value;
    }
    return { width: glyph.width, height: glyph.height, centred, variance };
  }

  // Normalised cross-correlation of one glyph with the picture at (x0, y0):
  // 1 is exactly this digit, 0 unrelated, negative ink where the glyph has
  // gaps. Brightness cancels, so the same digit reads on a dark or a lit wall.
  function correlate(template, lum, width, x0, y0) {
    const { width: tw, height: th, centred, variance } = template;
    const n = tw * th;
    let mean = 0;
    for (let y = 0; y < th; y++) {
      const row = (y0 + y) * width + x0;
      for (let x = 0; x < tw; x++) mean += lum[row + x];
    }
    mean /= n;
    let covariance = 0, imageVariance = 0;
    for (let y = 0; y < th; y++) {
      const row = (y0 + y) * width + x0;
      const shapeRow = y * tw;
      for (let x = 0; x < tw; x++) {
        const delta = lum[row + x] - mean;
        covariance += centred[shapeRow + x] * delta;
        imageVariance += delta * delta;
      }
    }
    const denominator = Math.sqrt(variance * imageVariance);
    return denominator ? covariance / denominator : 0;
  }

  function bestDigit(templates, lum, width, x0, y0) {
    let best = -2, second = -2, digit = -1;
    for (let d = 0; d < templates.length; d++) {
      const score = correlate(templates[d], lum, width, x0, y0);
      if (score > best) { second = best; best = score; digit = d; }
      else if (score > second) second = score;
    }
    return { digit, score: best, margin: best - second };
  }

  function readGlyphFamilies(paks) {
    let pak = null;
    for (const name of ['pak0.pak', 'baseq2/pak0.pak']) if (paks && paks[name]) pak = paks[name];
    if (!pak) return null;
    const entries = pakEntries(pak);
    const families = {};
    for (const family of ['num', 'anum']) {
      const glyphs = [];
      for (let digit = 0; digit < 10; digit++) {
        const bytes = entries.get('pics/' + family + '_' + digit + '.pcx');
        const glyph = bytes ? decodePcx(bytes) : null;
        glyphs.push(glyph ? prepareGlyph(glyph) : null);
      }
      if (glyphs.every(Boolean) && glyphs[0].width === HUD_CELL.width && glyphs[0].height === HUD_CELL.height) {
        families[family] = glyphs;
      }
    }
    return families.num && families.anum ? families : null;
  }

  // One number, grown leftwards from the cell whose right edge sits on the
  // field's measured edge.
  function readField(lum, width, rows, rightEdge, family) {
    const templates = hud.families[family];
    if (!templates) return null;
    const cellWidth = HUD_CELL.width, cellHeight = HUD_CELL.height;
    if (rows < cellHeight) return null;
    const digitRows = [rows - cellHeight, rows - cellHeight - 1, rows - cellHeight - 2, rows - cellHeight + 1]
      .filter((y) => y >= 0 && y + cellHeight <= rows);
    let anchor = null;
    for (const y of digitRows) {
      for (let dx = -2; dx <= 2; dx++) {
        const x = rightEdge - cellWidth + dx;
        if (x < 0 || x + cellWidth > width) continue;
        const cell = bestDigit(templates, lum, width, x, y);
        if (cell.score < HUD_MIN_SCORE || cell.digit < 0) continue;
        if (!anchor || cell.score > anchor.score) anchor = { ...cell, x, y };
      }
    }
    if (!anchor) return null;
    const run = [{ digit: anchor.digit, x: anchor.x, y: anchor.y, score: anchor.score }];
    let edgeX = anchor.x;
    for (let k = 0; k < 4; k++) {
      // The next cell's left edge is one glyph to the left, but the engine's
      // blit and this picture can disagree by a pixel: search a couple each way
      // and take the best, the same way the anchor was found.
      let next = null;
      for (let dx = -2; dx <= 2; dx++) {
        const x = edgeX - cellWidth + dx;
        if (x < 0) continue;
        for (let dy = -1; dy <= 1; dy++) {
          const y = anchor.y + dy;
          if (y < 0 || y + cellHeight > rows) continue;
          const cell = bestDigit(templates, lum, width, x, y);
          if (cell.digit >= 0 && cell.score >= HUD_MIN_SCORE && (!next || cell.score > next.score)) next = { ...cell, x, y };
        }
      }
      if (!next) break;
      run.unshift(next);
      edgeX = next.x;
    }
    const digits = run.map((cell) => cell.digit).join('');
    const value = Number(digits);
    if (!Number.isFinite(value)) return null;
    return { value, digits, x: edgeX, right: anchor.x + cellWidth, y: anchor.y,
      score: Math.min(...run.map((cell) => cell.score)) };
  }

  // The whole bar, found from scratch: strongly-read cells grouped into
  // numbers. Used to learn the three fields once; after that each read looks
  // only where the fields were found, which is a fraction of the work.
  // The rows the digits can start on. The engine puts them in the canvas's
  // bottom 23 rows; which of those rows is the top edge depends on the display,
  // so all of them near the bottom are tried and the best score wins.
  function digitRowCandidates(rows) {
    const cellHeight = HUD_CELL.height;
    return [rows - cellHeight, rows - cellHeight - 1, rows - cellHeight + 1, rows - cellHeight - 2]
      .filter((y) => y >= 0 && y + cellHeight <= rows);
  }

  // Grow one number from an anchor cell: the cell one glyph to the left (and
  // right), searched a couple of pixels either way because the engine's blit
  // and this picture can disagree by one.
  function growRun(templates, lum, width, rows, anchor, direction) {
    const cellWidth = HUD_CELL.width, cellHeight = HUD_CELL.height;
    let edge = { x: anchor.x, y: anchor.y };
    const run = [];
    for (let k = 0; k < 4; k++) {
      let next = null;
      const base = edge.x + direction * cellWidth;
      for (let dx = -2; dx <= 2; dx++) {
        const x = base + dx;
        if (x < 0 || x + cellWidth > width) continue;
        for (let dy = -1; dy <= 1; dy++) {
          const y = edge.y + dy;
          if (y < 0 || y + cellHeight > rows) continue;
          const cell = bestDigit(templates, lum, width, x, y);
          if (cell.digit >= 0 && cell.score >= HUD_MIN_SCORE && (!next || cell.score > next.score)) next = { ...cell, x, y };
        }
      }
      if (!next) break;
      run.push({ digit: next.digit, x: next.x, y: next.y, score: next.score });
      edge = { x: next.x, y: next.y };
    }
    return run;
  }

  // The whole bar, found from scratch: the most confident glyph cells first,
  // each grown into a number, so a stray shape that happens to match a digit
  // (there is a lot of textured floor under the bar) cannot take the place of
  // the engine's own digits.
  function findNumbers(lum, width, rows) {
    const cellWidth = HUD_CELL.width;
    // Every row the digits can start on: a one-pixel row or column offset
    // costs a real glyph a third of its score (measured), and a from-scratch
    // find runs only every sixteenth read, so the thorough scan is affordable.
    const rowCandidates = digitRowCandidates(rows);
    if (!rowCandidates.length) return [];
    const anchors = [];
    for (let x = 0; x + cellWidth <= width; x++) {
      let cell = null;
      for (const y of rowCandidates) {
        const candidate = bestDigit(hud.families.num, lum, width, x, y);
        if (candidate.digit >= 0 && (!cell || candidate.score > cell.score)) cell = { ...candidate, y };
      }
      if (cell && cell.score >= 0.8) anchors.push({ ...cell, x });
    }
    anchors.sort((a, b) => b.score - a.score);
    const covered = new Uint8Array(width);
    const numbers = [];
    for (const anchor of anchors) {
      if (covered[anchor.x]) continue;
      const left = growRun(hud.families.num, lum, width, rows, anchor, -1).reverse();
      const right = growRun(hud.families.num, lum, width, rows, anchor, 1);
      const run = [...left, { digit: anchor.digit, x: anchor.x, y: anchor.y, score: anchor.score }, ...right];
      const digits = run.map((cell) => cell.digit).join('');
      const value = Number(digits);
      if (!Number.isFinite(value)) continue;
      const first = run[0], last = run[run.length - 1];
      const rightEdge = last.x + cellWidth;
      for (let x = first.x - 2; x < rightEdge + 2; x++) if (x >= 0 && x < width) covered[x] = 1;
      numbers.push({ value, family: 'num', x: first.x, right: rightEdge, y: first.y, digits,
        score: Math.min(...run.map((cell) => cell.score)) });
    }
    numbers.sort((a, b) => a.x - b.x);
    return numbers;
  }

  // The strip's pixels as a luminance plane in screen order (row 0 is the
  // top of the band). `x0` lets a field be read from a narrow slice: a
  // readPixels of the whole canvas width is cheap, but on the software
  // renderer this page is measured on even that adds up every second, and a
  // field only ever occupies a few cells.
  function readLuminance(x0, width, rows) {
    const pixels = new Uint8Array(width * rows * 4);
    gl.readPixels(x0, 0, width, rows, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
    const lum = new Float32Array(width * rows);
    for (let y = 0; y < rows; y++) {
      const source = rows - 1 - y;
      for (let x = 0; x < width; x++) {
        const at = (source * width + x) * 4;
        lum[y * width + x] = 0.2126 * pixels[at] + 0.7152 * pixels[at + 1] + 0.0722 * pixels[at + 2];
      }
    }
    return lum;
  }

  // One cached field, read from a slice just wide enough for its digits.
  function readCachedField(field, family) {
    const width = gl.drawingBufferWidth, rows = Math.min(30, gl.drawingBufferHeight);
    const cellWidth = HUD_CELL.width;
    const sliceWidth = Math.min(width, cellWidth * 6 + 8);
    const x0 = Math.max(0, Math.min(width - sliceWidth, field.right - sliceWidth + 4));
    const lum = readLuminance(x0, sliceWidth, rows);
    return readField(lum, sliceWidth, rows, field.right - x0, family);
  }

  function readStatusBar() {
    if (!gl || !hud.families) return null;
    if (typeof document !== 'undefined' && document.hidden) return null;
    const width = gl.drawingBufferWidth, height = gl.drawingBufferHeight;
    if (!width || !height || height < HUD_CELL.height) return null;
    const rows = Math.min(30, height);
    // Every so often the fields are found from scratch: a number that was not
    // on the bar before (the ammo count, once a weapon with ammo is in hand)
    // has to be discovered, and its field is not known until it is.
    const discover = !hud.fields || hud.reads % 16 === 0;
    let numbers = [];
    if (!discover) {
      for (const key of ['health', 'armour', 'ammo']) {
        const field = hud.fields[key];
        if (!field) continue;
        const read = readCachedField(field, key === 'health' ? 'num' : 'anum');
        if (read) numbers.push({ key, ...read });
      }
    }
    if (!numbers.length || discover) {
      numbers = [];
      // First read, or the layout moved: find every number on the bar and
      // assign the fields by where they end.
      const lum = readLuminance(0, width, rows);
      const found = findNumbers(lum, width, rows);
      if (found.length) {
        found.sort((a, b) => a.right - b.right);
        // The health number is the one that ends on the health field; the
        // rightmost other number is the ammo, and anything between them is the
        // armour. With a single number there is only health to report -- the
        // blaster shows no ammo count at all -- so nothing is invented for the
        // other two fields.
        let health = found[0];
        let bestDistance = Infinity;
        for (const one of found) {
          const distance = Math.abs(one.right - width * HEALTH_FIELD);
          if (distance < bestDistance) { bestDistance = distance; health = one; }
        }
        const others = found.filter((one) => one !== health);
        const ammo = others.length ? others[others.length - 1] : null;
        const between = others.filter((one) => one !== ammo);
        const armour = between.length ? between[between.length - 1] : null;
        const fields = { health: { right: health.right } };
        if (armour) fields.armour = { right: armour.right };
        if (ammo) fields.ammo = { right: ammo.right };
        hud.fields = fields;
        numbers = [{ key: 'health', ...health }, ...(armour ? [{ key: 'armour', ...armour }] : []), ...(ammo ? [{ key: 'ammo', ...ammo }] : [])];
      }
    }
    if (!numbers.length) { hud.misses++; return null; }
    const next = { health: null, armour: null, ammo: null, readAt: new Date().toISOString() };
    for (const number of numbers) next[number.key] = number.value;
    hud.last = next;
    hud.reads++;
    try {
      window.dispatchEvent(new CustomEvent('quake2hud', { detail: next }));
    } catch (_) { /* no CustomEvent on an ancient page */ }
    return next;
  }

  // The status bar is read inside the engine's own frame, not from a timer:
  // this build runs with `preserveDrawingBuffer` off (measured: forcing it on
  // dropped the box's software renderer from ~3 fps to ~0.25 fps, so it is not
  // worth it), and the browser clears the canvas as soon as it composites. A
  // read scheduled from inside a drawn frame runs at the start of the next
  // frame, after the engine has drawn it and before the compositor takes the
  // buffer away -- the same window control/hud.mjs uses for its screenshots.
  let hudReadPending = false;
  let hudLastRead = 0;
  function scheduleHudReads() {
    // nothing to schedule up front: reads are armed by drawn frames
  }
  function armHudRead() {
    if (!hud.families) return;
    const now = performance.now();
    if (hudReadPending || now - hudLastRead < 1200) return;
    hudReadPending = true;
    // Queue the read for the *next* frame, after the engine's callback has run
    // (and registered its own next frame), so the read lands after the next
    // draw and before the compositor clears the buffer -- the ordering
    // control/hud.mjs relies on. A timer leaves the engine's callback first;
    // an animation callback registered inside the draw runs too early.
    setTimeout(() => {
      requestAnimationFrame(() => {
        hudReadPending = false;
        hudLastRead = performance.now();
        try {
          if (keyDestNow() !== 0) return;
          readStatusBar();
        } catch (error) {
          hud.lastError = String(error && error.message ? error.message : error);
        }
      });
    }, 0);
  }
  window.quake2Hud = {
    // Handed the pak buffers app.js downloaded, before it frees them.
    usePaks(paks) {
      try {
        hud.families = readGlyphFamilies(paks || {});
      } catch (error) {
        hud.lastError = String(error && error.message ? error.message : error);
        hud.families = null;
      }
      if (hud.families) scheduleHudReads();
      return Boolean(hud.families);
    },
    read() { return { ...hud.last, fields: hud.fields, reads: hud.reads, misses: hud.misses, error: hud.lastError, ready: Boolean(hud.families) }; },
    readNow() { try { return readStatusBar(); } catch (error) { hud.lastError = String(error); return null; } },
    // Forget the bar's fields so the next read finds every number from
    // scratch. The HUD does this on its own every sixteenth read; this is for
    // a caller that has just changed what the bar shows (a weapon with ammo,
    // given through the console) and does not want to wait for that pass.
    rediscover() { hud.fields = null; hud.reads = 0; return true; },
    // The incremental read for one field, for diagnosing a wrong value.
    fieldRead(right, family) {
      try {
        if (!gl || !hud.families) return null;
        const width = gl.drawingBufferWidth, rows = Math.min(30, gl.drawingBufferHeight);
        const pixels = new Uint8Array(width * rows * 4);
        gl.readPixels(0, 0, width, rows, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
        const lum = new Float32Array(width * rows);
        for (let r = 0; r < rows; r++) {
          const source = rows - 1 - r;
          for (let c = 0; c < width; c++) {
            const at = (source * width + c) * 4;
            lum[r * width + c] = 0.2126 * pixels[at] + 0.7152 * pixels[at + 1] + 0.0722 * pixels[at + 2];
          }
        }
        return readField(lum, width, rows, right, family || 'num');
      } catch (error) { return { error: String(error) }; }
    },
    // Every number the from-scratch finder sees, with its digits and edges.
    find() {
      try {
        if (!gl || !hud.families) return null;
        const width = gl.drawingBufferWidth, rows = Math.min(30, gl.drawingBufferHeight);
        const pixels = new Uint8Array(width * rows * 4);
        gl.readPixels(0, 0, width, rows, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
        const lum = new Float32Array(width * rows);
        for (let r = 0; r < rows; r++) {
          const source = rows - 1 - r;
          for (let c = 0; c < width; c++) {
            const at = (source * width + c) * 4;
            lum[r * width + c] = 0.2126 * pixels[at] + 0.7152 * pixels[at + 1] + 0.0722 * pixels[at + 2];
          }
        }
        return findNumbers(lum, width, rows);
      } catch (error) { return { error: String(error) }; }
    },
    // The best digit each family scores at one cell of the strip, for
    // diagnosing a bar that does not read.
    cell(x, y) {
      try {
        if (!gl || !hud.families) return null;
        const width = gl.drawingBufferWidth, rows = Math.min(30, gl.drawingBufferHeight);
        const pixels = new Uint8Array(width * rows * 4);
        gl.readPixels(0, 0, width, rows, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
        const lum = new Float32Array(width * rows);
        for (let r = 0; r < rows; r++) {
          const source = rows - 1 - r;
          for (let c = 0; c < width; c++) {
            const at = (source * width + c) * 4;
            lum[r * width + c] = 0.2126 * pixels[at] + 0.7152 * pixels[at + 1] + 0.0722 * pixels[at + 2];
          }
        }
        const out = {};
        for (const family of ['num', 'anum']) out[family] = bestDigit(hud.families[family], lum, width, x, y);
        return out;
      } catch (error) { return { error: String(error) }; }
    },
    // A coarse picture of the strip the reader sees: counts, luminance range
    // and an 80x14 map, so a display where the digits do not read can be
    // diagnosed without a screenshot.
    debugStrip() {
      try {
        if (!gl) return null;
        const width = gl.drawingBufferWidth, rows = Math.min(30, gl.drawingBufferHeight);
        const pixels = new Uint8Array(width * rows * 4);
        gl.readPixels(0, 0, width, rows, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
        let min = 255, max = 0, sum = 0, ink = 0;
        const lum = new Float32Array(width * rows);
        for (let y = 0; y < rows; y++) {
          const source = rows - 1 - y;
          for (let x = 0; x < width; x++) {
            const at = (source * width + x) * 4;
            const value = 0.2126 * pixels[at] + 0.7152 * pixels[at + 1] + 0.0722 * pixels[at + 2];
            lum[y * width + x] = value;
            min = Math.min(min, value); max = Math.max(max, value); sum += value;
            if (value > 24) ink++;
          }
        }
        const map = [];
        for (let ry = 0; ry < 14; ry++) {
          let line = '';
          for (let rx = 0; rx < 80; rx++) {
            const x = Math.floor(rx * width / 80), y = Math.floor(ry * rows / 14);
            line += lum[y * width + x] > 32 ? '#' : (lum[y * width + x] > 12 ? '+' : '.');
          }
          map.push(line);
        }
        return { width, rows, min: Math.round(min), max: Math.round(max), mean: Math.round(sum / (width * rows)), ink, map,
          ready: Boolean(hud.families), fields: hud.fields, preserve: gl.getContextAttributes() ? gl.getContextAttributes().preserveDrawingBuffer : null };
      } catch (error) { return { error: String(error) }; }
    },
  };

  // -------------------------------------------------------------------------
  // World surfaces. The engine hands us the sampled albedo and the baked
  // lightmap (which already contains the dynamic lights), so everything below
  // redistributes that existing energy: it adds no shadow, light or geometry.
  // -------------------------------------------------------------------------
  const worldFunctions = `
uniform float q2RTX;
uniform vec4 q2Material; // specular strength, roughness, fixture emission, relief
in vec3 q2ViewDirection;
float q2Luma(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }
vec3 q2Surface(vec3 albedo, vec3 illumination) {
  vec3 n = normalize(passNormal);
  vec3 v = normalize(q2ViewDirection);
  float h = q2Luma(albedo);
  // Surface gradient in world space, from real world/UV derivatives. Height is
  // inferred from albedo, not a supplied normal map or geometric displacement.
  vec3 dp1 = dFdx(passWorldCoord), dp2 = dFdy(passWorldCoord);
  vec3 r1 = cross(dp2, n), r2 = cross(n, dp1);
  float det = dot(dp1, r1);
  vec3 gradient = (r1 * dFdx(h) + r2 * dFdy(h)) / max(abs(det), 0.0001) * sign(det);
  float relief = 0.50 + 0.85 * q2Material.w;
  n = normalize(n - clamp(gradient * relief, vec3(-0.20), vec3(0.20)));
  vec3 l = normalize(vec3(-0.35, -0.45, 0.82));
  float roughness = clamp(q2Material.y + (0.5-h)*0.22, 0.16, 1.0);
  // Two lobes: a tight dielectric glint plus a broad, rougher sheen. The mix is
  // what makes rough metal read as metal instead of as a flat bright wash.
  vec3 halfVector = normalize(l+v);
  float nDotH = max(dot(n, halfVector), 0.0);
  float tight = pow(nDotH, mix(96.0, 7.0, roughness));
  float broad = pow(nDotH, mix(28.0, 3.0, roughness));
  float spec = mix(tight, broad, roughness * 0.55);
  float fresnel = 0.10 + 0.90 * pow(1.0-max(dot(n,v),0.0), 5.0);
  float light = clamp(q2Luma(illumination), 0.0, 1.6);
  // Quake's world up is +Z, so a normal's Z component separates the cool sky
  // side of a surface from the warm floor-bounce side. This is a hemisphere
  // term from the existing baked light energy, not new light or a shadow.
  float up = clamp(n.z * 0.5 + 0.5, 0.0, 1.0);
  vec3 ambientTint = mix(vec3(0.98,0.91,0.85), vec3(0.80,0.88,1.03), up);
  // Art-directed broad key reflection, bounded by existing baked light energy.
  // The lightmaps contain no incident direction or environment reflections.
  vec3 lit = albedo * illumination * (0.87 + 0.21*max(dot(n,l),0.0));
  lit *= ambientTint * (1.0 + 0.10*(up-0.5));
  vec3 tint = mix(vec3(0.80,0.88,1.0), max(albedo,vec3(0.3)), 0.35);
  lit += tint * q2Material.x * light * (spec*1.10 + fresnel*0.20);
  // Actual engine dynamic lights contribute view-dependent highlights too.
  if (q2RTX > 1.5 && passLightFlags != 0u) {
    for (uint i=0u; i<numDynLights; ++i) {
      if ((passLightFlags & (1u << i)) == 0u) continue;
      vec3 d = dynLights[i].lightOrigin-passWorldCoord;
      float attenuation = max(0.0,dynLights[i].lightColor.a-length(d)-52.0)/256.0;
      vec3 hd = normalize(normalize(d)+v);
      float highlight = mix(pow(max(dot(n,hd),0.0),mix(96.0,7.0,roughness)),
                            pow(max(dot(n,hd),0.0),mix(28.0,3.0,roughness)), roughness*0.55);
      lit += dynLights[i].lightColor.rgb * attenuation * highlight * q2Material.x * 0.7;
    }
  }
  // Fixtures burn from their own bright pixels. High quality pushes the core
  // harder and lets the composite bloom carry it further; nothing casts light.
  float emitter = q2Material.z * smoothstep(0.45,0.86,h/max(intensity,0.01));
  vec3 emitterColor = max(albedo, vec3(0.55)) * (q2RTX > 1.5 ? 3.1 : 2.5);
  lit = mix(lit, max(lit, emitterColor), emitter);
  // Aerial perspective: distant surfaces lose a little contrast into a haze
  // tinted by their own baked light, so depth reads and far walls separate.
  // Near geometry is untouched; High carries about three times Performance's
  // haze, which is part of what makes the two presets read differently.
  float viewDistance = length(q2ViewDirection);
  float haze = smoothstep(620.0, 2500.0, viewDistance) * (q2RTX > 1.5 ? 0.30 : 0.10);
  vec3 hazeColor = vec3(0.055,0.070,0.095) + illumination * 0.30;
  lit = mix(lit, hazeColor, haze);
  // Gentle highlight shoulder before the LDR framebuffer clips; no black crush.
  return lit / (vec3(1.0) + max(lit-vec3(0.75),vec3(0.0))*0.45);
}
`;
  // -------------------------------------------------------------------------
  // The composite. It grades the finished scene before the engine draws the
  // HUD, so text and menus stay pixel-crisp and unbloomed.
  // -------------------------------------------------------------------------
  const postFunctions = `
uniform float q2RTX;
vec3 q2Bright(vec2 uv, float threshold) {
  vec3 c = texture(tex,clamp(uv,vec2(0.001),vec2(0.999))).rgb;
  return c * smoothstep(threshold,threshold+0.26,max(c.r,max(c.g,c.b)));
}
vec3 q2Finish(vec3 c, vec2 uv) {
  vec2 px = 1.0/vec2(textureSize(tex,0));
  vec3 glow = vec3(0.0);
  if (q2RTX > 1.5) {
    // High: a wide twelve-tap halo for lamps plus a tight six-tap core, so the
    // fixture itself stays hot while its spill reaches further than one disc.
    // HUD is drawn after this pass and is not bloomed.
    for (int i=0; i<12; ++i) {
      float a = float(i)*2.39996323;
      vec2 offset = vec2(cos(a),sin(a))*sqrt((float(i)+0.5)/12.0)*16.0*px;
      glow += q2Bright(uv+offset,0.58);
    }
    glow /= 12.0;
    for (int i=0; i<6; ++i) {
      float a = float(i)*2.39996323 + 0.7;
      vec2 offset = vec2(cos(a),sin(a))*sqrt((float(i)+0.5)/6.0)*4.0*px;
      glow += q2Bright(uv+offset,0.66)*0.5;
    }
    glow /= 1.5;
  } else {
    // Performance: two horizontal taps, the cheap fallback measured to hold the
    // frame budget on this device.
    glow = (q2Bright(uv+vec2(5,0)*px,0.68)+q2Bright(uv-vec2(5,0)*px,0.68))*0.5;
  }
  float y = dot(c,vec3(0.2126,0.7152,0.0722));
  // Cool shadow / warm light split, with a small lifted toe for dark corners.
  c *= mix(vec3(0.86,0.97,1.12),vec3(1.08,1.03,0.94),smoothstep(0.10,0.85,y));
  c = mix(vec3(y),c,1.12);
  c = c*0.98 + vec3(0.012,0.015,0.02)*(1.0-smoothstep(0.0,0.30,y));
  // High gains a very light corner falloff (no more than 6% at the corners) to
  // pull the eye to the centre; Performance leaves the frame flat.
  if (q2RTX > 1.5) {
    vec2 q = uv-0.5;
    c *= mix(0.94,1.0,clamp(1.0-dot(q,q)*1.1,0.0,1.0));
  }
  c = clamp(c + glow*0.24*(1.0-c),0.0,1.0);
  // Half-level dither: the grade and lifted toe otherwise band in dark
  // corridors and across a large sky on an 8-bit framebuffer.
  float q2noise = fract(52.9829189*fract(dot(gl_FragCoord.xy,vec2(0.06711056,0.00583715))));
  float dither = (q2noise-0.5)/255.0;
  return clamp(c+dither,0.0,1.0);
}
`;
  // -------------------------------------------------------------------------
  // The demo's sky is drawn by the engine as a flat two-dimensional fill (its
  // skybox files never load in this build), so a gradient has to be added to
  // that fill rather than to a lit 3D surface. The gradient is screen-vertical
  // and derived from the fill's own colour: it adds no texture and no light.
  // -------------------------------------------------------------------------
  const skyFunctions = `
uniform float q2RTX;
uniform float q2Sky;
uniform vec2 q2SkyViewport;
vec3 q2SkyTint(vec3 col) {
  if (q2RTX < 0.5 || q2Sky < 0.5) return col;
  float h = clamp(gl_FragCoord.y * q2SkyViewport.y, 0.0, 1.0);
  float zenith = smoothstep(0.30, 1.0, h);
  float horizon = 1.0 - smoothstep(0.0, 0.55, h);
  // Deeper, cooler overhead; a touch warmer and brighter at the horizon.
  col *= mix(1.16, 0.82, zenith);
  col += vec3(0.020, 0.026, 0.044) * zenith;
  float l = dot(col, vec3(0.299, 0.587, 0.114));
  col = mix(col, vec3(l), 0.12 * zenith);
  col += vec3(0.018, 0.010, 0.0) * horizon * 0.6;
  return max(col, vec3(0.0));
}
`;
  // -------------------------------------------------------------------------
  // Textured models and the view weapon. The engine lights them by one vertex
  // colour, so they read flat; the world space normal and eye position below
  // let a small key-shape and a cool rim give them volume and a metal sheen.
  // -------------------------------------------------------------------------
  const modelFunctions = `
uniform float q2RTX;
uniform vec4 q2Material;
in vec3 q2ModelNormal;
in vec3 q2ModelPos;
in vec3 q2ModelEye;
vec3 q2ModelShade(vec3 rgb) {
  if (q2RTX < 0.5) return rgb;
  vec3 n = normalize(q2ModelNormal);
  vec3 v = normalize(q2ModelEye - q2ModelPos);
  vec3 key = normalize(vec3(-0.35, -0.45, 0.82));
  float lambert = max(dot(n, key), 0.0);
  float rim = pow(1.0 - max(dot(n, v), 0.0), 3.0);
  vec3 halfVector = normalize(key + v);
  float spec = pow(max(dot(n, halfVector), 0.0), mix(72.0, 8.0, q2Material.y));
  vec3 sheen = mix(vec3(0.78,0.87,1.0), max(rgb, vec3(0.25)), 0.35);
  rgb *= 0.90 + 0.12 * lambert;
  rgb += sheen * (rim * 0.14 + spec * 0.22) * q2Material.x;
  return rgb;
}
`;
  // q2ModelShade: the shader the engine draws every MD2 model with (weapons,
  // enemies, items) supplies only a texture and a transform -- no normal, no
  // light. The relief it paints has to come from the albedo itself, so this
  // derives a tangent-space normal from the skin's own luminance gradient,
  // adds a key-lit relief term and a restrained painted-metal sheen, then
  // leaves the engine's gamma and alpha path untouched. Gated by q2Model, which
  // is 0 whenever the raster look is off, so Off restores the original shader.
  const modelReliefFunctions = `
uniform float q2Model;
vec3 q2ModelShade(vec3 albedo, vec2 uv) {
  float h = dot(albedo, vec3(0.2126, 0.7152, 0.0722));
  // Texture gradient -> a bump normal in the skin's own tangent frame. The
  // clamp keeps a hard texel edge from becoming a spike, and the tilt is
  // deliberately small: the derivative is taken per 2x2 quad, so a texture
  // seam (a UV discontinuity inside the quad) and a painted outline both make
  // it huge, and a big tilt turns every seam into a grey line down the model.
  // Relief is a hint here, not a silhouette.
  float dhx = clamp(dFdx(h), -0.12, 0.12);
  float dhy = clamp(dFdy(h), -0.12, 0.12);
  vec3 n = normalize(vec3(-dhx * 1.1, -dhy * 1.1, 1.0));
  vec3 l = normalize(vec3(-0.42, -0.55, 0.72));
  float diff = max(dot(n, l), 0.0);
  float spec = pow(max(dot(reflect(-l, n), vec3(0.0, 0.0, 1.0)), 0.0), 26.0);
  float lum = clamp(h * 1.8, 0.0, 1.0);
  vec3 tint = mix(vec3(0.74, 0.82, 1.0), vec3(1.08, 0.99, 0.84), lum);
  albedo *= 0.94 + 0.12 * diff;
  albedo += tint * spec * (0.04 + 0.10 * lum);
  return albedo;
}
`;
  function transform(source, type) {
    if (type === gl.VERTEX_SHADER && source.includes('passWorldCoord = worldCoord.xyz;') && source.includes('passNormal')) {
      source = source.replace('void main()', 'out vec3 q2ViewDirection;\nvoid main()');
      return { kind: 'vertex', source: source.replace('passWorldCoord = worldCoord.xyz;',
        'passWorldCoord = worldCoord.xyz; vec4 q2Eye = inverse(transProjView)*vec4(0.0,0.0,-1.0,1.0); q2ViewDirection = q2Eye.xyz/q2Eye.w-worldCoord.xyz;') };
    }
    if (type === gl.FRAGMENT_SHADER && source.includes('outColor = lmTex*texel;') && source.includes('passWorldCoord')) {
      return { kind: 'world', source: source.replace('void main()', worldFunctions+'\nvoid main()')
        .replace('outColor = lmTex*texel;', 'outColor = lmTex*texel; if (q2RTX > 0.5) outColor.rgb = q2Surface(texel.rgb,lmTex.rgb);') };
    }
    if (type === gl.FRAGMENT_SHADER && source.includes('outColor.a = texel.a*alpha;')
        && source.includes('outColor.rgb = pow(texel.rgb, vec3(gamma));') && !source.includes('lightmap') && !source.includes('passColor')) {
      return { kind: 'modelRelief', source: source.replace('void main()', modelReliefFunctions + '\nvoid main()')
        .replace('outColor.rgb = pow(texel.rgb, vec3(gamma));',
          'if (q2Model > 0.5) texel.rgb = q2ModelShade(texel.rgb, passTexCoord); outColor.rgb = pow(texel.rgb, vec3(gamma));') };
    }
    if (type === gl.FRAGMENT_SHADER && source.includes('uniform vec4 v_blend;') && source.includes('outColor = res;')) {
      const uv = source.includes('vec2 uv =') ? 'uv' : 'passTexCoord';
      return { kind: 'post', source: source.replace('void main()', postFunctions+'\nvoid main()')
        .replace('res.rgb = v_blend.a', `if (q2RTX > 0.5) res.rgb = q2Finish(res.rgb,${uv}); res.rgb = v_blend.a`) };
    }
    if (type === gl.FRAGMENT_SHADER && source.includes('vec3 col = color.rgb * intensity2D;')) {
      return { kind: 'sky', source: source.replace('void main()', skyFunctions+'\nvoid main()')
        .replace('vec3 col = color.rgb * intensity2D;', 'vec3 col = q2SkyTint(color.rgb * intensity2D);') };
    }
    if (type === gl.VERTEX_SHADER && source.includes('passColor = vertColor*overbrightbits;') && source.includes('void main()')) {
      return { kind: 'modelVertex', source: source.replace('void main()', 'out vec3 q2ModelNormal;\nout vec3 q2ModelPos;\nout vec3 q2ModelEye;\nvoid main()')
        .replace('passColor = vertColor*overbrightbits;',
          'passColor = vertColor*overbrightbits; vec4 q2World = transModel*vec4(position, 1.0); q2ModelNormal = normalize((transModel*vec4(normal, 0.0)).xyz); q2ModelPos = q2World.xyz; vec4 q2Eye = inverse(transProjView)*vec4(0.0,0.0,-1.0,1.0); q2ModelEye = q2Eye.xyz/q2Eye.w;') };
    }
    if (type === gl.FRAGMENT_SHADER && source.includes('texel *= min(vec4(1.5), passColor);')) {
      return { kind: 'model', source: source.replace('void main()', modelFunctions+'\nvoid main()')
        .replace('texel *= min(vec4(1.5), passColor);', 'texel *= min(vec4(1.5), passColor); texel.rgb = q2ModelShade(texel.rgb);') };
    }
    return { kind: 'original', source };
  }
  function fail(message) { report.failures.push(message); console.warn('RTX-style fallback:',message); update(); }
  const originalGetContext = canvas.getContext.bind(canvas);
  canvas.getContext = function (type, options) {
    const ctx = originalGetContext(type, options);
    if (ctx && type === 'webgl2' && ctx !== gl) install(ctx);
    return ctx;
  };
  function install(ctx) {
    gl = ctx;
    const native = {};
    for (const name of ['shaderSource','compileShader','linkProgram','useProgram','activeTexture','bindTexture','texImage2D','drawElements','drawArrays','deleteProgram','clear']) native[name] = gl[name].bind(gl);
    gl.shaderSource = (shader, source) => {
      const patch = transform(source,gl.getShaderParameter(shader,gl.SHADER_TYPE));
      shaders.set(shader,{ ...patch, original: source });
      native.shaderSource(shader,patch.source);
    };
    gl.compileShader = shader => {
      native.compileShader(shader);
      const patch = shaders.get(shader);
      if (patch && patch.kind !== 'original' && !gl.getShaderParameter(shader,gl.COMPILE_STATUS)) {
        fail(gl.getShaderInfoLog(shader));
        native.shaderSource(shader,patch.original); native.compileShader(shader);
      }
    };
    gl.linkProgram = program => {
      native.linkProgram(program);
      if (!gl.getProgramParameter(program,gl.LINK_STATUS)) {
        fail(gl.getProgramInfoLog(program));
        for (const shader of gl.getAttachedShaders(program)) {
          const patch = shaders.get(shader);
          if (patch) { native.shaderSource(shader,patch.original); native.compileShader(shader); }
        }
        native.linkProgram(program);
      }
      const modeLocation = gl.getUniformLocation(program,'q2RTX');
      const materialLocation = gl.getUniformLocation(program,'q2Material');
      const modelLocation = gl.getUniformLocation(program,'q2Model');
      const skyLocation = gl.getUniformLocation(program,'q2Sky');
      const skyViewportLocation = gl.getUniformLocation(program,'q2SkyViewport');
      const originals = gl.getAttachedShaders(program).map(shader => shaders.get(shader)?.original || '');
      const is2D = originals.some(source => /uniform\s+uni2D\b/.test(source));
      // Two model shader variants are patched: the one the live line shaded
      // from vertex normals ("model"), and the one the rebuilt pak10 meshes
      // use, which has no normal and is shaded from its albedo ("modelRelief").
      const isModel = originals.some(source => source.includes('texel *= min(vec4(1.5), passColor);'));
      const kind = skyLocation ? 'sky' : isModel && materialLocation ? 'model' :
        modelLocation ? 'modelRelief' :
        materialLocation ? 'world' : modeLocation ? 'post' : is2D ? 'ui' : 'original';
      programs.set(program,{ kind, modeLocation, materialLocation, modelLocation, skyLocation, skyViewportLocation,
        lastMode: -1, lastModel: -1, lastTexture: null, lastSky: -1 });
      if (kind === 'world') report.worldShaders++;
      if (kind === 'post') report.postShaders++;
      if (kind === 'model') report.modelShaders++;
      if (kind === 'modelRelief') { report.modelShaders++; report.modelReliefShaders++; }
      if (kind === 'sky') report.skyShaders++;
      report.supported = report.worldShaders > 0 && report.postShaders > 0;
      update();
    };
    gl.deleteProgram = program => { programs.delete(program); native.deleteProgram(program); };
    gl.useProgram = program => { current = programs.get(program); native.useProgram(program); dirty = true; };
    gl.clear = (...args) => {
      sceneDirty = false; worldThisFrame = false; skyPending = true; lastModelSkins = [];
      // Who owns the keyboard for the frame about to be drawn. Sampled here so
      // every draw of the frame costs no more than a number compare.
      frameKeyDest = readKeyDest();
      keyDestSampledAt = performance.now();
      return native.clear(...args);
    };
    gl.activeTexture = unit => { textureUnit = unit-gl.TEXTURE0; native.activeTexture(unit); };
    gl.bindTexture = (target, texture) => { if (target === gl.TEXTURE_2D) { bound[textureUnit] = texture; dirty = true; } native.bindTexture(target,texture); };
    gl.texImage2D = function (...args) {
      native.texImage2D(...args);
      const [target,level,,width,height,,format,type,pixels,offset=0] = args;
      // Remember every 2D level-0 upload's size: a model draw's bound texture
      // is the skin it was uploaded from, and the runner uses the weapon skin's
      // own size to tell a weapon draw from a world draw.
      if (target === gl.TEXTURE_2D && level === 0 && width > 0 && height > 0 && bound[textureUnit]) {
        textureSizes.set(bound[textureUnit], width + 'x' + height);
      }
      if (target !== gl.TEXTURE_2D || level !== 0 || format !== gl.RGBA || type !== gl.UNSIGNED_BYTE || !ArrayBuffer.isView(pixels)) return;
      const bytes = new Uint8Array(pixels.buffer,pixels.byteOffset+offset*pixels.BYTES_PER_ELEMENT);
      if (bytes.length < width*height*4) return;
      let hash = 2166136261;
      for (let i=0;i<64;i++) { const p=Math.floor(i*(width*height-1)/63)*4; for(let c=0;c<3;c++) hash=Math.imul(hash^bytes[p+c],16777619); }
      const material = window.quake2MaterialCatalog[`${width}x${height}:${hash>>>0}`];
      if (material && bound[textureUnit]) {
        textures.set(bound[textureUnit],profile[material[1]] || MATTE);
        report.matchedTextures++; report.materials[material[1]]=(report.materials[material[1]]||0)+1;
      }
    };
    // Which skin size the engine bound for a model draw. The view weapon's
    // skin has its own size, so the runner can name the draw instead of just
    // counting models.
    function noteModelTexture() {
      // Which skins are bound for this model draw, across every texture unit:
      // the engine does not promise the skin is on unit 0.
      const sizes = [];
      for (const texture of bound) {
        if (!texture) continue;
        const size = textureSizes.get(texture);
        if (size) sizes.push(size);
      }
      if (!sizes.length) return;
      lastModelSkins = [...new Set(sizes)];
      for (const size of lastModelSkins) {
        report.modelTextureDraws[size] = (report.modelTextureDraws[size] || 0) + 1;
      }
    }

    function uniforms() {
      if (current?.kind === 'ui') {
        // The engine draws the view weapon after every entity and the HUD
        // after that, so the first 2D draw of a frame names the skins of the
        // model drawn last: the gun in hand when cl_gun is 1.
        for (const size of lastModelSkins) {
          report.lastModelSkinDraws[size] = (report.lastModelSkinDraws[size] || 0) + 1;
        }
        lastModelSkins = [];
        report.uiDraws++;
        armHudRead();
        if (sceneDirty) {
          sceneDirty = false;
          if (mode()) {
            if (gl.getParameter(gl.FRAMEBUFFER_BINDING)) report.fboSkips++;
            else finishScene();
          }
        }
        // The engine's own menu and console are 2D draws too. The dark panel
        // replaces the menu and the app never types into the console, so while
        // either owns the keyboard their draws are dropped: nothing of the old
        // interface can appear, on Escape, on a pause or at boot. The scene
        // behind them has already been composited above and stays on screen.
        if (keyDestNow() !== 0) { report.suppressedDraws++; return true; }
      }
      if (current?.kind === 'modelRelief') {
        // The albedo-relief model shader has no q2RTX uniform of its own
        // (adding one would make it look like the post-program to the
        // classifier); q2Model carries the same on/off and gates
        // q2ModelShade in the fragment.
        const value = mode() > 0 ? 1 : 0;
        if (current.lastModel !== value) { gl.uniform1f(current.modelLocation,value); current.lastModel = value; }
        report.modelDraws++;
        noteModelTexture();
        sceneDirty = true;
        return;
      }
      if (!current || !current.modeLocation) return;
      const value = mode();
      if (current.lastMode !== value) { gl.uniform1f(current.modeLocation,value); current.lastMode=value; }
      if (current.materialLocation && (dirty || current.lastTexture !== bound[0])) {
        const fallback = current.kind === 'model' ? MODEL : MATTE;
        gl.uniform4fv(current.materialLocation,textures.get(bound[0]) || fallback);
        current.lastTexture=bound[0];
      }
      if (current.kind === 'sky') {
        // Only the engine's flat sky fill is tinted: the first flat fill after
        // the world in a frame. A solid HUD rectangle never is.
        const sky = value > 0 && worldThisFrame && skyPending ? 1 : 0;
        if (sky) skyPending = false;
        if (current.lastSky !== sky) { gl.uniform1f(current.skyLocation,sky); current.lastSky=sky; }
        if (current.skyViewportLocation) gl.uniform2f(current.skyViewportLocation,1/gl.drawingBufferWidth,1/gl.drawingBufferHeight);
      }
      dirty=false;
      if (current.kind==='post') {
        report.postDraws++; sceneDirty=false;
        // The 2D blend program is the console's and the engine menu's backing
        // fill; with the keyboard away from the game it is not drawn.
        if (keyDestNow() !== 0) { report.suppressedDraws++; return true; }
      }
      else if (current.kind==='sky') { report.skyDraws++; }
      else if (current.kind==='model') { report.modelDraws++; noteModelTexture(); sceneDirty=true; }
      else if (current.kind==='world') { report.worldDraws++; sceneDirty=true; worldThisFrame=true; }
      return false;
    }
    gl.drawElements = (...args) => { if (uniforms()) return; return native.drawElements(...args); };
    gl.drawArrays = (...args) => { if (uniforms()) return; return native.drawArrays(...args); };
    // Upstream only uses its scene FBO underwater. On land, copy the finished
    // default framebuffer at the first 2D draw, composite, then restore every
    // touched GL binding/state so the engine's state cache and HUD stay valid.
    function finishScene() {
      const old = { program: gl.getParameter(gl.CURRENT_PROGRAM), vao: gl.getParameter(gl.VERTEX_ARRAY_BINDING),
        active: gl.getParameter(gl.ACTIVE_TEXTURE), viewport: gl.getParameter(gl.VIEWPORT),
        mask: gl.getParameter(gl.COLOR_WRITEMASK), depthMask: gl.getParameter(gl.DEPTH_WRITEMASK) };
      const caps = [gl.DEPTH_TEST,gl.BLEND,gl.CULL_FACE,gl.SCISSOR_TEST,gl.STENCIL_TEST];
      const states = caps.map(cap => gl.isEnabled(cap));
      native.activeTexture(gl.TEXTURE0);
      const oldTexture = gl.getParameter(gl.TEXTURE_BINDING_2D);
      const oldSampler = gl.getParameter(gl.SAMPLER_BINDING);
      try {
        // The engine's sampler can require mipmaps; our one-level scene copy
        // must use its own non-mipmapped filtering.
        gl.bindSampler(0,null);
        if (!composite) {
          const program = gl.createProgram();
          const vs = '#version 300 es\nvoid main(){vec2 p=vec2(float((gl_VertexID<<1)&2),float(gl_VertexID&2));gl_Position=vec4(p*2.0-1.0,0,1);}';
          const fs = '#version 300 es\nprecision highp float;\nuniform sampler2D tex;out vec4 outColor;\n'+postFunctions+
            '\nvoid main(){vec2 uv=gl_FragCoord.xy/vec2(textureSize(tex,0));vec3 c=texture(tex,uv).rgb;outColor=vec4(q2Finish(c,uv),1);}';
          for (const [type,source] of [[gl.VERTEX_SHADER,vs],[gl.FRAGMENT_SHADER,fs]]) {
            const shader = gl.createShader(type); native.shaderSource(shader,source); native.compileShader(shader);
            if (!gl.getShaderParameter(shader,gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(shader));
            gl.attachShader(program,shader); gl.deleteShader(shader);
          }
          native.linkProgram(program);
          if (!gl.getProgramParameter(program,gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program));
          composite = { program, vao: gl.createVertexArray(), texture: gl.createTexture(), width: 0, height: 0,
            mode: gl.getUniformLocation(program,'q2RTX') };
          native.bindTexture(gl.TEXTURE_2D,composite.texture);
          gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MIN_FILTER,gl.LINEAR);
          gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MAG_FILTER,gl.LINEAR);
          gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_S,gl.CLAMP_TO_EDGE);
          gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_T,gl.CLAMP_TO_EDGE);
        }
        const width=gl.drawingBufferWidth,height=gl.drawingBufferHeight;
        native.bindTexture(gl.TEXTURE_2D,composite.texture);
        if (composite.width!==width || composite.height!==height) {
          const alpha = gl.getContextAttributes().alpha;
          native.texImage2D(gl.TEXTURE_2D,0,alpha?gl.RGBA8:gl.RGB8,width,height,0,alpha?gl.RGBA:gl.RGB,gl.UNSIGNED_BYTE,null);
          composite.width=width; composite.height=height;
        }
        gl.copyTexSubImage2D(gl.TEXTURE_2D,0,0,0,0,0,width,height);
        caps.forEach(cap=>gl.disable(cap)); gl.colorMask(true,true,true,true); gl.depthMask(false);
        gl.viewport(0,0,width,height); gl.bindVertexArray(composite.vao);
        native.useProgram(composite.program); gl.uniform1f(composite.mode,mode());
        native.drawArrays(gl.TRIANGLES,0,3); report.postDraws++;
      } catch (error) { fail(String(error)); }
      finally {
        native.useProgram(old.program); gl.bindVertexArray(old.vao); gl.viewport(...old.viewport);
        gl.colorMask(...old.mask); gl.depthMask(old.depthMask);
        caps.forEach((cap,i)=>states[i]?gl.enable(cap):gl.disable(cap));
        native.bindTexture(gl.TEXTURE_2D,oldTexture); native.activeTexture(old.active);
        gl.bindSampler(0,oldSampler);
      }
    }
    canvas.addEventListener('webglcontextlost', () => fail('WebGL context lost; reload to restore rendering.'), { once: true });
  }
})();
