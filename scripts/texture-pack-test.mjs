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
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { DEFAULT_PAK, PROJECT_ROOT } from "./texture-lib.mjs";

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

process.stdout.write("\nbad input is refused in words\n");
{
  const { status, stderr } = runPacker(["--only", "no-such-entry-anywhere"]);
  check("an --only that matches no entry exits 2", status === 2, "exit " + status);
  check("and says so in a sentence", /no entry in the manifest matches/.test(stderr), JSON.stringify(stderr.slice(0, 120)));

  const missing = runPacker(["--pak", path.join(os.tmpdir(), "definitely-not-a-pak.pak"), "--dry-run"]);
  check("a pak that is not there exits 2", missing.status === 2, "exit " + missing.status);
  check("and says so in a sentence", /cannot read the pak/.test(missing.stderr ?? ""), JSON.stringify((missing.stderr ?? "").slice(0, 120)));
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
