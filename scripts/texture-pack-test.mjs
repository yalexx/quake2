#!/usr/bin/env node
// scripts/texture-pack-test.mjs -- what scripts/texture-pack.mjs refuses, and
// what it leaves behind.
//
//   node scripts/texture-pack-test.mjs    # exit 0 pass, 1 fail
//
// The packer is the one tool that rewrites baseq2/pak0.pak, so the things worth
// pinning about it are the ways it is supposed to do nothing: it must refuse art
// that disagrees with its entry (a picture the wrong size is a texture the
// renderer reads past), it must report on a dry run without writing, and it must
// leave the archive it was given untouched when it is asked to write somewhere
// else. The archive it is pointed at here is always a copy in a temporary
// directory and the output is always another file there, so a run of this test
// cannot touch baseq2/pak0.pak -- which the last check proves rather than
// assumes.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { DEFAULT_PAK, HIRES_SCALE, PROJECT_ROOT, decodePng, readManifest, readPakDirectory, readWal } from "./texture-lib.mjs";

const PACKER = path.join(path.dirname(fileURLToPath(import.meta.url)), "texture-pack.mjs");
const ART_DIR = path.join(PROJECT_ROOT, "assets", "textures");

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

// The packer's JSON report and its exit status. It writes the report to stdout
// and only then exits, so a refusal is read here rather than thrown away.
function runPacker(args) {
  try {
    return { status: 0, json: JSON.parse(execFileSync(process.execPath, [PACKER, "--json", "--quiet", ...args], { cwd: PROJECT_ROOT, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 })) };
  } catch (error) {
    if (error.status === undefined) throw error;
    const stdout = (error.stdout ?? "").trim();
    return { status: error.status, json: stdout.startsWith("{") ? JSON.parse(stdout) : null, stderr: error.stderr ?? "" };
  }
}

// A PAK's entry count, read out of its own header, so "did it write a whole
// archive" is answered without the project's reader.
function pakEntries(file) {
  const head = Buffer.alloc(12);
  const fd = fs.openSync(file, "r");
  try {
    fs.readSync(fd, head, 0, 12, 0);
  } finally {
    fs.closeSync(fd);
  }
  if (head.toString("latin1", 0, 4) !== "PACK") return -1;
  return head.readUInt32LE(8) / 64;
}

// A PNG writer for the fixtures below. Everything the 4x contract is checked
// against is built here from a real texture's own pixels, so no art arrives from
// a directory another task may be editing at the same time.
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

const clampByte = (value) => (value < 0 ? 0 : value > 255 ? 255 : value);

// The RGB of a decoded picture with every channel shifted, so the packed WAL
// cannot equal the original by accident and "it changed" means something.
function shiftedRgb(image, shift) {
  const rgb = Buffer.alloc(image.width * image.height * 3);
  for (let pixel = 0; pixel < image.width * image.height; pixel++) {
    rgb[pixel * 3] = clampByte(image.data[pixel * 4] + shift[0]);
    rgb[pixel * 3 + 1] = clampByte(image.data[pixel * 4 + 1] + shift[1]);
    rgb[pixel * 3 + 2] = clampByte(image.data[pixel * 4 + 2] + shift[2]);
  }
  return rgb;
}

// The same picture drawn at HIRES_SCALE with every block one flat colour. The
// area mean of a flat 4x4 block is exactly the 1x pixel, so a 4x picture made
// this way must pack the same WAL bytes as the 1x picture it was drawn from --
// which is how the reducer is checked through the tool, not just on its own.
function upscaleFlat(rgb, width, height, scale) {
  const outWidth = width * scale;
  const out = Buffer.alloc(outWidth * height * scale * 3);
  for (let y = 0; y < height * scale; y++) {
    for (let x = 0; x < outWidth; x++) {
      const source = ((y / scale) | 0) * width * 3 + ((x / scale) | 0) * 3;
      out[(y * outWidth + x) * 3] = rgb[source];
      out[(y * outWidth + x) * 3 + 1] = rgb[source + 1];
      out[(y * outWidth + x) * 3 + 2] = rgb[source + 2];
    }
  }
  return out;
}

const pngIn = (directory, entryName) => {
  const file = path.join(directory, entryName.replace(/\.[a-z0-9]+$/i, ".png"));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  return file;
};

