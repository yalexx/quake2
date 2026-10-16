#!/usr/bin/env node
// scripts/tex-check.mjs -- check generated art against the manifest before it is
// packed into the archive.
//
//   node scripts/tex-check.mjs                    # every PNG that exists, against its entry
//   node scripts/tex-check.mjs --only e1u1        # just these entries
//   node scripts/tex-check.mjs --require-all      # also fail when an entry has no art yet
//   node scripts/tex-check.mjs --json
//
// A replacement texture must be exactly the size of the texture it replaces: the
// engine maps a WAL onto the surface at the dimensions in its header and indexes
// the mip chain by them, so a picture of the wrong size does not merely look
// wrong, it is a texture the renderer will read past. Every entry in
// assets/textures/manifest.json therefore carries the width and height its art
// has to have, and this tool is the check that says so -- it exits non-zero on
// the first mismatch, which is what makes it usable in front of texture-pack.mjs.
//
// What it reports, and what fails:
//
//   missing art        a warning by default -- the six art tasks each cover part
//                      of the archive, and a run that has not reached a texture
//                      yet is not an error. --require-all turns it into one, for
//                      the final check that every texture has been redrawn.
//   wrong size         a FAILURE. The entry, the size the manifest wants and the
//                      size the PNG is.
//   unreadable PNG     a FAILURE: not a PNG, truncated, interlaced, or a colour
//                      type the decoder does not know.
//   art with no entry  a warning. A PNG under the art directory that no manifest
//                      entry claims will never reach the game. (The six sky TGAs
//                      are not manifest entries: only WAL, PCX and SP2 are.)
//                      Source art is not this: the pictures under the folders
//                      scripts/texture-lib.mjs declares as SOURCE_ART_DIRS are
//                      what an art script derives an entry's picture FROM, and
//                      they are counted and listed separately as "source art".
//
// A sprite (SP2) is not an art target: it holds no picture, only a list of frame
// entries that are PCXs in the archive and are listed with art paths of their
// own. Those are counted as pictures; the sprite itself is counted separately, so
// --require-all means "every picture that has to be drawn has art".
//
// Sizes are read from the PNG header, so checking 600 pictures costs a few
// milliseconds and no decoding at all when the header already disagrees; a PNG
// whose header agrees is decoded in full, because a header that lies about the
// data inside it is exactly the case worth catching.

import fs from "node:fs";
import path from "node:path";
import {
  DEFAULT_ART_DIR,
  DEFAULT_MANIFEST,
  MANIFEST_SCHEMA,
  PROJECT_ROOT,
  TextureError,
  artPathFor,
  decodePng,
  formatBytes,
  isSourceArt,
  readManifest,
} from "./texture-lib.mjs";

// How many names a machine-readable report keeps beside each count, so that a
// report about 600 missing pictures stays a report and not a wall of text.
const JSON_NAME_LIMIT = 100;

const USAGE = `tex-check.mjs -- generated art against assets/textures/manifest.json

  --manifest <file>  the manifest to check against (default ${rel(DEFAULT_MANIFEST)})
  --art <dir>        where the generated PNGs live (default ${rel(DEFAULT_ART_DIR)})
  --only <text>      check only entries whose name contains <text> (repeatable)
  --require-all      fail when an entry has no art yet, not just when art is wrong
  --json             print the report as JSON
  --quiet            print only the summary line
  --help             this text
`;

function rel(file) {
  return path.relative(PROJECT_ROOT, file).split(path.sep).join("/") || ".";
}

function parseArguments(argv) {
  const options = { manifest: DEFAULT_MANIFEST, art: DEFAULT_ART_DIR, only: [], requireAll: false, json: false, quiet: false, help: false };
  const takesValue = new Set(["--manifest", "--art", "--only"]);
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    if (argument === "--help" || argument === "-h") options.help = true;
    else if (argument === "--require-all") options.requireAll = true;
    else if (argument === "--json") options.json = true;
    else if (argument === "--quiet") options.quiet = true;
    else {
      const split = argument.indexOf("=");
      const flag = split === -1 ? argument : argument.slice(0, split);
      if (!takesValue.has(flag)) throw new TextureError("unknown option " + argument + "\n\n" + USAGE, "BAD_ARGUMENT");
      const value = split === -1 ? argv[++index] : argument.slice(split + 1);
      if (value === undefined || (split === -1 && value.startsWith("--"))) {
        throw new TextureError(flag + " needs a value" + (value === undefined ? "" : " (got " + value + ")"), "BAD_ARGUMENT");
      }
      if (flag === "--manifest") options.manifest = path.resolve(value);
      else if (flag === "--art") options.art = path.resolve(value);
      else if (flag === "--only") options.only.push(value.toLowerCase());
    }
  }
  return options;
}

