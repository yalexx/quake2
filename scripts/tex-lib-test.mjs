#!/usr/bin/env node
// scripts/tex-lib-test.mjs -- the two rules the texture checker turns on.
//
//   node scripts/tex-lib-test.mjs     # exit 0 pass, 1 fail
//
// Nothing here needs the archive or a browser: it pins the classification that
// decides what "art no entry claims" means, and the claim that an --only run
// makes about the pictures it was not asked to check.
//
//   source art       assets/textures/hud/, map/ and model/ hold the pictures an
//                    art script derives an entry's art FROM, not an entry's art
//                    (scripts/texture-lib.mjs, SOURCE_ART_DIRS). They are
//                    counted as `sourceArt`; anything else under the art
//                    directory that no entry claims stays an orphan, because it
//                    will never reach the game.
//   --only claims    a run that checks one namespace must still claim every
//                    other entry's art. Without that, `tex-check --only models/`
//                    reported the other 350 pictures as art no entry claims --
//                    which is how a real stray PNG hides in plain sight.
//
// The classification is checked at the edges as well as in the middle: a folder
// whose name merely STARTS with a source folder's name is not source art, a
// path outside the art directory is not, and a custom art directory moves the
// rule with it.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { HIRES_SCALE, PROJECT_ROOT, SOURCE_ART_DIRS, decodePng, downsampleRgba, isSourceArt, pngSize } from "./texture-lib.mjs";

const CHECKER = path.join(path.dirname(fileURLToPath(import.meta.url)), "tex-check.mjs");
const ART_DIR = path.join(PROJECT_ROOT, "assets", "textures");

// A PNG writer, here and only here: the fixtures below are the pictures this
// test decides the checker's answer on, so they have to be built rather than
// borrowed from the project's own art (which another task may be changing).
// Colour type 2 (RGB) for the 4x wall pictures and colour type 3 (indexed) for
// the palette case the decoder has to read.
function pngChunk(type, data) {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, "latin1");
  data.copy(out, 8);
  out.writeUInt32BE(zlib.crc32(Buffer.concat([Buffer.from(type, "latin1"), data])) >>> 0, 8 + data.length);
  return out;
}

function encodePngRgb(width, height, rgb) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const stride = width * 3;
  const raw = Buffer.alloc(height * (stride + 1));
  for (let y = 0; y < height; y++) rgb.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", zlib.deflateSync(raw)),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

function encodePngIndexed(width, height, indices, palette) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 3;
  const raw = Buffer.alloc(height * (width + 1));
  for (let y = 0; y < height; y++) indices.copy(raw, y * (width + 1) + 1, y * width, (y + 1) * width);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", ihdr),
    pngChunk("PLTE", Buffer.from(palette.flat())),
    pngChunk("IDAT", zlib.deflateSync(raw)),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

// A solid RGB picture, the cheapest fixture that has the size a case is about.
function solidRgb(width, height, colour) {
  const rgb = Buffer.alloc(width * height * 3);
  for (let index = 0; index < width * height; index++) rgb.set(colour, index * 3);
  return { width, height, rgb };
}

let failed = 0;
let checked = 0;
function check(what, ok, detail) {
  checked++;
  if (ok) process.stdout.write("  ok   " + what + "\n");
  else {
    failed++;
    process.stdout.write("  FAIL " + what + (detail ? " -- " + detail : "") + "\n");
  }
}

// The checker as JSON, so a count is a number and not a sentence to parse. The
// exit status comes back with it: the checker writes its report to stdout and
// only then exits 1, so a failing run is read here rather than thrown away.
function runChecker(args) {
  try {
    return {
      status: 0,
      json: JSON.parse(
        execFileSync(process.execPath, [CHECKER, "--json", "--quiet", ...args], {
          cwd: PROJECT_ROOT,
          encoding: "utf8",
          maxBuffer: 64 * 1024 * 1024,
        })
      ),
    };
  } catch (error) {
    if (error.status === undefined || typeof error.stdout !== "string" || !error.stdout.trim()) throw error;
    return { status: error.status, json: JSON.parse(error.stdout) };
  }
}