process.stdout.write("the archive on disk is exactly the art on disk\n");
{
  const { status, json } = runPacker(["--check"]);
  check("--check passes on the project's own archive", status === 0, "exit " + status);
  check("and it says the archive was left alone", json?.plan?.changed === false, JSON.stringify(json?.plan));
  check("and it checked every picture that has art", (json?.packed?.length ?? 0) > 0 && json.failures.length === 0, "packed " + json?.packed?.length);
}

process.stdout.write("\nart that disagrees with its entry is refused and nothing is written\n");
{
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "texture-pack-test-"));
  const input = path.join(sandbox, "in.pak");
  const output = path.join(sandbox, "out.pak");
  fs.copyFileSync(DEFAULT_PAK, input);
  const inputBefore = fs.readFileSync(input);
  const artPath = path.join(sandbox, "art", "pics", "num_0.png");
  fs.mkdirSync(path.dirname(artPath), { recursive: true });
  try {
    // A picture of a size the entry is not: a real 56x56 sprite frame put where
    // pics/num_0.pcx (16x24) keeps its art. The packer has to name both sizes.
    fs.writeFileSync(artPath, fs.readFileSync(path.join(ART_DIR, "sprites", "s_explod_0.png")));
    const { status, json } = runPacker(["--pak", input, "--out", output, "--art", path.join(sandbox, "art"), "--only", "pics/num_0"]);
    check("a picture the wrong size fails the run", status === 1, "exit " + status);
    check(
      "and the failure names the entry and both sizes",
      json?.failures?.[0]?.name === "pics/num_0.pcx" && /56x56/.test(json.failures[0].problem) && /16x24/.test(json.failures[0].problem),
      JSON.stringify(json?.failures?.[0])
    );
    check("and no archive is written", !fs.existsSync(output), output + " appeared");
    check("and the archive it was given is untouched", fs.readFileSync(input).equals(inputBefore));

    // A header that lies about the data behind it is caught too, by the decoder
    // rather than by the size check -- measured, because the message a picture
    // like that gets is a different one.
    const lying = Buffer.from(fs.readFileSync(path.join(ART_DIR, "pics", "num_0.png")));
    lying.writeUInt32BE(lying.readUInt32BE(16) + 1, 16);
    fs.writeFileSync(artPath, lying);
    const lied = runPacker(["--pak", input, "--out", output, "--art", path.join(sandbox, "art"), "--only", "pics/num_0"]);
    check("a PNG header that lies about its data also fails", lied.status === 1 && lied.json?.failures?.length === 1, "exit " + lied.status);
    check("and is refused for the lie, not passed on", !fs.existsSync(output));

    // The same directory with the real picture packs, into the output file, and
    // still leaves its input alone.
    fs.writeFileSync(artPath, fs.readFileSync(path.join(ART_DIR, "pics", "num_0.png")));
    const ok = runPacker(["--pak", input, "--out", output, "--art", path.join(sandbox, "art"), "--only", "pics/num_0"]);
    check("the same run with the real picture writes its output", ok.status === 0 && fs.existsSync(output), "exit " + ok.status + " out " + fs.existsSync(output));
    check("and the output is a whole archive", pakEntries(output) === pakEntries(input) && pakEntries(output) > 0, "out " + pakEntries(output) + " in " + pakEntries(input));
    check("and the archive it was given is still untouched", fs.readFileSync(input).equals(inputBefore));

    // A dry run reports and writes nothing at all.
    fs.rmSync(output, { force: true });
    const dry = runPacker(["--pak", input, "--out", output, "--dry-run"]);
    check("--dry-run reports the plan", dry.status === 0 && (dry.json?.plan?.entries ?? 0) > 0, "exit " + dry.status);
    check("--dry-run writes nothing", !fs.existsSync(output), output + " appeared");
  } finally {
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
}

