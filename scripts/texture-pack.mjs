#!/usr/bin/env node
// scripts/texture-pack.mjs -- put the team's generated art into baseq2/pak0.pak.
//
// The engine reads its textures from the PAK and from nowhere else, so new art
// reaches the game only by becoming an entry inside that archive. This tool is
// the one place that happens:
//
//   node scripts/texture-pack.mjs                       # pack every picture that has art
//   node scripts/texture-pack.mjs --dry-run             # say what it would do
//   node scripts/texture-pack.mjs --only textures/e1u1  # just those entries
//   node scripts/texture-pack.mjs --check               # exit 1 unless the pak is already up to date
//   node scripts/texture-pack.mjs --refresh-manifest    # rebuild assets/textures/manifest.json
//
// What it does with each manifest entry whose PNG exists:
//
//   1. reads the PNG (scripts/texture-lib.mjs) and refuses to go on if its
//      dimensions are not the entry's -- a 64x128 wall drawn at 128x128 is a
//      mistake, not art, and it must not reach the archive;
//   2. re-indexes each pixel onto the palette the ENGINE uses for that entry,
//      read out of the PAK at pack time -- the one global palette from
//      pics/colormap.pcx for a WAL, the picture's own trailing palette for a PCX
//      -- so art can never be packed against an invented palette;
//   3. encodes a WAL or an eight-bit PCX, keeping the header fields of the entry
//      it replaces (flags, contents, value, mip count, resolution, palette
//      type): that is how a wall keeps the SURF_* flags the renderer reads;
//   4. decodes what it just encoded and compares the pixels with the ones it
//      started from, so an encoder bug fails here rather than in the game;
//   5. rewrites the archive in one atomic step, leaving every entry it did not
//      replace byte for byte as it was.
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
  DEFAULT_MANIFEST,
  DEFAULT_PAK,
  PROJECT_ROOT,
  TextureError,
  artPathFor,
  buildManifest,
  classifyEntry,
  decodePcx,
  decodePng,
  decodeWal,
  dimensionsOf,
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
} from "./texture-lib.mjs";

const ALPHA_MODES = ["original", "black", "white", "ignore", "index255"];
const ALPHA_CUTOFF = 128;

const USAGE = `texture-pack.mjs -- generated art into baseq2/pak0.pak

  --manifest <file>   the manifest of entries and art (default ${rel(DEFAULT_MANIFEST)})
  --art <dir>         where the generated PNGs live (default ${rel(DEFAULT_ART_DIR)})
  --pak <file>        the archive to pack into (default ${rel(DEFAULT_PAK)})
  --out <file>        write the archive here instead of over the pak
  --only <text>       pack only entries whose name contains <text> (repeatable)
  --alpha <mode>      what transparent art means: ${ALPHA_MODES.join(", ")} (default original)
  --dry-run           build and report, but write nothing
  --check             exit 1 unless the pak is already exactly what this would write
                      (and also when there is no art to check at all)
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
    only: [],
    alpha: "original",
    dryRun: false,
    check: false,
    refreshManifest: false,
    json: false,
    quiet: false,
    help: false,
  };
  const takesValue = new Set(["--manifest", "--art", "--pak", "--out", "--only", "--alpha"]);
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
      if (value === undefined) throw new TextureError(flag + " needs a value", "BAD_ARGUMENT");
      if (flag === "--manifest") options.manifest = path.resolve(value);
      else if (flag === "--art") options.art = path.resolve(value);
      else if (flag === "--pak") options.pak = path.resolve(value);
      else if (flag === "--out") options.out = path.resolve(value);
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
  let pak;
  try {
    pak = fs.readFileSync(options.pak);
  } catch (error) {
    throw new TextureError("cannot read the pak at " + options.pak + " (" + error.message + ")", "NO_PAK");
  }
  const directory = readPakDirectory(pak);
  const target = options.out ?? options.pak;
  const paletteCache = new Map();

  const failures = [];
  const packed = [];
  const unchanged = [];
  const missing = [];
  const skipped = [];
  const replacements = new Map();

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
      const image = decodePng(fs.readFileSync(artFile));
      if (image.width !== entry.width || image.height !== entry.height) {
        failures.push({
          name: entry.name,
          problem: "art is " + image.width + "x" + image.height + ", the entry is " + entry.width + "x" + entry.height + " (" + rel(artFile) + ")",
        });
        continue;
      }
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
      packed.push({ name: entry.name, type, bytes: encoded.bytes.length, was: found.length });
      if (encoded.bytes.equals(originalBytes)) unchanged.push(entry.name);
    } catch (error) {
      failures.push({ name: entry.name, problem: error instanceof TextureError ? error.message : error && error.stack ? error.stack : String(error) });
    }
  }
  if (failures.length) {
    report(options, { failures, packed, unchanged, missing, skipped, plan: null, target });
    return 1;
  }
  if (!replacements.size) {
    report(options, { failures, packed, unchanged, missing, skipped, plan: null, target });
    if (options.check) {
      // --check is a gate: "is the pak exactly the art on disk?" With no art to
      // pack there is nothing to compare, and passing would read as "in sync"
      // when in truth nothing was checked.
      process.stderr.write("nothing to check: no art found for " + (options.only.length ? "--only " + options.only.join(",") : rel(options.art)) + "\n");
      return 1;
    }
    return 0;
  }

  const plan = writePak(pak, replacements, target, { dryRun: options.dryRun });
  report(options, { failures, packed, unchanged, missing, skipped, plan, target });
  if (options.check) {
    if (plan.changed) {
      process.stderr.write("the pak is not up to date with " + rel(options.art) + ": " + plan.replaced.length + " entr(y|ies) would change\n");
      return 1;
    }
    return 0;
  }
  return 0;
}

function report(options, result) {
  const { failures, packed, unchanged, missing, skipped, plan, target } = result;
  if (options.json) {
    process.stdout.write(
      JSON.stringify(
        {
          ok: failures.length === 0,
          failures,
          packed: packed.map((item) => ({ name: item.name, type: item.type, bytes: item.bytes, was: item.was })),
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
          formatBytes(item.bytes) + (grew ? " (" + (grew > 0 ? "+" : "") + grew + " bytes)" : "") + "\n"
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
}

try {
  process.exitCode = main(process.argv.slice(2));
} catch (error) {
  process.stderr.write((error instanceof TextureError ? error.message : error && error.stack ? error.stack : String(error)) + "\n");
  process.exitCode = 2;
}