process.stdout.write("source art is told apart from art no entry claims\n");
for (const folder of SOURCE_ART_DIRS) {
  check("a picture in " + folder + "/ is source art", isSourceArt(path.join(ART_DIR, folder, "x.png"), ART_DIR));
  check("a NOTES.md in " + folder + "/ is source art too", isSourceArt(path.join(ART_DIR, folder, "NOTES.md"), ART_DIR));
}
check("a folder whose name only starts with a source folder's is not source art", !isSourceArt(path.join(ART_DIR, "hud2", "x.png"), ART_DIR));
check("only the FIRST path component counts", !isSourceArt(path.join(ART_DIR, "pics", "hud", "x.png"), ART_DIR));
check("so a source folder's name deeper in the path is not one", !isSourceArt(path.join(ART_DIR, "textures", "e1u1", "hud", "x.png"), ART_DIR));
check("an entry's own art is not source art", !isSourceArt(path.join(ART_DIR, "pics", "num_0.png"), ART_DIR));
check("the art directory itself is not source art", !isSourceArt(ART_DIR, ART_DIR));
check("a path outside the art directory is not source art", !isSourceArt(path.join(os.tmpdir(), "hud", "x.png"), ART_DIR));
check("a custom art directory carries the rule with it", isSourceArt(path.join(os.tmpdir(), "somewhere", "hud", "x.png"), path.join(os.tmpdir(), "somewhere")));

// The declaration is only worth having if it stays tied to its record: a folder
// declared here is claiming "this is source art, and here is why", so each one
// has to be a folder that exists and holds the NOTES.md that says so.
// Takes the folder's own path: the probe below lives outside the art directory,
// and path.join does not reset on an absolute second argument (path.resolve
// does), so a version of this that took a bare name would quietly check
// <art dir>/<tmp path> and report a folder as undocumented whatever it held.
const documented = (folderPath) => fs.existsSync(path.join(folderPath, "NOTES.md"));
check(
  "every declared source folder is there and holds its NOTES.md",
  SOURCE_ART_DIRS.every((folder) => documented(path.join(ART_DIR, folder))),
  SOURCE_ART_DIRS.filter((folder) => !documented(path.join(ART_DIR, folder))).join(", ")
);
// ...and that the check can fail, or it is asserting nothing. Probed on a folder
// made here for the purpose: naming a real folder of the project that happens to
// hold no NOTES.md today would make this test fail the day somebody documents it,
// which is a documentation change and none of this code's business.
{
  const undocumented = fs.mkdtempSync(path.join(os.tmpdir(), "tex-lib-notes-"));
  try {
    check("which is a check that can fail", !documented(undocumented), undocumented + " counted as documented");
  } finally {
    fs.rmSync(undocumented, { recursive: true, force: true });
  }
}
check(
  "and the declaration is the three folders the docs name",
  JSON.stringify([...SOURCE_ART_DIRS].sort()) === JSON.stringify(["hud", "map", "model"]),
  JSON.stringify(SOURCE_ART_DIRS)
);

process.stdout.write("\nan --only run claims the art it did not check\n");
{
  const { status, json } = runChecker(["--only", "models/"]);
  check("--only models/ checks the model pictures", json.withArt === 125, "withArt " + json.withArt);
  check("--only models/ reports no art no entry claims", json.orphans === 0, "orphans " + json.orphans);
  check("--only models/ still counts the source art", json.sourceArt === 15, "sourceArt " + json.sourceArt);
  check("--only models/ checks every picture it did name", json.mismatched === 0 && json.unreadable === 0);
  check("--only models/ passes", status === 0, "exit " + status);
}