// A wall drawn at HIRES_SCALE times its entry: averaged down into pak0 exactly
// as 1x art would pack (the blocks are flat, so the mean is the 1x pixel), and
// copied verbatim into the second archive the engine's r_retexturing reads.
process.stdout.write("\n4x wall art packs into both archives\n");
{
  const manifest = readManifest();
  const entry = manifest.entries.find((item) => item.name === "textures/e1u1/metal2_1.wal");
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "texture-pack-hires-"));
  const input = path.join(sandbox, "in.pak");
  const out = path.join(sandbox, "out.pak");
  const hires = path.join(sandbox, "pak9.pak");
  const outOne = path.join(sandbox, "out-1x.pak");
  const hiresOne = path.join(sandbox, "pak9-1x.pak");
  const art4 = path.join(sandbox, "art4");
  const art1 = path.join(sandbox, "art1");
  try {
    fs.copyFileSync(DEFAULT_PAK, input);
    const inputBefore = fs.readFileSync(input);
    check("the fixture entry is a wall in the manifest", Boolean(entry && entry.type === "wal" && entry.png), JSON.stringify(entry?.name));

    // The picture, from the project's own 1x art for that entry, shifted so the
    // packed bytes cannot match the original by luck, then drawn two ways.
    const source = decodePng(fs.readFileSync(path.join(PROJECT_ROOT, entry.png)));
    const oneX = shiftedRgb(source, [24, -16, 8]);
    const fourX = upscaleFlat(oneX, source.width, source.height, HIRES_SCALE);
    const onePng = encodePngRgb(source.width, source.height, oneX);
    const fourPng = encodePngRgb(source.width * HIRES_SCALE, source.height * HIRES_SCALE, fourX);
    fs.writeFileSync(pngIn(art4, entry.name), fourPng);
    fs.writeFileSync(pngIn(art1, entry.name), onePng);

    const pack4 = runPacker(["--pak", input, "--out", out, "--hires-out", hires, "--art", art4]);
    check("4x wall art packs without a failure", pack4.status === 0 && pack4.json.failures.length === 0, "exit " + pack4.status + " " + JSON.stringify(pack4.json.failures));
    check("both archives are written", fs.existsSync(out) && fs.existsSync(hires), "out " + fs.existsSync(out) + " hires " + fs.existsSync(hires));
    check("the entry is reported as packed from 4x art", pack4.json.packed.find((item) => item.name === entry.name)?.hires === true, JSON.stringify(pack4.json.packed));
    check("and the summary counts one hires picture", pack4.json.hires.entries === 1, "entries " + pack4.json.hires.entries);
    check("and its bytes are the PNG's own", pack4.json.hires.bytes === fourPng.length, "bytes " + pack4.json.hires.bytes + " of " + fourPng.length);
    check("and the archive has room for it", pack4.json.hires.archiveBytes > fourPng.length, "archiveBytes " + pack4.json.hires.archiveBytes);
    check("and it is named as the WAL name with .png", JSON.stringify(pack4.json.hires.names) === JSON.stringify(["textures/e1u1/metal2_1.png"]), JSON.stringify(pack4.json.hires.names));

    // pak9's picture is the file on disk, untouched: no re-encoding, no palette.
    const hiresBuffer = fs.readFileSync(hires);
    const hiresDir = readPakDirectory(hiresBuffer);
    const hireEntry = hiresDir.get("textures/e1u1/metal2_1.png");
    check("pak9 holds exactly that one picture", hiresDir.size === 1 && Boolean(hireEntry), hiresDir.size + " entries");
    check(
      "and its bytes are the 4x PNG, byte for byte",
      Boolean(hireEntry) && hiresBuffer.subarray(hireEntry.offset, hireEntry.offset + hireEntry.length).equals(fourPng),
      "entry " + (hireEntry ? hireEntry.length : "missing") + " bytes, png " + fourPng.length
    );

    // The WAL in pak0: new pixels, same everything else.
    const inputBuffer = fs.readFileSync(input);
    const inputDir = readPakDirectory(inputBuffer);
    const outBuffer = fs.readFileSync(out);
    const outDir = readPakDirectory(outBuffer);
    const before = inputDir.get(entry.name);
    const after = outDir.get(entry.name);
    const beforeBytes = inputBuffer.subarray(before.offset, before.offset + before.length);
    const afterBytes = outBuffer.subarray(after.offset, after.offset + after.length);
    check("pak0's wall entry changed", !afterBytes.equals(beforeBytes), "the packed entry is unchanged");
    const beforeWal = readWal(beforeBytes);
    const afterWal = readWal(afterBytes);
    check("the wall is the same size", afterWal.width === beforeWal.width && afterWal.height === beforeWal.height, afterWal.width + "x" + afterWal.height);
    check(
      "and keeps its name and header fields",
      afterWal.name === beforeWal.name && afterWal.flags === beforeWal.flags && afterWal.contents === beforeWal.contents && afterWal.value === beforeWal.value,
      JSON.stringify({ name: afterWal.name, flags: afterWal.flags, contents: afterWal.contents, value: afterWal.value })
    );
    check("and the archive it was given is untouched", fs.readFileSync(input).equals(inputBefore));

    // The reducer, through the tool: 4x art made of flat blocks must pack the
    // same WAL bytes as the 1x picture those blocks were drawn from.
    const pack1 = runPacker(["--pak", input, "--out", outOne, "--hires-out", hiresOne, "--art", art1]);
    check("the same picture at 1x also packs", pack1.status === 0 && fs.existsSync(outOne), "exit " + pack1.status);
    const outOneDir = readPakDirectory(fs.readFileSync(outOne));
    const oneEntry = outOneDir.get(entry.name);
    check(
      "and 4x art packs the identical WAL to its 1x original",
      oneEntry && fs.readFileSync(outOne).subarray(oneEntry.offset, oneEntry.offset + oneEntry.length).equals(afterBytes),
      "the two packed entries differ"
    );
    check("1x art makes no hires archive", !fs.existsSync(hiresOne) && pack1.json.hires.entries === 0, "hires " + fs.existsSync(hiresOne) + " entries " + pack1.json.hires.entries);

    // Determinism: a second run, to fresh paths, gives a byte-identical pak9;
    // and a second run over its own output leaves both archives alone.
    const outAgain = path.join(sandbox, "out-again.pak");
    const hiresAgain = path.join(sandbox, "pak9-again.pak");
    const packAgain = runPacker(["--pak", input, "--out", outAgain, "--hires-out", hiresAgain, "--art", art4]);
    check("a second run is byte-identical in pak0", packAgain.status === 0 && fs.readFileSync(outAgain).equals(fs.readFileSync(out)), "exit " + packAgain.status);
    check("and in pak9", fs.readFileSync(hiresAgain).equals(hiresBuffer), "the two pak9 files differ");
    const packIdle = runPacker(["--pak", input, "--out", out, "--hires-out", hires, "--art", art4]);
    check("a run over its own output writes nothing", packIdle.status === 0 && packIdle.json.plan.written === false && packIdle.json.hires.written === false, JSON.stringify(packIdle.json.hires));

    // --check: both archives, and a stale hires archive fails.
    const checkOk = runPacker(["--pak", input, "--out", out, "--hires-out", hires, "--art", art4, "--check"]);
    check("--check passes when both archives match", checkOk.status === 0, "exit " + checkOk.status + " " + (checkOk.stderr ?? "").slice(0, 120));
    fs.appendFileSync(hires, Buffer.from([0]));
    const checkStale = runPacker(["--pak", input, "--out", out, "--hires-out", hires, "--art", art4, "--check"]);
    check("--check fails on a stale pak9", checkStale.status === 1, "exit " + checkStale.status);
    check("and says the hires archive is not up to date", /pak9\.pak is not up to date/.test(checkStale.stderr ?? ""), JSON.stringify((checkStale.stderr ?? "").slice(0, 160)));
    fs.rmSync(hires, { force: true });
    const checkMissing = runPacker(["--pak", input, "--out", out, "--hires-out", hires, "--art", art4, "--check"]);
    check("--check fails when pak9 is missing", checkMissing.status === 1, "exit " + checkMissing.status);

    // A pak9 with no 4x art behind it is stale too: the 1x run wrote none.
    fs.writeFileSync(hiresOne, fs.readFileSync(path.join(DEFAULT_PAK)));
    const checkOrphan = runPacker(["--pak", input, "--out", outOne, "--hires-out", hiresOne, "--art", art1, "--check"]);
    check("--check fails on a pak9 with no 4x art behind it", checkOrphan.status === 1, "exit " + checkOrphan.status);
    check("and says there is no 4x art", /no 4x art to make it from/.test(checkOrphan.stderr ?? ""), JSON.stringify((checkOrphan.stderr ?? "").slice(0, 160)));

    // Art the wrong size: 2x, 3x and the right count in the wrong shape are all
    // refused for a wall, and a PCX never gets the 4x allowance at all.
    const cases = [
      { what: "2x wall art", name: entry.name, width: source.width * 2, height: source.height * 2, allow: /128x256/ },
      { what: "3x wall art", name: entry.name, width: source.width * 3, height: source.height * 3, allow: /192x384/ },
      { what: "4x wall art in the wrong shape", name: entry.name, width: source.width * HIRES_SCALE, height: source.height * 2, allow: /256x256/ },
      { what: "4x-sized PCX art", name: "pics/num_0.pcx", width: 16 * HIRES_SCALE, height: 24 * HIRES_SCALE, allow: /exact size only/ },
    ];
    for (const [index, item] of cases.entries()) {
      const artBad = path.join(sandbox, "art-bad-" + index);
      const badFile = pngIn(artBad, item.name);
      const rgb = Buffer.alloc(item.width * item.height * 3, 96);
      fs.writeFileSync(badFile, encodePngRgb(item.width, item.height, rgb));
      const badOut = path.join(sandbox, "bad-" + index + ".pak");
      const badHires = path.join(sandbox, "bad-" + index + "-pak9.pak");
      const bad = runPacker(["--pak", input, "--out", badOut, "--hires-out", badHires, "--art", artBad]);
      check(item.what + " fails", bad.status === 1, "exit " + bad.status);
      check("and the failure is for that entry", bad.json?.failures?.[0]?.name === item.name, JSON.stringify(bad.json?.failures?.[0]));
      check("and it names the size it got", item.allow.test(bad.json?.failures?.[0]?.problem ?? ""), JSON.stringify(bad.json?.failures?.[0]?.problem));
      check("and neither archive is written", !fs.existsSync(badOut) && !fs.existsSync(badHires), "out " + fs.existsSync(badOut) + " hires " + fs.existsSync(badHires));
    }

    // A dry run of the 4x case reports both archives and writes neither.
    const dryOut = path.join(sandbox, "dry.pak");
    const dryHires = path.join(sandbox, "dry-pak9.pak");
    fs.writeFileSync(pngIn(art4, entry.name), fourPng);
    const dry = runPacker(["--pak", input, "--out", dryOut, "--hires-out", dryHires, "--art", art4, "--dry-run"]);
    check("--dry-run reports the pak0 plan", dry.status === 0 && dry.json.plan.entries > 0, "exit " + dry.status);
    check("and the hires entry and bytes", dry.json.hires.entries === 1 && dry.json.hires.bytes === fourPng.length, JSON.stringify(dry.json.hires));
    check("--dry-run writes neither archive", !fs.existsSync(dryOut) && !fs.existsSync(dryHires), "out " + fs.existsSync(dryOut) + " hires " + fs.existsSync(dryHires));
  } finally {
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
}

