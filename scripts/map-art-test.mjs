#!/usr/bin/env node
// scripts/map-art-test.mjs -- which surfaces scripts/map-art.mjs says it draws.
//
//   node scripts/map-art-test.mjs    # exit 0 pass, 1 fail
//
// The tool used to read `manifest.maps[0]` only -- demo1's textures -- so the
// surfaces demo2 and demo3 put on a wall had no art and could not get any. It
// pools every map in the manifest now, a texture two maps share counted once
// with its uses summed. That is what these checks hold it to, through `--list`,
// which prints the plan and draws nothing: no pak is written, no PNG is written,
// and the whole test is a few seconds.
//
// The two halves that matter are that a texture only another map draws is in the
// plan at all, and that a shared one carries the uses of every map that wants
// it -- a count taken from one map would sort it as the minor tile it is not.
//
// Names are compared through `normalizeName` throughout, and never by building a
// path: an archive name is not uniform in case (demo3 asks for `e1u1/FLAT1_2`
// where another map asks for the same texture in lower case, and the archive
// holds entries in both), which is exactly the mistake a hand-built path makes.

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { PROJECT_ROOT, normalizeName, readManifest } from "./texture-lib.mjs";

const TOOL = path.join(path.dirname(fileURLToPath(import.meta.url)), "map-art.mjs");

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

const listing = execFileSync(process.execPath, [TOOL, "--list"], { cwd: PROJECT_ROOT, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
const rows = listing
  .split("\n")
  .map((line) => line.match(/^(\S+)\s+(\d+)\s+(\d+x\d+)\s+(.+)$/))
  .filter(Boolean)
  .map(([, name, uses, size, how]) => ({ name, key: normalizeName(name), uses: Number(uses), size, how }));
// Keyed as an archive name, so a row and a manifest entry meet whatever case each
// was written in.
const found = new Map(rows.map((row) => [normalizeName("textures/" + row.name + ".wal"), row]));

const manifest = readManifest();
const entryFor = new Map(manifest.entries.map((entry) => [normalizeName(entry.name), entry]));
const wanted = (row) => entryFor.get(normalizeName("textures/" + row.name + ".wal"));

process.stdout.write("every map's surfaces are in the plan, not just the first map's\n");
{
  const onFirstMap = new Set(manifest.maps[0].textures.filter((texture) => texture.uses > 0).map((texture) => normalizeName(texture.wal)));
  const onlyOthers = new Set();
  for (const map of manifest.maps.slice(1)) {
    for (const texture of map.textures) {
      if (texture.uses > 0 && !onFirstMap.has(normalizeName(texture.wal))) onlyOthers.add(normalizeName(texture.wal));
    }
  }

  check("the tool has a plan at all", rows.length > 0, rows.length + " rows");
  check("the archive has surfaces only the other maps draw", onlyOthers.size > 0, onlyOthers.size + " of them");
  const missing = [...onlyOthers].filter((name) => !found.has(name));
  check("the plan reaches them", missing.length === 0, missing.slice(0, 5).join(", ") + " missing");
  const otherRow = [...onlyOthers].map((name) => found.get(name)).find(Boolean);
  check("and names one of them with its size", Boolean(otherRow) && /^\d+x\d+$/.test(otherRow.size), JSON.stringify(otherRow));
  check("the plan is larger than the first map's own set", rows.length > onFirstMap.size, rows.length + " listed, " + onFirstMap.size + " on " + manifest.maps[0].name);
}

process.stdout.write("\na texture two maps share carries both maps' uses\n");
{
  const oneMap = new Map();
  const mapCount = new Map();
  for (const map of manifest.maps) {
    for (const texture of map.textures) {
      if (!(texture.uses > 0)) continue;
      const key = normalizeName(texture.wal);
      oneMap.set(key, Math.max(oneMap.get(key) ?? 0, texture.uses));
      mapCount.set(key, (mapCount.get(key) ?? 0) + 1);
    }
  }
  const shared = [...oneMap.keys()].filter((key) => mapCount.get(key) > 1);
  check("the archive has a texture more than one map draws", shared.length > 0, shared.length + " shared");
  const key = shared.sort((a, b) => oneMap.get(b) - oneMap.get(a))[0];
  const pooled = found.get(key);
  const summed = manifest.maps.reduce((total, map) => total + map.textures.filter((t) => normalizeName(t.wal) === key).reduce((n, t) => n + t.uses, 0), 0);
  check("the most-used shared texture is in the plan", Boolean(pooled), key);
  check("and its uses are the sum over every map", pooled?.uses === summed, key + ": listed " + pooled?.uses + ", summed " + summed);
  check("which is more than any single map wants of it", pooled?.uses > oneMap.get(key), key + ": " + pooled?.uses + " against one map's " + oneMap.get(key));
}

process.stdout.write("\nand the frames it refuses to touch on their own are still refused\n");
{
  const animated = rows.filter((row) => /^\+/.test(row.name.replace(/^.*\//, "")));
  check("the animated frames are listed", animated.length > 0, animated.length + " listed");
  check("and every one of them is marked skipped", animated.every((row) => /skipped \(animated frame\)/.test(row.how)), JSON.stringify(animated.find((row) => !/skipped/.test(row.how))));
  check("and none of them is given a recipe", animated.every((row) => !/procedural|generated/.test(row.how)));
}

process.stdout.write("\nand every row can actually be drawn\n");
{
  const drawable = rows.filter((row) => !/skipped/.test(row.how));
  const unresolved = drawable.filter((row) => !wanted(row)?.png);
  check("each drawn texture is an archive entry with an art path", unresolved.length === 0, unresolved.slice(0, 5).map((row) => row.name).join(", "));
  const wrongSize = drawable.filter((row) => {
    const entry = wanted(row);
    return !entry || row.size !== entry.width + "x" + entry.height;
  });
  check("each drawn texture is at the size its entry declares", wrongSize.length === 0, wrongSize.slice(0, 5).map((row) => row.name).join(", "));
  const missingArt = drawable.filter((row) => !fs.existsSync(path.join(PROJECT_ROOT, wanted(row)?.png ?? "")));
  check("each drawn texture has its picture on disk", missingArt.length === 0, missingArt.slice(0, 5).map((row) => row.name).join(", "));
}

process.stdout.write("\n" + (failed ? failed + " of " + checked + " checks FAILED\n" : "all " + checked + " checks passed\n"));
process.exitCode = failed ? 1 : 0;
