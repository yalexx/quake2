#!/usr/bin/env node
// scripts/texture-pack.mjs -- put the team's generated art into baseq2/pak0.pak,
// and the 4x originals of the walls into baseq2/pak9.pak.
//
// The engine reads its textures from the PAK and from nowhere else, so new art
// reaches the game only by becoming an entry inside that archive. This tool is
// the one place that happens:
//
//   node scripts/texture-pack.mjs                       # pack every picture that has art
//   node scripts/texture-pack.mjs --dry-run             # say what it would do
//   node scripts/texture-pack.mjs --only textures/e1u1  # just those entries
//   node scripts/texture-pack.mjs --check               # exit 1 unless both archives are already up to date
//   node scripts/texture-pack.mjs --refresh-manifest    # rebuild assets/textures/manifest.json
//
// What it does with each manifest entry whose PNG exists:
//
//   1. reads the PNG (scripts/texture-lib.mjs) and refuses to go on if its
//      dimensions are not the entry's -- a 64x128 wall drawn at 128x128 is a
//      mistake, not art, and it must not reach the archive. A WAL (a wall, floor,
//      ceiling or trim texture) may instead be drawn at exactly HIRES_SCALE (4)
//      times its width AND height; 2x, 3x, 6x or the right number of pixels in
//      the wrong shape are refused just the same, and a PCX picture -- which the
//      engine draws from its own pixels, not through r_retexturing -- is always
//      exact size only;
//   2. for 4x wall art, area-averages each 4x4 block down to the entry's pixels
//      (downsampleRgba), so the WAL gets the mean of the detail; 1x art is used
//      as it is;
//   3. re-indexes each pixel onto the palette the ENGINE uses for that entry,
//      read out of the PAK at pack time -- the one global palette from
//      pics/colormap.pcx for a WAL, the picture's own trailing palette for a PCX
//      -- so art can never be packed against an invented palette;
//   4. encodes a WAL or an eight-bit PCX, keeping the header fields of the entry
//      it replaces (flags, contents, value, mip count, resolution, palette
//      type): that is how a wall keeps the SURF_* flags the renderer reads;
//   5. decodes what it just encoded and compares the pixels with the ones it
//      started from, so an encoder bug fails here rather than in the game;
//   6. rewrites the archive in one atomic step, leaving every entry it did not
//      replace byte for byte as it was.
//
// And, beside pak0, a second archive of the same walls at their drawn size: for
// each WAL packed from 4x art, the PNG's bytes are copied VERBATIM into
// baseq2/pak9.pak as textures/<unit>/<name>.png (the name Yamagi's
// r_retexturing looks up in place of the .wal, at the WAL's own size), in
// manifest order. Nothing is re-encoded, so the engine gets exactly the pixels
// the artist drew. Both archives are deterministic: the same art gives the same
// bytes, run after run. A run with no 4x art writes no pak9 (and never deletes
// one); --check treats a pak9 that disagrees -- or one that exists when no 4x art
// does -- as stale and exits 1. --dry-run writes neither archive.
//
// pak9 holds the pictures of the entries this run packs, so --only narrows it
// too: pack the whole tree (no --only) to rebuild it whole. A run that writes
// somewhere else with --out keeps its hires archive beside that output unless
// --hires-out names another file, so a scratch run never rewrites the game's.
//
// Run it twice and the second run writes nothing: the archive is compared with
// what would be written and left alone when the two match. --check asserts that
// and exits non-zero when they do not, which is how a later run proves the
// archive is exactly the art on disk.
//
// Transparent art is resolved by --alpha (default `original`): a pixel below the
// cut-off keeps the pixel the original image had there. One rule, right for both
// formats -- a sprite frame's background is index 255 in the original, so
// transparent art stays transparent, while a wall, which has no transparency at
// all, keeps the wall it is replacing instead of a hole punched through it.

import fs from "node:fs";
import path from "node:path";
import {
  DEFAULT_ART_DIR,
  DEFAULT_HIRES_PAK,
  DEFAULT_MANIFEST,
  DEFAULT_PAK,
  HIRES_SCALE,
  PROJECT_ROOT,
  TextureError,
  artPathFor,
  buildManifest,
  buildPakFromEntries,
  classifyEntry,
  decodePcx,
  decodePng,
  decodeWal,
  dimensionsOf,
  downsampleRgba,
  encodePcx8,
  encodeWal,
  formatBytes,
  normalizeName,
  paletteForEntry,
  paletteMapper,
  readManifest,
  readPakDirectory,
  readPcx,
  readWal,
  rgbaToIndices,
  writeManifest,
  writePak,
  writePakBytes,
} from "./texture-lib.mjs";