// The other half of the same rule: with --only in force, a picture that really
// is nobody's is still reported. Made in a temporary art directory, so the
// project's own tree is not touched.
{
  const stray = fs.mkdtempSync(path.join(os.tmpdir(), "tex-lib-test-"));
  try {
    fs.writeFileSync(path.join(stray, "nobody-claims-me.png"), fs.readFileSync(path.join(ART_DIR, "hud", "pics_quit.png")));
    const { json } = runChecker(["--art", stray]);
    check("a stray picture is reported as unclaimed", json.orphans === 1, "orphans " + json.orphans);
    check("and it is named", (json.orphanNames ?? []).some((name) => name.endsWith("nobody-claims-me.png")), JSON.stringify(json.orphanNames));
  } finally {
    fs.rmSync(stray, { recursive: true, force: true });
  }
}

// The gates. Everything above is a report; these are the two that stop a run,
// and the engine reading past a texture is the failure they exist for: a picture
// whose size disagrees with its entry must fail the check, and --require-all is
// the switch that makes missing art fail too. Both are run in a temporary art
// directory holding one crafted picture, so the project's tree is never written
// to and the assertions are about exactly one entry.
process.stdout.write("\na picture of the wrong size fails, missing art fails only under --require-all\n");
{
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "tex-lib-gates-"));
  const artPath = (name) => {
    const at = path.join(sandbox, name.replace(/\.[a-z0-9]+$/i, ".png"));
    fs.mkdirSync(path.dirname(at), { recursive: true });
    return at;
  };
  const real = fs.readFileSync(path.join(ART_DIR, "pics", "num_0.png"));
  try {
    // pics/num_0.pcx is 16x24. The header is what the checker reads first, so a
    // one-pixel-wider IHDR is a wrong-size picture and nothing else.
    const wrong = Buffer.from(real);
    wrong.writeUInt32BE(wrong.readUInt32BE(16) + 1, 16);
    fs.writeFileSync(artPath("pics/num_0.pcx"), wrong);
    const report = runChecker(["--art", sandbox]);
    check("a picture the wrong size fails the check", report.status === 1, "exit " + report.status);
    check("and is reported as a size mismatch", report.json.mismatched === 1, "mismatched " + report.json.mismatched);
    check(
      "and the entry is named with both sizes",
      JSON.stringify(report.json.mismatches?.[0]?.name) === JSON.stringify("pics/num_0.pcx") && report.json.mismatches[0].want === "16x24",
      JSON.stringify(report.json.mismatches?.[0])
    );

    // The same directory with the real picture in it passes, and the entries with
    // no art here are a warning and not a failure -- that is the difference
    // --require-all exists to change.
    fs.writeFileSync(artPath("pics/num_0.pcx"), real);
    const ok = runChecker(["--art", sandbox]);
    check("the same run with the real picture passes", ok.status === 0, "exit " + ok.status);
    check("missing art alone is a warning, not a failure", ok.json.missing > 0 && ok.json.ok === true, "missing " + ok.json.missing + " ok " + ok.json.ok);

    const strict = runChecker(["--art", sandbox, "--require-all"]);
    check("--require-all turns missing art into a failure", strict.status === 1, "exit " + strict.status);
    check(
      "and accounts for every picture it did not find",
      strict.json.missing === strict.json.artTargets - strict.json.withArt && strict.json.ok === false,
      "missing " + strict.json.missing + " of " + strict.json.artTargets + " with " + strict.json.withArt
    );

    // A file that is not a PNG at all is the other way a picture can be unusable.
    fs.writeFileSync(artPath("pics/num_0.pcx"), Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from("not a png body")]));
    const broken = runChecker(["--art", sandbox]);
    check("a file that is not a readable PNG fails the check", broken.status === 1 && broken.json.unreadable === 1, "exit " + broken.status + " unreadable " + broken.json.unreadable);
  } finally {
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
}

