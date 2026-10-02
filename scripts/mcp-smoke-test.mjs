#!/usr/bin/env node
// scripts/mcp-smoke-test.mjs -- check that mcp/server.mjs speaks MCP, and that
// nothing but protocol ever reaches stdout.
//
// It spawns the server as a child and talks to it over its real transport --
// JSON-RPC 2.0, one message per line -- through the handshake an MCP client
// performs: initialize, notifications/initialized, tools/list, tools/call. It
// proves the protocol, not the game: quake2_status is allowed to answer with
// isError when no game is open (the text then says why), and the one assertion
// that always holds is that a tool call answers with a well-formed MCP result
// rather than a broken stream or no answer at all. The same is true of the
// unknown-tool call: an unknown tool must come back as isError:true, not as a
// JSON-RPC error and not as silence.
//
// It starts and stops only that child; it never touches the control API on
// 4233, the game server on 4231 or quake2-app.service. Node built-ins only.
//
//   node scripts/mcp-smoke-test.mjs
"use strict";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SERVER = path.join(ROOT, "mcp", "server.mjs");
// Above the server's own 20 s tool-call cap, so a wedged call shows up as the
// server's own isError answer rather than as this test's deadline.
const ANSWER_TIMEOUT_MS = 25000;
const PROTOCOL_VERSION = "2025-06-18";
const TOOL_NAMES = ["quake2_key", "quake2_mouse", "quake2_click", "quake2_status", "quake2_state", "quake2_screenshot"];

let failures = 0;
const child = spawn(process.execPath, [SERVER], { cwd: ROOT, stdio: ["pipe", "pipe", "pipe"] });

// Every line the server writes to stdout, raw, so the "protocol only" rule can
// be checked at the end against what really came out.
const rawLines = [];
const waiting = [];
let stderr = "";

child.stdout.setEncoding("utf8");
let buffer = "";
child.stdout.on("data", (chunk) => {
  buffer += chunk;
  for (;;) {
    const newline = buffer.indexOf("\n");
    if (newline < 0) break;
    const line = buffer.slice(0, newline);
    buffer = buffer.slice(newline + 1);
    if (line.trim() === "") continue;
    rawLines.push(line);
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      continue; // recorded in rawLines; the "stdout is protocol" step fails on it
    }
    for (let i = waiting.length - 1; i >= 0; i--) {
      if (waiting[i].match(message)) {
        const entry = waiting.splice(i, 1)[0];
        clearTimeout(entry.timer);
        entry.resolve(message);
      }
    }
  }
});
child.stderr.setEncoding("utf8");
child.stderr.on("data", (chunk) => { stderr += chunk; });

function send(message) {
  child.stdin.write(JSON.stringify(message) + "\n");
}

// Waits for the first message matching a predicate; every wait has a deadline,
// so a silent server is a failure and not a test that never ends.
function awaitMessage(match, what) {
  return new Promise((resolve, reject) => {
    const entry = {
      match,
      resolve,
      timer: setTimeout(() => {
        const index = waiting.indexOf(entry);
        if (index >= 0) waiting.splice(index, 1);
        reject(new Error("no answer to " + what + " within " + ANSWER_TIMEOUT_MS + " ms; stderr so far:\n" + stderr));
      }, ANSWER_TIMEOUT_MS),
    };
    waiting.push(entry);
  });
}

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

let lastId = 0;
const call = async (method, params) => {
  const id = ++lastId;
  send({ jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) });
  return awaitMessage((m) => m.id === id, method + " (id " + id + ")");
};