process.stdout.write("\nbad input is refused in words\n");
{
  const { status, stderr } = runPacker(["--only", "no-such-entry-anywhere"]);
  check("an --only that matches no entry exits 2", status === 2, "exit " + status);
  check("and says so in a sentence", /no entry in the manifest matches/.test(stderr), JSON.stringify(stderr.slice(0, 120)));

  const missing = runPacker(["--pak", path.join(os.tmpdir(), "definitely-not-a-pak.pak"), "--dry-run"]);
  check("a pak that is not there exits 2", missing.status === 2, "exit " + missing.status);
  check("and says so in a sentence", /cannot read the pak/.test(missing.stderr ?? ""), JSON.stringify((missing.stderr ?? "").slice(0, 120)));

  // Two archives at one path is one archive, and the second write would replace
  // the first; the tool says so before writing anything.
  const same = path.join(os.tmpdir(), "texture-pack-same-" + process.pid + ".pak");
  const clash = runPacker(["--out", same, "--hires-out", same, "--dry-run"]);
  check("a hires archive over the packed archive exits 2", clash.status === 2, "exit " + clash.status);
  check("and says the two cannot be one file", /cannot be the same file/.test(clash.stderr ?? ""), JSON.stringify((clash.stderr ?? "").slice(0, 160)));
  check("and nothing is written", !fs.existsSync(same), same + " appeared");
}

process.stdout.write("\nand everything above ran on copies\n");
{
  // The point of making every run use a temporary pak: the game's own archive is
  // not something a test may write to. Read back against the committed copy, so
  // that is proven rather than intended.
  let committed = null;
  try {
    committed = execFileSync("git", ["cat-file", "blob", "HEAD:baseq2/pak0.pak"], { cwd: PROJECT_ROOT, maxBuffer: 256 * 1024 * 1024 });
  } catch {
    committed = null;
  }
  if (!committed) process.stdout.write("  ..   baseq2/pak0.pak not compared (not a git checkout, or not committed)\n");
  else check("baseq2/pak0.pak is byte for byte the archive the commit holds", fs.readFileSync(DEFAULT_PAK).equals(committed));
}

process.stdout.write("\n" + (failed ? failed + " of " + checked + " checks FAILED\n" : "all " + checked + " checks passed\n"));
process.exitCode = failed ? 1 : 0;