function artFileFor(entry, artDir) {
  if (artDir !== DEFAULT_ART_DIR) return artPathFor(entry.name, artDir);
  return path.isAbsolute(entry.png) ? entry.png : path.join(PROJECT_ROOT, entry.png);
}

// Every .png under a directory, as paths relative to it, so an orphan can be
// named the way an artist would name it.
function pngFilesUnder(directory, depth = 0) {
  const found = [];
  if (!fs.existsSync(directory) || depth > 8) return found;
  for (const item of fs.readdirSync(directory, { withFileTypes: true })) {
    const full = path.join(directory, item.name);
    if (item.isDirectory()) found.push(...pngFilesUnder(full, depth + 1));
    else if (/\.png$/i.test(item.name)) found.push(full);
  }
  return found;
}

// The dimensions in a PNG's own header, without decoding its image data, so a
// file whose size is already wrong is caught before any of its pixels are read.
function pngHeaderSize(buffer) {
  if (buffer.length < 24 || buffer.readUInt32BE(0) !== 0x89504e47) throw new TextureError("not a PNG", "BAD_PNG");
  if (buffer.toString("latin1", 12, 16) !== "IHDR") throw new TextureError("the PNG has no header chunk", "BAD_PNG");
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

function main(argv) {
  const options = parseArguments(argv);
  if (options.help) {
    process.stdout.write(USAGE);
    return 0;
  }
  const manifest = readManifest(options.manifest);
  if (options.only.length && !manifest.entries.some((entry) => options.only.some((text) => entry.name.toLowerCase().includes(text)))) {
    // --require-all is the team's final gate; a --only that matches nothing must
    // never pass it by checking zero pictures.
    throw new TextureError("no entry in the manifest matches --only " + options.only.join(", "), "BAD_ARGUMENT");
  }
  const mismatches = [];
  const broken = [];
  const missing = [];
  const covered = [];
  const claimed = new Set();
  const byType = new Map();
  const noArtPath = [];
  let totalBytes = 0;
  let artTargets = 0;

  for (const entry of manifest.entries) {
    if (options.only.length && !options.only.some((text) => entry.name.toLowerCase().includes(text))) {
      // Not checked this run, but its art is still claimed: an --only run must
      // not report every other task's pictures as art no entry claims.
      if (entry.png) claimed.add(path.resolve(artFileFor(entry, options.art)));
      continue;
    }
    const type = byType.get(entry.type) ?? { entries: 0, withArt: 0 };
    type.entries++;
    byType.set(entry.type, type);
    if (!entry.png) {
      // A sprite is drawn from its frame pictures, which are entries of their own
      // in this manifest; it has no art path to check, and is not "missing art".
      noArtPath.push(entry.name);
      continue;
    }
    artTargets++;
    const file = artFileFor(entry, options.art);
    if (!fs.existsSync(file)) {
      missing.push(entry.name);
      continue;
    }
    claimed.add(path.resolve(file));
    try {
      const buffer = fs.readFileSync(file);
      const size = pngHeaderSize(buffer);
      if (size.width !== entry.width || size.height !== entry.height) {
        mismatches.push({ name: entry.name, want: entry.width + "x" + entry.height, got: size.width + "x" + size.height, file: rel(file) });
        continue;
      }
      // The header agrees, so read the whole picture: a PNG whose header says
      // 64x64 and whose data is a different length must not pass.
      const image = decodePng(buffer);
      if (image.width !== entry.width || image.height !== entry.height) {
        mismatches.push({ name: entry.name, want: entry.width + "x" + entry.height, got: image.width + "x" + image.height, file: rel(file) });
        continue;
      }
      type.withArt++;
      totalBytes += buffer.length;
      covered.push({ name: entry.name, type: entry.type, width: image.width, height: image.height, bytes: buffer.length });
    } catch (error) {
      broken.push({ name: entry.name, file: rel(file), problem: error instanceof TextureError ? error.message : String(error && error.message ? error.message : error) });
    }
  }

  const orphans = pngFilesUnder(options.art).filter((file) => !claimed.has(path.resolve(file))).map((file) => rel(file));
  // Source art is not an orphan: it is the picture an art script derives an
  // entry's picture FROM, and the folders that hold it are declared in
  // scripts/texture-lib.mjs (SOURCE_ART_DIRS). Anything else under the art
  // directory that no entry claims is still reported, because that is art which
  // will never reach the game.
  const sources = orphans.filter((file) => isSourceArt(path.join(PROJECT_ROOT, file), options.art));
  const unclaimed = orphans.filter((file) => !isSourceArt(path.join(PROJECT_ROOT, file), options.art));
  const failures = mismatches.length + broken.length + (options.requireAll ? missing.length : 0);
  const summary = {
    manifest: rel(options.manifest),
    schema: MANIFEST_SCHEMA,
    entries: manifest.entries.length,
    artTargets,
    drawnFromFrames: noArtPath.length,
    withArt: covered.length,
    missing: missing.length,
    mismatched: mismatches.length,
    unreadable: broken.length,
    orphans: unclaimed.length,
    sourceArt: sources.length,
    bytes: totalBytes,
    byType: Object.fromEntries([...byType.entries()].map(([key, value]) => [key, value])),
    ok: failures === 0,
  };

  if (options.json) {
    // Counts stay counts; the names of what went wrong are in the lists beside
    // them, capped so that a report about 600 missing pictures is still a report
    // and not a wall of text.
    const capped = (names) => names.slice(0, JSON_NAME_LIMIT);
    process.stdout.write(
      JSON.stringify(
        {
          ...summary,
          cappedAt: JSON_NAME_LIMIT,
          mismatches: capped(mismatches),
          broken: capped(broken),
          missingNames: capped(missing),
          orphanNames: capped(unclaimed),
          sourceNames: capped(sources),
          drawnFromFrames: capped(noArtPath),
          covered: options.quiet ? [] : capped(covered),
        },
        null,
        1
      ) + "\n"
    );
    return failures ? 1 : 0;
  }

  for (const item of mismatches) {
    process.stderr.write("FAIL " + item.name + ": the art is " + item.got + ", the entry is " + item.want + " (" + item.file + ")\n");
  }
  for (const item of broken) {
    process.stderr.write("FAIL " + item.name + ": " + item.problem + " (" + item.file + ")\n");
  }
  if (options.requireAll) {
    for (const name of missing) process.stderr.write("FAIL " + name + ": no art yet\n");
  }
  if (!options.quiet) {
    for (const item of covered) process.stdout.write("ok   " + item.name + "  " + item.width + "x" + item.height + "  " + formatBytes(item.bytes) + "\n");
    if (missing.length) {
      const shown = missing.slice(0, 10);
      process.stdout.write("no art yet (" + missing.length + "): " + shown.join(", ") + (missing.length > shown.length ? " and " + (missing.length - shown.length) + " more" : "") + "\n");
    }
    if (unclaimed.length) {
      process.stdout.write("art no entry claims (" + unclaimed.length + "): " + unclaimed.slice(0, 10).join(", ") + "\n");
    }
    if (sources.length) {
      process.stdout.write("source art, not an entry of its own (" + sources.length + "): " + sources.slice(0, 10).join(", ") + (sources.length > 10 ? " and " + (sources.length - 10) + " more" : "") + "\n");
    }
  }
  process.stdout.write(
    "checked " + artTargets + " pictures of " + manifest.entries.length + " entries: " + covered.length + " with art (" + formatBytes(totalBytes) + "), " +
      missing.length + " without, " + mismatches.length + " the wrong size, " + broken.length + " unreadable, " + unclaimed.length + " unclaimed" +
      (sources.length ? ", " + sources.length + " source picture(s)" : "") +
      (noArtPath.length ? ", " + noArtPath.length + " sprite(s) drawn from their frames" : "") + "\n"
  );
  return failures ? 1 : 0;
}

try {
  process.exitCode = main(process.argv.slice(2));
} catch (error) {
  process.stderr.write((error instanceof TextureError ? error.message : error && error.stack ? error.stack : String(error)) + "\n");
  process.exitCode = 2;
}