// The 4x wall art contract lives on two library pieces: the PNG reader has to
// read the indexed form the artists' tool may emit, and the reducer has to turn a
// 4x picture into the entry's pixels by averaging whole blocks. Both are pinned
// here, on pictures made in the test, before either tool that uses them.
process.stdout.write("\nthe PNG reader reads an indexed (colour type 3) picture\n");
{
  const palette = [
    [10, 20, 30],
    [200, 100, 50],
    [0, 0, 0],
    [250, 250, 250],
  ];
  const indices = Buffer.from([0, 1, 2, 3, 3, 2, 1, 0, 1, 0, 3, 2, 2, 3, 0, 1]);
  const png = encodePngIndexed(4, 4, indices, palette);
  const size = pngSize(png);
  check("the header of an indexed picture gives its size", size.width === 4 && size.height === 4, JSON.stringify(size));
  const image = decodePng(png);
  check("an indexed picture decodes at its size", image.width === 4 && image.height === 4, image.width + "x" + image.height);
  const expected = Array.from(indices, (index) => [...palette[index], 255]);
  const got = [];
  for (let pixel = 0; pixel < 16; pixel++) got.push([...image.data.subarray(pixel * 4, pixel * 4 + 4)]);
  check("and its pixels are the palette colours, in index order", JSON.stringify(got) === JSON.stringify(expected), JSON.stringify(got.slice(0, 4)));
  check("an indexed picture is opaque", got.every((pixel) => pixel[3] === 255), JSON.stringify(got.find((pixel) => pixel[3] !== 255)));
}

process.stdout.write("\n4x art is reduced by averaging each whole block\n");
{
  // A 4x4 picture of four 2x2 blocks: each destination pixel is the mean of its
  // block, which for a constant block is the block's colour.
  const rgba = Buffer.alloc(4 * 4 * 4);
  const blocks = [
    [200, 0, 0],
    [0, 200, 0],
    [0, 0, 200],
    [200, 200, 0],
  ];
  for (let y = 0; y < 4; y++) {
    for (let x = 0; x < 4; x++) {
      const colour = blocks[(y < 2 ? 0 : 2) + (x < 2 ? 0 : 1)];
      rgba.set([...colour, 255], (y * 4 + x) * 4);
    }
  }
  const reduced = downsampleRgba(rgba, 4, 4, 2, 2);
  const got = [];
  for (let pixel = 0; pixel < 4; pixel++) got.push([...reduced.data.subarray(pixel * 4, pixel * 4 + 3)]);
  check("a 4x picture reduces to a quarter in each direction", reduced.width === 2 && reduced.height === 2, reduced.width + "x" + reduced.height);
  check("and each pixel is its block's colour", JSON.stringify(got) === JSON.stringify(blocks), JSON.stringify(got));

  // Unequal values average rather than point-sample: three zeros and a 255 give
  // 64, round half up from 63.75 -- and never one of the source values alone.
  const mixed = Buffer.alloc(2 * 2 * 4, 0);
  mixed[4] = 255; // the red channel of the second pixel
  for (let pixel = 0; pixel < 4; pixel++) mixed[pixel * 4 + 3] = 255;
  const one = downsampleRgba(mixed, 2, 2, 1, 1);
  check("a block is averaged, not point-sampled", one.data[0] === 64, "red " + one.data[0]);
  check("and alpha is averaged too", one.data[3] === 255, "alpha " + one.data[3]);
}