const ALPHA_MODES = ["original", "black", "white", "ignore", "index255"];
const ALPHA_CUTOFF = 128;

const USAGE = `texture-pack.mjs -- generated art into baseq2/pak0.pak

  --manifest <file>   the manifest of entries and art (default ${rel(DEFAULT_MANIFEST)})
  --art <dir>         where the generated PNGs live (default ${rel(DEFAULT_ART_DIR)})
  --pak <file>        the archive to pack into (default ${rel(DEFAULT_PAK)})
  --out <file>        write the archive here instead of over the pak
  --hires-out <file>  the second archive of the 4x pictures, verbatim
                      (default ${rel(DEFAULT_HIRES_PAK)}, or pak9.pak beside --out)
  --only <text>       pack only entries whose name contains <text> (repeatable)
  --alpha <mode>      what transparent art means: ${ALPHA_MODES.join(", ")} (default original)
  --dry-run           build and report, but write nothing
  --check             exit 1 unless both archives are already exactly what this
                      would write (and also when there is no art to check at all)
  --refresh-manifest  rebuild the manifest from the pak and stop
  --json              print the summary as JSON
  --quiet             print only the summary line
  --help              this text
`;

function rel(file) {
  return path.relative(PROJECT_ROOT, file).split(path.sep).join("/") || ".";
}

function parseArguments(argv) {
  const options = {
    manifest: DEFAULT_MANIFEST,
    art: DEFAULT_ART_DIR,
    pak: DEFAULT_PAK,
    out: null,
    hiresOut: null,
    only: [],
    alpha: "original",
    dryRun: false,
    check: false,
    refreshManifest: false,
    json: false,
    quiet: false,
    help: false,
  };
  const takesValue = new Set(["--manifest", "--art", "--pak", "--out", "--hires-out", "--only", "--alpha"]);
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    if (argument === "--help" || argument === "-h") options.help = true;
    else if (argument === "--dry-run") options.dryRun = true;
    else if (argument === "--check") { options.check = true; options.dryRun = true; }
    else if (argument === "--refresh-manifest") options.refreshManifest = true;
    else if (argument === "--json") options.json = true;
    else if (argument === "--quiet") options.quiet = true;
    else {
      const split = argument.indexOf("=");
      const flag = split === -1 ? argument : argument.slice(0, split);
      if (!takesValue.has(flag)) throw new TextureError("unknown option " + argument + "\n\n" + USAGE, "BAD_ARGUMENT");
      const value = split === -1 ? argv[++index] : argument.slice(split + 1);
      // A flag whose value is another flag is a typo, not a value: saying so
      // beats "--only swallowed --pak" three lines later.
      if (value === undefined || (split === -1 && value.startsWith("--"))) {
        throw new TextureError(flag + " needs a value" + (value === undefined ? "" : " (got " + value + ")"), "BAD_ARGUMENT");
      }
      if (flag === "--manifest") options.manifest = path.resolve(value);
      else if (flag === "--art") options.art = path.resolve(value);
      else if (flag === "--pak") options.pak = path.resolve(value);
      else if (flag === "--out") options.out = path.resolve(value);
      else if (flag === "--hires-out") options.hiresOut = path.resolve(value);
      else if (flag === "--only") options.only.push(value.toLowerCase());
      else if (flag === "--alpha") {
        if (!ALPHA_MODES.includes(value)) throw new TextureError("--alpha must be one of " + ALPHA_MODES.join(", "), "BAD_ARGUMENT");
        options.alpha = value;
      }
    }
  }
  return options;
}

// Where the art for an entry is, honouring --art. The manifest names every PNG
// relative to the project, so an --art that differs from the default is applied
// by rebuilding the path the same way the manifest did.
function artFileFor(entry, artDir) {
  if (artDir !== DEFAULT_ART_DIR) return artPathFor(entry.name, artDir);
  return path.isAbsolute(entry.png) ? entry.png : path.join(PROJECT_ROOT, entry.png);
}

// The index a transparent pixel falls back to. `original` is the default and
// needs the pixels of the entry being replaced; the others are constants, and
// `ignore` drops alpha altogether.
function indicesForArt(image, palette, originalIndices, alpha) {
  const map = paletteMapper(palette);
  const options = { alphaCutoff: ALPHA_CUTOFF };
  if (alpha === "ignore") options.alphaCutoff = -1;
  else if (alpha === "black") options.original = () => map(0, 0, 0);
  else if (alpha === "white") options.original = () => map(255, 255, 255);
  else if (alpha === "index255") options.original = () => 255;
  else options.original = originalIndices;
  return rgbaToIndices(image.data, image.width, image.height, map, options);
}

