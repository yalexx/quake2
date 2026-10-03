#!/usr/bin/env node
// scripts/control-api-test.mjs -- check the HTTP control API (control/server.mjs)
// route by route, from the project root, with plain `node`.
//
// It starts its own control/server.mjs -- one on a free port the OS picks
// (CONTROL_PORT=0), and a second one pointed at a CDP endpoint that is not
// there, for the error paths -- so nothing has to be running except the browser
// the box already has. It stops only the two children it started, and it never
// touches the live control API on 4233, the game server on 4231 or
// quake2-app.service.
//
// It needs no game open: the routes that only read or reject a request are
// checked either way, and a route that can only answer with a game open is
// SKIPPED with the reason instead of failing. When a game *is* open, those
// routes run for real -- with the least intrusive input there is, so the test
// leaves the game as it found it: tapping Shift changes no binding, a zero
// mouse delta moves nothing, and the middle button is unbound in Quake 2.
//
// Prints PASS/FAIL/SKIP per step and exits 1 if any step failed. Node built-ins
// only.
//
//   node scripts/control-api-test.mjs
"use strict";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SERVER = path.join(ROOT, "control", "server.mjs");
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const CLIENT_TIMEOUT_MS = 30000; // above the API's own 15 s route deadline
const START_TIMEOUT_MS = 10000;

let failures = 0;
let skips = 0;
const children = [];

// ---- The steps ------------------------------------------------------------

function ok(name, note) {
  console.log("PASS  " + name + (note ? " -- " + note : ""));
}

function bad(name, reason) {
  failures++;
  console.log("FAIL  " + name + "\n        " + String(reason).replace(/\n/g, "\n        "));
}

async function step(name, fn) {
  try {
    const note = await fn();
    ok(name, note);
    return note;
  } catch (error) {
    bad(name, (error && error.message) || error);
    return undefined;
  }
}

function skip(name, reason) {
  skips++;
  console.log("SKIP  " + name + " -- " + reason);
}

// ---- Talking to the API ---------------------------------------------------

// One request with a hard client-side timeout, so a wedged API shows up as a
// failed step rather than a test that never ends.
async function request(port, method, route, { body, rawBody, headers } = {}) {
  const init = { method, headers: { ...(headers || {}) }, signal: AbortSignal.timeout(CLIENT_TIMEOUT_MS), redirect: "error" };
  if (rawBody !== undefined) init.body = rawBody;
  else if (body !== undefined) {
    init.body = typeof body === "string" ? body : JSON.stringify(body);
    init.headers["Content-Type"] = "application/json";
  }
  const response = await fetch("http://127.0.0.1:" + port + route, init);
  const buffer = Buffer.from(await response.arrayBuffer());
  return {
    status: response.status,
    type: response.headers.get("content-type") || "",
    cors: response.headers.get("access-control-allow-origin"),
    allow: response.headers.get("allow"),
    length: response.headers.get("content-length"),
    buffer,
    text: buffer.toString("utf8"),
    json() {
      try {
        return JSON.parse(this.text);
      } catch {
        throw new Error("answer was not JSON (" + this.type + "): " + this.text.slice(0, 200));
      }
    },
  };
}

function assertJson(response, status) {
  assert.equal(response.status, status, "HTTP " + response.status + ", expected " + status + ": " + response.text.slice(0, 200));
  assert.match(response.type, /^application\/json/, "content type was " + JSON.stringify(response.type));
  assert.equal(response.cors, "*", "the CORS header is missing");
  const body = response.json();
  assert.equal(typeof body, "object", "the body is not a JSON object");
  return body;
}

function assertError(response, status, code) {
  const body = assertJson(response, status);
  assert.equal(typeof body.error, "string", "the error body has no message");
  if (code) assert.equal(body.code, code, "error code was " + body.code);
  return body;
}

// ---- Starting the servers the test itself runs ----------------------------

