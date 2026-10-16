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

// The checker as JSON, so a count is a number and not a sentence to parse.
function runChecker(args) {
  const stdout = execFileSync(process.execPath, [CHECKER, "--json", "--quiet", ...args], {
    cwd: PROJECT_ROOT,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  return JSON.parse(stdout);
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
  const models = runChecker(["--only", "models/"]);
  check("--only models/ checks the model pictures", models.withArt === 125, "withArt " + models.withArt);
  check("--only models/ reports no art no entry claims", models.orphans === 0, "orphans " + models.orphans);
  check("--only models/ still counts the source art", models.sourceArt === 15, "sourceArt " + models.sourceArt);
  check("--only models/ checks every picture it did name", models.mismatched === 0 && models.unreadable === 0);
}

// The other half of the same rule: with --only in force, a picture that really
// is nobody's is still reported. Made in a temporary art directory, so the
// project's own tree is not touched.
{
  const stray = fs.mkdtempSync(path.join(os.tmpdir(), "tex-lib-test-"));
  try {
    fs.writeFileSync(path.join(stray, "nobody-claims-me.png"), fs.readFileSync(path.join(ART_DIR, "hud", "pics_quit.png")));
    const report = runChecker(["--art", stray]);
    check("a stray picture is reported as unclaimed", report.orphans === 1, "orphans " + report.orphans);
    check("and it is named", (report.orphanNames ?? []).some((name) => name.endsWith("nobody-claims-me.png")), JSON.stringify(report.orphanNames));
  } finally {
    fs.rmSync(stray, { recursive: true, force: true });
  }
}

process.stdout.write("\n" + (failed ? failed + " of " + checked + " checks FAILED\n" : "all " + checked + " checks passed\n"));
process.exitCode = failed ? 1 : 0;