try {
  // -- Handshake -----------------------------------------------------------
  await step("initialize hands back a supported protocol and the server's name", async () => {
    const answer = await call("initialize", {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "mcp-smoke-test", version: "1.0.0" },
    });
    assert.ok(answer.result, "initialize answered with an error: " + JSON.stringify(answer.error));
    assert.equal(answer.result.protocolVersion, PROTOCOL_VERSION, "negotiated " + answer.result.protocolVersion);
    assert.equal(answer.result.serverInfo.name, "quake2-control", "serverInfo.name was " + JSON.stringify(answer.result.serverInfo.name));
    assert.ok(answer.result.capabilities && answer.result.capabilities.tools, "no tools capability advertised");
    return answer.result.serverInfo.name + " " + answer.result.serverInfo.version + " on " + answer.result.protocolVersion;
  });

  // A notification: no id, and by the spec no answer -- so this one is sent and
  // then proved harmless by the requests that follow it.
  send({ jsonrpc: "2.0", method: "notifications/initialized" });

  await step("ping answers an empty result (the stream is still alive after a notification)", async () => {
    const answer = await call("ping");
    assert.ok(answer.result, "ping answered with an error: " + JSON.stringify(answer.error));
    assert.deepEqual(answer.result, {}, "ping result was " + JSON.stringify(answer.result));
    return "{}";
  });

  // -- tools/list ----------------------------------------------------------
  await step("tools/list returns the six Quake 2 tools, each with a JSON schema", async () => {
    const answer = await call("tools/list");
    assert.ok(answer.result && Array.isArray(answer.result.tools), "no tools array");
    const names = answer.result.tools.map((tool) => tool.name);
    for (const name of TOOL_NAMES) assert.ok(names.includes(name), "missing tool " + name);
    for (const tool of answer.result.tools) {
      assert.equal(typeof tool.description, "string", tool.name + " has no description");
      assert.equal(tool.inputSchema && tool.inputSchema.type, "object", tool.name + " has no object inputSchema");
    }
    return names.join(", ");
  });

  // -- tools/call ----------------------------------------------------------
  await step("tools/call quake2_status answers a well-formed result (game open or not)", async () => {
    const answer = await call("tools/call", { name: "quake2_status", arguments: {} });
    assert.ok(answer.result, "the call came back as a JSON-RPC error: " + JSON.stringify(answer.error));
    assert.ok(Array.isArray(answer.result.content), "the result has no content array");
    assert.ok(answer.result.content.length > 0, "the result content is empty");
    assert.equal(answer.result.content[0].type, "text", "the first content block is " + answer.result.content[0].type);
    const text = answer.result.content[0].text;
    assert.equal(typeof text, "string", "the text block carries no text");
    if (answer.result.isError) {
      // No game open is a legitimate answer, not a protocol failure -- but it
      // must say so in words rather than fail silently.
      assert.ok(text.length > 0, "isError with no reason");
      return "isError (expected with no game open): " + text.split("\n")[0].slice(0, 120);
    }
    const status = JSON.parse(text); // must be the status JSON, not prose
    assert.equal(status.ok, true, "status is not ok");
    assert.equal(typeof status.framed, "boolean", "status does not report framing");
    assert.ok(["host-page", "game-tab"].includes(status.screenshotFrom), "screenshotFrom was " + JSON.stringify(status.screenshotFrom));
    return "status JSON, framed=" + status.framed + ", screenshot from " + status.screenshotFrom;
  });

  await step("tools/call quake2_state answers a well-formed result (the read an agent lives on)", async () => {
    const answer = await call("tools/call", { name: "quake2_state", arguments: {} });
    assert.ok(answer.result, "the call came back as a JSON-RPC error: " + JSON.stringify(answer.error));
    const block = answer.result.content && answer.result.content[0];
    assert.ok(block && block.type === "text", "no text content block");
    if (answer.result.isError) return "isError (expected with no game open): " + block.text.split("\n")[0].slice(0, 120);
    const state = JSON.parse(block.text);
    assert.equal(state.ok, true, "state is not ok");
    assert.equal(typeof state.engine.running, "boolean", "state does not report whether the engine is running");
    assert.ok(state.player && "health" in state.player, "state has no player block");
    assert.ok(Array.isArray(state.unavailable), "state does not list what the engine cannot answer");
    return "state JSON, map=" + JSON.stringify(state.server.map) + ", unavailable [" + state.unavailable.join(", ") + "]";
  });

  await step("tools/call with an unknown tool is a tool result with isError:true, not a protocol error", async () => {
    const answer = await call("tools/call", { name: "quake2_not_a_tool", arguments: {} });
    assert.ok(answer.result, "an unknown tool was answered as a JSON-RPC error: " + JSON.stringify(answer.error));
    assert.equal(answer.result.isError, true, "isError is " + JSON.stringify(answer.result.isError));
    const text = answer.result.content && answer.result.content[0] && answer.result.content[0].text;
    assert.match(String(text), /no such tool/i, "the reason does not say the tool is unknown: " + text);
    return "isError:true -- " + String(text).split("\n")[0].slice(0, 120);
  });

  await step("tools/call with a bad argument is isError, and the stream survives it", async () => {
    const answer = await call("tools/call", { name: "quake2_mouse", arguments: { dx: "left", dy: 0 } });
    assert.ok(answer.result, "answered as a JSON-RPC error: " + JSON.stringify(answer.error));
    assert.equal(answer.result.isError, true, "a bad dx must be a tool error");
    const after = await call("ping");
    assert.ok(after.result, "the server stopped answering after a bad call");
    return "isError, then ping still answered";
  });

  // -- Protocol errors -----------------------------------------------------
  await step("an unknown method is a JSON-RPC -32601, not a crash", async () => {
    const answer = await call("quake2/nonsense");
    assert.ok(answer.error, "an unknown method answered a result");
    assert.equal(answer.error.code, -32601, "error code was " + answer.error.code);
    return "-32601 " + answer.error.message;
  });

  await step("a line that is not JSON is a -32700 parse error, and the server carries on", async () => {
    child.stdin.write("this is not json\n");
    const answer = await awaitMessage((m) => m.error && m.error.code === -32700, "a parse error");
    assert.equal(answer.id, null, "a parse error must answer with a null id, got " + JSON.stringify(answer.id));
    const after = await call("ping");
    assert.ok(after.result, "the server stopped answering after a parse error");
    return "-32700, then ping still answered";
  });

  // -- stdout is protocol only, and stdin's end is a clean exit ------------
  await step("nothing but JSON-RPC ever reached stdout", async () => {
    for (const line of rawLines) {
      JSON.parse(line); // throws on a log line that would corrupt the stream
    }
    assert.ok(rawLines.length >= 6, "only " + rawLines.length + " lines came back");
    return rawLines.length + " lines, all JSON (diagnostics go to stderr, which had " + stderr.length + " bytes)";
  });

  await step("closing stdin ends the server with exit code 0", async () => {
    const ended = new Promise((resolve) => child.on("exit", (code, signal) => resolve({ code, signal })));
    child.stdin.end();
    const result = await Promise.race([
      ended,
      new Promise((resolve) => setTimeout(() => resolve({ timeout: true }), 5000)),
    ]);
    assert.ok(!result.timeout, "the server did not exit within 5 s of stdin ending");
    assert.equal(result.code, 0, "exit code was " + result.code + " (signal " + result.signal + ")");
    return "exit 0";
  });
} catch (error) {
  failures++;
  console.log("FAIL  the test harness itself\n        " + String((error && error.stack) || error).replace(/\n/g, "\n        "));
} finally {
  if (!child.killed && child.exitCode === null) child.kill("SIGTERM");
}

console.log("");
console.log(failures === 0 ? "mcp-smoke-test: PASS -- the MCP handshake, tools/list, tools/call and its error paths all hold"
  : "mcp-smoke-test: FAIL -- " + failures + " step(s) failed");
process.exit(failures === 0 ? 0 : 1);