// The checker's half of the contract: a wall's art may be exactly HIRES_SCALE
// times its entry and is counted as such; anything else is still a mismatch, and
// a PCX never gets the allowance. All on a temporary art directory.
process.stdout.write("\ntex-check accepts wall art at 4x, and counts it\n");
{
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "tex-lib-hires-"));
  const at = (name) => {
    const file = path.join(sandbox, name.replace(/\.[a-z0-9]+$/i, ".png"));
    fs.mkdirSync(path.dirname(file), { recursive: true });
    return file;
  };
  // textures/e1u1/metal2_1.wal is 64x128 in the archive, so 4x is 256x512.
  try {
    const picture = solidRgb(64 * HIRES_SCALE, 128 * HIRES_SCALE, [64, 96, 128]);
    const file = at("textures/e1u1/metal2_1.wal");
    fs.writeFileSync(file, encodePngRgb(picture.width, picture.height, picture.rgb));
    const report = runChecker(["--art", sandbox]);
    check("4x wall art passes the check", report.status === 0, "exit " + report.status + " " + JSON.stringify(report.json.mismatches));
    check("and is counted as hires", report.json.hires === 1, "hires " + report.json.hires);
    check("and its bytes are counted with it", report.json.hiresBytes === fs.statSync(file).size, "bytes " + report.json.hiresBytes + " of " + fs.statSync(file).size);
    check("and it is the entry that was counted", JSON.stringify(report.json.hiresNames) === JSON.stringify(["textures/e1u1/metal2_1.wal"]), JSON.stringify(report.json.hiresNames));
    check("and it counts as art, not as a mismatch", report.json.withArt === 1 && report.json.mismatched === 0, "withArt " + report.json.withArt + " mismatched " + report.json.mismatched);

    // 2x and 3x are neither the entry nor 4x its size, so both fail.
    const two = solidRgb(128, 256, [64, 96, 128]);
    fs.writeFileSync(file, encodePngRgb(two.width, two.height, two.rgb));
    const doubled = runChecker(["--art", sandbox]);
    check("2x wall art fails", doubled.status === 1 && doubled.json.mismatched === 1, "exit " + doubled.status + " mismatched " + doubled.json.mismatched);
    check("and the failure names both allowed sizes", doubled.json.mismatches?.[0]?.want === "64x128 or 256x512", JSON.stringify(doubled.json.mismatches?.[0]));
    check("and 2x art is not counted as hires", doubled.json.hires === 0, "hires " + doubled.json.hires);

    const three = solidRgb(192, 384, [64, 96, 128]);
    fs.writeFileSync(file, encodePngRgb(three.width, three.height, three.rgb));
    const tripled = runChecker(["--art", sandbox]);
    check("3x wall art fails too", tripled.status === 1 && tripled.json.mismatched === 1, "exit " + tripled.status + " mismatched " + tripled.json.mismatched);

    // The right pixel count in the wrong shape is not 4x, either.
    const squashed = solidRgb(512, 256, [64, 96, 128]);
    fs.writeFileSync(file, encodePngRgb(squashed.width, squashed.height, squashed.rgb));
    const aspect = runChecker(["--art", sandbox]);
    check("4x pixels in the wrong shape fail", aspect.status === 1 && aspect.json.mismatched === 1, "exit " + aspect.status + " mismatched " + aspect.json.mismatched);

    // A PCX is drawn from its own pixels, not through r_retexturing, so it never
    // gets the 4x allowance: pics/num_0.pcx is 16x24, and 64x96 is 4x it.
    fs.writeFileSync(file, encodePngRgb(256, 512, solidRgb(256, 512, [64, 96, 128]).rgb));
    const pcx = at("pics/num_0.pcx");
    const huge = solidRgb(64, 96, [200, 200, 200]);
    fs.writeFileSync(pcx, encodePngRgb(huge.width, huge.height, huge.rgb));
    const wrong = runChecker(["--art", sandbox]);
    check("4x-sized PCX art fails", wrong.status === 1 && wrong.json.mismatched === 1, "exit " + wrong.status + " mismatched " + wrong.json.mismatched);
    check("and the PCX failure says exact size only", wrong.json.mismatches?.[0]?.name === "pics/num_0.pcx" && wrong.json.mismatches[0].want === "16x24", JSON.stringify(wrong.json.mismatches?.[0]));
  } finally {
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
}

process.stdout.write("\n" + (failed ? failed + " of " + checked + " checks FAILED\n" : "all " + checked + " checks passed\n"));
process.exitCode = failed ? 1 : 0;