// The port the server prints on start (it prints what it really bound, which is
// what makes CONTROL_PORT=0 usable here).
function started(child) {
  return new Promise((resolve, reject) => {
    let text = "";
    const timer = setTimeout(() => reject(new Error("no port printed within " + START_TIMEOUT_MS + " ms; stderr:\n" + text)), START_TIMEOUT_MS);
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      text += chunk;
      const match = text.match(/127\.0\.0\.1:(\d+)\/control\//);
      if (match) {
        clearTimeout(timer);
        resolve(Number(match[1]));
      }
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => { text += chunk; });
    child.on("exit", (code) => {
      clearTimeout(timer);
      reject(new Error("the control server exited with code " + code + "; stderr:\n" + text));
    });
  });
}

function startServer(env) {
  const child = spawn(process.execPath, [SERVER], {
    cwd: ROOT,
    env: { ...process.env, CONTROL_PORT: "0", ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.push(child);
  return child;
}

// A port nothing is listening on: bound to learn it, then released. Race-prone
// in principle, and harmless here -- the worst case is a connection refused a
// moment later, which is exactly what this test wants.
function unusedPort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.on("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

// ---- The run --------------------------------------------------------------

const deadPort = await unusedPort();
let live = null; // { port, health }
let dead = null; // { port }

try {
  const primary = startServer({});
  const unreachable = startServer({ QUAKE2_CDP_URL: "http://127.0.0.1:" + deadPort });
  const [primaryPort, deadCdpPort] = await Promise.all([started(primary), started(unreachable)]);
  live = { port: primaryPort, health: null };
  dead = { port: deadCdpPort };
  console.log("control API under test: 127.0.0.1:" + primaryPort + " (its own child process, never 4233)");
  console.log("error-path API:         127.0.0.1:" + deadCdpPort + " (CDP pointed at the closed port " + deadPort + ")");
  console.log("");

  // -- GET /control/health, with no game open ------------------------------
  const health = await step("GET /control/health -> 200 JSON, endpoint + game + framing", async () => {
    const response = await request(live.port, "GET", "/control/health");
    const body = assertJson(response, 200);
    assert.equal(typeof body.ok, "boolean", "health has no ok flag");
    assert.equal(typeof body.cdp, "object", "health has no cdp block");
    assert.equal(typeof body.cdp.endpoint, "string", "health does not say which CDP endpoint it drives");
    assert.equal(typeof body.cdp.reachable, "boolean", "health does not say whether the browser answered");
    assert.equal(typeof body.game, "object", "health has no game block");
    assert.equal(typeof body.game.present, "boolean", "health does not say whether the game is there");
    for (const key of ["framed", "hostOrigin", "screenshotFrom"]) {
      assert.ok(key in body.game, "health does not report game." + key);
    }
    live.health = body;
    return "cdp " + body.cdp.endpoint + " reachable=" + body.cdp.reachable + ", game present=" + body.game.present +
      (body.game.present ? ", framed=" + body.game.framed + " (" + body.game.hostOrigin + "), screenshot from " + body.game.screenshotFrom : "");
  });

  const gameOpen = !!(live.health && live.health.game && live.health.game.present);
  const closedReason = "no game is open in the browser at " + (live.health ? live.health.cdp.endpoint : "the CDP endpoint");

  // -- GET/POST /control/status --------------------------------------------
  await step("GET /control/status -> 200 JSON with framing, or 503 GAME_NOT_RUNNING", async () => {
    const response = await request(live.port, "GET", "/control/status");
    if (!gameOpen) {
      assertError(response, 503, "GAME_NOT_RUNNING");
      return "the game is closed, and the route says so (503 GAME_NOT_RUNNING)";
    }
    const body = assertJson(response, 200);
    assert.equal(body.ok, true, "status is not ok");
    assert.equal(typeof body.framed, "boolean", "status does not report whether the game is framed");
    assert.ok(["host-page", "game-tab"].includes(body.screenshotFrom), "screenshotFrom was " + JSON.stringify(body.screenshotFrom));
    // The plain statement must agree with the boolean, whichever way it fell.
    assert.equal(body.screenshotFrom, body.framed ? "host-page" : "game-tab", "framed and screenshotFrom disagree");
    assert.ok(body.hostOrigin === null || typeof body.hostOrigin === "string", "hostOrigin must be an origin string or null");
    if (body.framed) assert.ok(body.hostOrigin, "a framed game must name the host page's origin");
    return "framed=" + body.framed + ", hostOrigin=" + body.hostOrigin + ", screenshot from " + body.screenshotFrom;
  });

  await step("POST /control/status -> 200 JSON (the route exists on POST too)", async () => {
    const response = await request(live.port, "POST", "/control/status", { body: {} });
    if (!gameOpen) {
      assertError(response, 503, "GAME_NOT_RUNNING");
      return "the game is closed, and the route says so (503 GAME_NOT_RUNNING)";
    }
    const body = assertJson(response, 200);
    assert.equal(body.ok, true, "status is not ok");
    return "ok";
  });

  // -- GET /control/state, the read an agent needs -------------------------
  await step("GET /control/state -> 200 JSON with the engine's own state, or 503", async () => {
    const response = await request(live.port, "GET", "/control/state");
    if (!gameOpen) {
      assertError(response, 503, "GAME_NOT_RUNNING");
      return "the game is closed, and the route says so (503 GAME_NOT_RUNNING)";
    }
    const body = assertJson(response, 200);
    assert.equal(body.ok, true, "state is not ok");
    assert.equal(typeof body.engine.running, "boolean", "state does not report whether the engine is running");
    assert.equal(typeof body.server.running, "boolean", "state does not report whether a level is up");
    assert.ok(body.server.map === null || typeof body.server.map === "string", "server.map must be a string or null");
    for (const key of ["position", "angles", "health", "armour", "ammo", "alive"]) {
      assert.ok(key in body.player, "state.player has no " + key);
    }
    // The engine cannot be asked these, and the answer has to say so rather
    // than look like a read that merely came back empty. `alive` is not one of
    // them any more: it is derived from the live view roll, which engine-state.js
    // reads out of the engine's memory, and says so in `aliveSource`.
    for (const key of ["health", "armour", "ammo"]) {
      assert.ok(body.unavailable.includes(key), "state does not list " + key + " as unavailable");
      assert.equal(body.player[key], null, key + " must be null, the engine cannot print it");
    }
    // The live half has to say where it came from, and a plain read must not
    // have opened the console to get it.
    assert.ok(["wasm-memory", "console", "none"].includes(body.source), "state.source is " + body.source);
    assert.equal(typeof body.consoleSpend.toggles, "number", "state carries no console spend");
    if (body.source === "wasm-memory") {
      assert.equal(typeof body.player.alive, "boolean", "state.player.alive must be answered, not null");
      assert.ok(!body.unavailable.includes("alive"), "alive is read now, so it must not be listed as unavailable");
      assert.equal(typeof body.engine.paused, "boolean", "state does not report whether the engine is paused");
      assert.equal(body.engine.paused, !body.engine.inGame, "paused must mean the game does not own the keyboard");
    }
    assert.equal(typeof body.note, "string", "state carries no note");
    assert.ok(Array.isArray(body.console.tail), "state has no console tail");
    assert.ok(Array.isArray(body.saves.slots), "state has no save slots");
    // Without probe the read sends no input, and must say it did not.
    assert.equal(body.probed, false, "a plain state read must not probe");
    return "server.running=" + body.server.running + ", map=" + JSON.stringify(body.server.map) +
      ", console " + body.console.lines + " lines, saves [" + body.saves.slots.join(", ") + "]";
  });

  // The probe is input (the engine's console), so it belongs to the live
  // section; it is still read-only and leaves the console shut.
  if (!gameOpen) {
    skip("POST /control/state {probe:true} (asks the engine over its console)", closedReason);
  } else {
    await step("POST /control/state {probe:true} -> 200 JSON, the engine was asked", async () => {
      const body = assertJson(await request(live.port, "POST", "/control/state", { body: { probe: true } }), 200);
      assert.equal(body.probe.requested, true, "the probe was not requested");
      assert.equal(typeof body.probe.ran, "boolean", "the answer does not say whether the engine heard the probe");
      assert.ok(Array.isArray(body.probe.commands), "the answer does not say what was asked");
      if (body.probe.ran) {
        // Ran: the engine really answered, so the queries are named and the
        // summary flag has to agree with it.
        assert.ok(body.probe.commands.includes("viewpos"), "viewpos was not among the queries");
        assert.equal(body.probed, true, "probed must be true when the engine answered");
        return "the engine answered viewpos/serverinfo (position " + JSON.stringify(body.player.position) + ")";
      }
      // The route behaved -- it opened the console, asked and read the dump back
      // -- but an engine that is mid-restart, or playing an attract-demo
      // cinematic (Quake 2 ignores keys during one), cannot answer, and then it
      // names no commands. That is the game's own state, not a failure of the
      // route, and the route says so.
      assert.equal(body.probed, false, "probed must be false when the engine did not answer");
      assert.equal(body.probe.commands.length, 0, "commands must be empty when the probe did not run");
      return "the engine did not answer the console probe (a restart or a demo cinematic); the route said so in probe.ran";
    });
  }

  // -- Request validation, which needs no game -----------------------------
  await step("POST /control/key with an empty key -> 400 BAD_REQUEST (rejected before the game)", async () => {
    assertError(await request(live.port, "POST", "/control/key", { body: { key: "" } }), 400, "BAD_REQUEST");
    assertError(await request(live.port, "POST", "/control/key", { body: { nokey: 1 } }), 400, "BAD_REQUEST");
    return "empty and missing key both refused";
  });

  await step("POST /control/mouse with a non-number -> 400 BAD_REQUEST", async () => {
    assertError(await request(live.port, "POST", "/control/mouse", { body: { dx: "left", dy: 0 } }), 400, "BAD_REQUEST");
    return "refused";
  });

  await step("POST /control/click with an unknown button -> 400 BAD_REQUEST", async () => {
    assertError(await request(live.port, "POST", "/control/click", { body: { button: "thumb" } }), 400, "BAD_REQUEST");
    return "refused";
  });

  // The fire route's refusals are checked here rather than fired: this test
  // leaves the game as it found it, and `+attack` is not a harmless key to send
  // at a live game. Both refusals happen before the bridge is reached, so they
  // hold whether or not a game is open.
  await step("POST /control/attack with an unparsable ms -> 400 BAD_REQUEST", async () => {
    assertError(await request(live.port, "POST", "/control/attack", { body: { ms: "a while" } }), 400, "BAD_REQUEST");
    return "refused";
  });

  await step("and one longer than the hold the API will wait for -> 400 BAD_REQUEST", async () => {
    assertError(await request(live.port, "POST", "/control/attack", { body: { ms: 60000 } }), 400, "BAD_REQUEST");
    return "refused";
  });

  await step("a body over the 64 KiB cap -> 400, and the connection is answered", async () => {
    assertError(await request(live.port, "POST", "/control/key", { rawBody: "x".repeat(70 * 1024) }), 400, "BAD_REQUEST");
    return "70 KiB refused";
  });

  await step("a body that is not JSON -> 400 BAD_REQUEST", async () => {
    assertError(await request(live.port, "POST", "/control/status", { rawBody: "{not json" }), 400, "BAD_REQUEST");
    return "refused";
  });

  await step("an unknown control route -> 404 NOT_FOUND, JSON", async () => {
    assertError(await request(live.port, "GET", "/control/nothing-here"), 404, "NOT_FOUND");
    return "404";
  });

  await step("GET on a POST-only route -> 405 with an Allow header", async () => {
    const response = await request(live.port, "GET", "/control/key");
    assert.equal(response.status, 405, "HTTP " + response.status);
    assert.equal(response.cors, "*", "the CORS header is missing on a 405");
    assert.match(response.allow || "", /POST/, "the 405 does not say what is allowed");
    return "Allow: " + response.allow;
  });

  await step("OPTIONS on a control route -> 204 with the CORS headers", async () => {
    const response = await request(live.port, "OPTIONS", "/control/key");
    assert.equal(response.status, 204, "HTTP " + response.status);
    assert.equal(response.cors, "*", "the CORS header is missing");
    return "204";
  });

  // -- The live routes -----------------------------------------------------
  if (!gameOpen) {
    for (const name of ["POST /control/key (tap Shift)", "POST /control/mouse (0,0)", "POST /control/click (middle)", "GET /control/screenshot.png (a real PNG)"]) {
      skip(name, closedReason);
    }
  } else {
    await step("POST /control/key {key:Shift} -> 200 JSON (a modifier: it changes no binding)", async () => {
      const body = assertJson(await request(live.port, "POST", "/control/key", { body: { key: "Shift" } }), 200);
      assert.equal(body.ok, true, "the answer is not ok");
      assert.equal(body.key, "Shift", "the answer does not name the key");
      return "tapped Shift";
    });

    await step("POST /control/mouse {dx:0,dy:0} -> 200 JSON (a zero delta: nothing moves)", async () => {
      const body = assertJson(await request(live.port, "POST", "/control/mouse", { body: { dx: 0, dy: 0 } }), 200);
      assert.equal(body.ok, true, "the answer is not ok");
      assert.equal(body.dx, 0, "the answer does not report the delta");
      return "the frame took a zero delta";
    });

    await step("POST /control/click {button:middle} -> 200 JSON (unbound in Quake 2, so nothing fires)", async () => {
      const body = assertJson(await request(live.port, "POST", "/control/click", { body: { button: "middle" } }), 200);
      assert.equal(body.ok, true, "the answer is not ok");
      assert.equal(body.button, "middle", "the answer does not name the button");
      return "clicked the middle button";
    });

    await step("GET /control/screenshot.png -> 200 image/png, a real PNG", async () => {
      const response = await request(live.port, "GET", "/control/screenshot.png");
      assert.equal(response.status, 200, "HTTP " + response.status + ": " + response.text.slice(0, 200));
      assert.equal(response.type, "image/png", "content type was " + JSON.stringify(response.type));
      assert.ok(response.buffer.length > 1000, "the PNG is only " + response.buffer.length + " bytes");
      assert.ok(response.buffer.subarray(0, 8).equals(PNG_SIGNATURE), "the bytes are not a PNG signature");
      assert.equal(response.buffer.subarray(12, 16).toString("ascii"), "IHDR", "no IHDR chunk");
      const width = response.buffer.readUInt32BE(16);
      const height = response.buffer.readUInt32BE(20);
      assert.ok(width > 0 && height > 0, "the PNG is " + width + "x" + height);
      assert.equal(Number(response.length), response.buffer.length, "Content-Length does not match the body");
      // HEAD is the same route without the body, and must not be shortened by it.
      const head = await request(live.port, "HEAD", "/control/screenshot.png");
      assert.equal(head.status, 200, "HEAD got HTTP " + head.status);
      assert.equal(head.type, "image/png", "HEAD content type was " + JSON.stringify(head.type));
      assert.ok(Number(head.length) > 1000, "HEAD reported Content-Length " + head.length);
      assert.equal(head.buffer.length, 0, "HEAD answered with a body");
      return width + "x" + height + ", " + response.buffer.length + " bytes, HEAD agreed";
    });
  }

  // -- The error paths, on a CDP endpoint that is not there ----------------
  await step("GET /control/health with no browser -> 200 JSON, ok:false, cdp.reachable:false", async () => {
    const body = assertJson(await request(dead.port, "GET", "/control/health"), 200);
    assert.equal(body.cdp.reachable, false, "health claims the browser answered");
    assert.equal(body.game.present, false, "health claims a game is there");
    assert.equal(body.ok, false, "health stays ok with no browser");
    return "ok:false, reachable:false";
  });

  await step("GET /control/status with no browser -> 502 CDP_UNREACHABLE, never a hung socket", async () => {
    const body = assertError(await request(dead.port, "GET", "/control/status"), 502, "CDP_UNREACHABLE");
    assert.ok(/18801|remote|CDP|browser/i.test(body.error) || body.error.length > 0, "the error says nothing useful");
    return "502 in " + "a bounded time";
  });

  await step("POST /control/key with no browser -> 502 (the route reaches the bridge and reports it)", async () => {
    assertError(await request(dead.port, "POST", "/control/key", { body: { key: "w" } }), 502, "CDP_UNREACHABLE");
    return "502";
  });
} catch (error) {
  failures++;
  console.log("FAIL  the test harness itself\n        " + String((error && error.stack) || error).replace(/\n/g, "\n        "));
} finally {
  for (const child of children) {
    if (!child.killed) child.kill("SIGTERM");
  }
}

console.log("");
console.log(failures === 0 ? "control-api-test: PASS" + (skips ? " (" + skips + " skipped)" : "") + " -- every route answered as its contract says"
  : "control-api-test: FAIL -- " + failures + " step(s) failed");
process.exit(failures === 0 ? 0 : 1);
