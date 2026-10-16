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
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { PROJECT_ROOT, SOURCE_ART_DIRS, isSourceArt } from "./texture-lib.mjs";

const CHECKER = path.join(path.dirname(fileURLToPath(import.meta.url)), "tex-check.mjs");
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
check("an entry's own art is not source art", !isSourceArt(path.join(ART_DIR, "pics", "num_0.png"), ART_DIR));
check("the art directory itself is not source art", !isSourceArt(ART_DIR, ART_DIR));
check("a path outside the art directory is not source art", !isSourceArt(path.join(os.tmpdir(), "hud", "x.png"), ART_DIR));
check("a custom art directory carries the rule with it", isSourceArt(path.join(os.tmpdir(), "somewhere", "hud", "x.png"), path.join(os.tmpdir(), "somewhere")));

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

process.stdout.write("\n" + (failed ? failed + " of " + checked + " checks FAILED\n" : "all " + checked + " checks passed\n"));
process.exitCode = failed ? 1 : 0;