// One entry, encoded: palettes and header fields from the archive, pixels from
// the art through the alpha rule.
function encodeEntry({ entry, type, image, originalBytes, palette, alpha }) {
  const originalIndices = type === "wal" ? decodeWal(originalBytes).indices : decodePcx(originalBytes).indices;
  const indices = indicesForArt(image, palette.palette, originalIndices, alpha);
  if (type === "wal") {
    const header = readWal(originalBytes);
    // A texture's own name, which the map and any animated chain refer to; the
    // entry's name is the fallback for a header that did not carry one.
    const name = header.name || entry.name.replace(/^textures\//i, "").replace(/\.wal$/i, "");
    const bytes = encodeWal(name, image.width, image.height, indices, palette.palette, {
      animname: header.animname,
      flags: header.flags,
      contents: header.contents,
      value: header.value,
      mipLevels: header.mipLevels,
    });
    if (bytes.toString("latin1", 0, 32).replace(/\0.*$/, "") !== name) {
      throw new TextureError("the encoded WAL does not carry the name " + name);
    }
    return { bytes, indices };
  }
  const header = readPcx(originalBytes);
  const bytes = encodePcx8(image.width, image.height, indices, palette.palette, { header: header.header });
  return { bytes, indices };
}

// What the encoder produced, read back: the pixels it decodes to and the size it
// claims. A failure here is a bug in this tool, not in the art.
function checkEntry(bytes, type, entry) {
  const dims = dimensionsOf(bytes, type);
  if (dims.width !== entry.width || dims.height !== entry.height) {
    return { problem: "the encoded " + type.toUpperCase() + " is " + dims.width + "x" + dims.height + ", not the entry's " + entry.width + "x" + entry.height };
  }
  return { pixels: type === "wal" ? decodeWal(bytes).indices : decodePcx(bytes).indices };
}

function main(argv) {
  const options = parseArguments(argv);
  if (options.help) {
    process.stdout.write(USAGE);
    return 0;
  }

  if (options.refreshManifest) {
    const manifest = buildManifest(options.pak, { pakPath: options.pak });
    writeManifest(manifest, options.manifest);
    if (!options.quiet) {
      process.stdout.write(
        "wrote " + rel(options.manifest) + ": " + manifest.counts.wal + " WAL, " + manifest.counts.pcx + " PCX, " +
          manifest.counts.sp2 + " SP2, " + manifest.palettes.length + " palette(s), " +
          manifest.maps.reduce((total, map) => total + map.textures.length, 0) + " map texture name(s)\n"
      );
    }
    return 0;
  }

  const manifest = readManifest(options.manifest);
  if (options.only.length && !manifest.entries.some((entry) => options.only.some((text) => entry.name.toLowerCase().includes(text)))) {
    // A misspelled --only that quietly packs nothing reads like success.
    throw new TextureError("no entry in the manifest matches --only " + options.only.join(", "), "BAD_ARGUMENT");
  }
  let pak;
  try {
    pak = fs.readFileSync(options.pak);
  } catch (error) {
    throw new TextureError("cannot read the pak at " + options.pak + " (" + error.message + ")", "NO_PAK");
  }
  const directory = readPakDirectory(pak);
  const target = options.out ?? options.pak;
  // A scratch run (--out) keeps its hires archive beside the output unless
  // --hires-out says otherwise: the game's own pak9 must never be rewritten by a
  // run that was asked to write somewhere else.
  const hiresTarget = options.hiresOut ?? (options.out ? path.join(path.dirname(options.out), "pak9.pak") : DEFAULT_HIRES_PAK);
  if (hiresTarget === target) {
    // Two archives at one path is one archive, and the second write would
    // replace the first: say so instead of losing pak0.
    throw new TextureError("the hires archive and the packed archive cannot be the same file (" + hiresTarget + ")", "BAD_ARGUMENT");
  }
  const paletteCache = new Map();

  const failures = [];
  const packed = [];
  const unchanged = [];
  const missing = [];
  const skipped = [];
  const replacements = new Map();
  const hires = [];

  for (const entry of manifest.entries) {
    if (options.only.length && !options.only.some((text) => entry.name.toLowerCase().includes(text))) continue;
    const type = classifyEntry(entry.name);
    if (!type) continue;
    if (type === "sp2") {
      // A sprite names its frames, and each frame is a PCX entry of its own that
      // is packed as itself, so the SP2 never needs rewriting.
      skipped.push({ name: entry.name, reason: "drawn from its frame PCX entries, which are packed separately" });
      continue;
    }
    const artFile = artFileFor(entry, options.art);
    if (!fs.existsSync(artFile)) {
      missing.push(entry.name);
      continue;
    }
    const found = directory.get(normalizeName(entry.name));
    if (!found) {
      failures.push({ name: entry.name, problem: "the pak has no such entry -- refresh the manifest with --refresh-manifest" });
      continue;
    }
    const originalBytes = pak.subarray(found.offset, found.offset + found.length);
    try {
      const artBytes = fs.readFileSync(artFile);
      const drawn = decodePng(artBytes);
      // A wall may be drawn at exactly HIRES_SCALE times its entry, in both
      // directions. Everything else -- 1x, a 2x or 3x attempt, the right pixel
      // count in the wrong shape, any size at all for a PCX -- is a picture that
      // does not describe its entry.
      const isHires = type === "wal" && drawn.width === entry.width * HIRES_SCALE && drawn.height === entry.height * HIRES_SCALE;
      if (!isHires && (drawn.width !== entry.width || drawn.height !== entry.height)) {
        const allowed = type === "wal"
          ? "the entry is " + entry.width + "x" + entry.height + " or " + entry.width * HIRES_SCALE + "x" + entry.height * HIRES_SCALE + " at " + HIRES_SCALE + "x"
          : "the entry is " + entry.width + "x" + entry.height + " (exact size only)";
        failures.push({
          name: entry.name,
          problem: "art is " + drawn.width + "x" + drawn.height + ", " + allowed + " (" + rel(artFile) + ")",
        });
        continue;
      }
      // 4x art is averaged back down to the entry's pixels for the WAL; the PNG
      // itself, untouched, is what pak9 carries.
      const image = isHires ? downsampleRgba(drawn.data, drawn.width, drawn.height, entry.width, entry.height) : drawn;
      const palette = paletteForEntry(pak, entry.name, { cache: paletteCache });
      const encoded = encodeEntry({ entry, type, image, originalBytes, palette, alpha: options.alpha });
      const check = checkEntry(encoded.bytes, type, entry);
      if (check.problem) {
        failures.push({ name: entry.name, problem: check.problem });
        continue;
      }
      if (!check.pixels.equals(encoded.indices)) {
        failures.push({ name: entry.name, problem: "the " + type.toUpperCase() + " this tool encoded does not decode back to the pixels it was given" });
        continue;
      }
      replacements.set(entry.name, encoded.bytes);
      packed.push({ name: entry.name, type, bytes: encoded.bytes.length, was: found.length, hires: isHires });
      if (encoded.bytes.equals(originalBytes)) unchanged.push(entry.name);
      if (isHires) {
        // The name r_retexturing asks for: the WAL's name with .png where .wal
        // was. The manifest's own entry name already carries the directory.
        hires.push({ name: normalizeName(entry.name).replace(/\.wal$/i, ".png"), data: artBytes });
      }
    } catch (error) {
      failures.push({ name: entry.name, problem: error instanceof TextureError ? error.message : error && error.stack ? error.stack : String(error) });
    }
  }
  if (failures.length) {
    report(options, { failures, packed, unchanged, missing, skipped, plan: null, hires: [], hiresPlan: null, target, hiresTarget });
    return 1;
  }
  if (!replacements.size) {
    report(options, { failures, packed, unchanged, missing, skipped, plan: null, hires: [], hiresPlan: null, target, hiresTarget });
    if (options.check) {
      // --check is a gate: "are the archives exactly the art on disk?" With no
      // art to pack there is nothing to compare, and passing would read as "in
      // sync" when in truth nothing was checked. A pak9 left behind by art that
      // is no longer there is stale and fails too.
      if (fs.existsSync(hiresTarget)) {
        process.stderr.write(rel(hiresTarget) + " exists but there is no art to make it from: refresh it or remove it\n");
        return 1;
      }
      process.stderr.write("nothing to check: no art found for " + (options.only.length ? "--only " + options.only.join(",") : rel(options.art)) + "\n");
      return 1;
    }
    return 0;
  }

  const plan = writePak(pak, replacements, target, { dryRun: options.dryRun });
  // The hires archive: the 4x PNGs exactly as they are on disk, in manifest
  // order, built and compared the same way pak0 is.
  let hiresPlan = null;
  if (hires.length) {
    const built = buildPakFromEntries(hires.map((item) => ({ name: item.name, data: item.data })));
    hiresPlan = writePakBytes(built.buffer, hiresTarget, {
      dryRun: options.dryRun,
      added: hires.map((item) => item.name),
    });
  }
  report(options, { failures, packed, unchanged, missing, skipped, plan, hires, hiresPlan, target, hiresTarget });
  if (options.check) {
    const problems = [];
    if (plan.changed) {
      problems.push("the pak is not up to date with " + rel(options.art) + ": " + plan.replaced.length + " entr(y|ies) would change");
    }
    if (hires.length) {
      if (!hiresPlan || hiresPlan.changed) {
        problems.push(rel(hiresTarget) + " is not up to date with the 4x art: " + hires.length + " picture(s) would change");
      }
    } else if (fs.existsSync(hiresTarget)) {
      // No 4x art means there is nothing a hires archive could hold, so one that
      // is there is left over from art this tree no longer has.
      problems.push(rel(hiresTarget) + " exists but there is no 4x art to make it from");
    }
    if (problems.length) {
      for (const problem of problems) process.stderr.write(problem + "\n");
      return 1;
    }
    return 0;
  }
  return 0;
}

function report(options, result) {
  const { failures, packed, unchanged, missing, skipped, plan, hires, hiresPlan, target, hiresTarget } = result;
  const hiresBytes = hires.reduce((total, item) => total + item.data.length, 0);
  if (options.json) {
    process.stdout.write(
      JSON.stringify(
        {
          ok: failures.length === 0,
          failures,
          packed: packed.map((item) => ({ name: item.name, type: item.type, bytes: item.bytes, was: item.was, hires: Boolean(item.hires) })),
          unchanged,
          missing,
          skipped,
          plan: plan
            ? {
                path: rel(plan.path),
                bytes: plan.bytes,
                entries: plan.entries,
                replaced: plan.replaced.length,
                added: plan.added.length,
                changed: plan.changed,
                written: plan.written,
              }
            : null,
          // The second archive: how many 4x pictures it holds, how many bytes of
          // PNG they are, and what was done with it.
          hires: {
            path: rel(hiresTarget),
            entries: hires.length,
            bytes: hiresBytes,
            names: hires.map((item) => item.name),
            archiveBytes: hiresPlan ? hiresPlan.bytes : 0,
            changed: hiresPlan ? hiresPlan.changed : false,
            written: hiresPlan ? hiresPlan.written : false,
          },
        },
        null,
        1
      ) + "\n"
    );
    return;
  }
  for (const failure of failures) process.stderr.write("FAIL " + failure.name + ": " + failure.problem + "\n");
  if (!options.quiet) {
    for (const item of packed) {
      const grew = item.bytes - item.was;
      process.stdout.write(
        (unchanged.includes(item.name) ? "same " : "pack ") + item.name + "  " + item.type.toUpperCase() + " " +
          formatBytes(item.bytes) + (grew ? " (" + (grew > 0 ? "+" : "") + grew + " bytes)" : "") +
          (item.hires ? "  from " + HIRES_SCALE + "x art" : "") + "\n"
      );
    }
    for (const item of skipped) process.stdout.write("skip " + item.name + ": " + item.reason + "\n");
    if (missing.length) {
      const shown = missing.slice(0, 10);
      process.stdout.write("no art yet: " + shown.join(", ") + (missing.length > shown.length ? " and " + (missing.length - shown.length) + " more" : "") + "\n");
    }
  }
  process.stdout.write(
    (failures.length ? "nothing was written: " : "") + packed.length + " packed (" + unchanged.length +
      " identical to the original), " + missing.length + " without art, " + skipped.length + " skipped, " +
      failures.length + " failed\n"
  );
  if (plan) {
    process.stdout.write(
      (plan.changed ? (plan.written ? "wrote " : "would write ") : "left alone ") + rel(target) + ": " +
        formatBytes(plan.bytes) + ", " + plan.entries + " entries, " + plan.replaced.length + " replaced" +
        (plan.added.length ? ", " + plan.added.length + " added" : "") + "\n"
    );
  }
  if (hires.length) {
    process.stdout.write(
      (hiresPlan.changed ? (hiresPlan.written ? "wrote " : "would write ") : "left alone ") + rel(hiresTarget) + ": " +
        formatBytes(hiresPlan.bytes) + ", " + hires.length + " hires picture(s), " + formatBytes(hiresBytes) + " of PNG" +
        (options.only.length ? " (partial run: --only narrows what pak9 holds)" : "") + "\n"
    );
  } else if (plan) {
    process.stdout.write("no " + HIRES_SCALE + "x art: no hires archive written (" + rel(hiresTarget) + ")\n");
  }
}

try {
  process.exitCode = main(process.argv.slice(2));
} catch (error) {
  process.stderr.write((error instanceof TextureError ? error.message : error && error.stack ? error.stack : String(error)) + "\n");
  process.exitCode = 2;
}
