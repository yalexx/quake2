#!/usr/bin/env node
// mcp/server.mjs -- a Model Context Protocol server that lets an AI agent play
// the Quake 2 the box is showing, by driving control/bridge.mjs directly.
//
// Transport: JSON-RPC 2.0 over stdin/stdout, one JSON object per line (the MCP
// stdio framing). Nothing but protocol messages may be written to stdout --
// diagnostics go to stderr -- so a log line here would corrupt the stream.
//
// Tools:
//   quake2_key        press, hold or release a key, or type a whole string
//   quake2_mouse      turn the view by a delta (the game is pointer-locked)
//   quake2_click      click a mouse button (left is fire)
//   quake2_status     what the page is showing: framing, engine, canvas, CDP
//   quake2_state      what the game is doing: level, map, position, console log
//   quake2_screenshot a PNG of the game frame, as an image content block
//
// Zero dependencies. ESM is strict by default, so no "use strict" pragma is
// needed.
import { QuakeControl, ControlError } from "../control/bridge.mjs";

const SERVER_NAME = "quake2-control";
const SERVER_VERSION = "1.0.0";
// Newest first: the spec's own negotiation rule is to answer with a version we
// support, preferring the one the client asked for.
const PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];
// A request line is one small JSON-RPC message; a line that grows past this
// without ever ending is not one, and buffering it would only grow memory. The
// cap is generous next to any tool call (a screenshot travels the other way).
const MAX_LINE = 1024 * 1024;
// A tool call drives a browser that can wedge, and an MCP client has no way to
// hang up on one: it gets an answer with isError instead of a server that never
// speaks again. The bridge's per-CDP timeouts (5 s) are shorter than this, so
// this only fires when something is badly stuck.
const CALL_TIMEOUT_MS = Number(process.env.QUAKE2_MCP_TIMEOUT_MS || 20000);

// Settles with the work, or with a TIMEOUT ControlError, whichever is first.
// Handlers are attached either way, so a call that settles after the deadline
// is not an unhandled rejection.
function withTimeout(work, ms) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new ControlError("the tool call did not answer within " + ms + " ms", "TIMEOUT")), ms);
    work.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error) => { clearTimeout(timer); reject(error); },
    );
  });
}

const game = new QuakeControl();

const TOOLS = [
  {
    name: "quake2_key",
    description:
      "Send a key to Quake 2. By default the key is pressed and released (a tap). " +
      "Set down:true to hold it and down:false to release it, which is how movement " +
      "works. Named keys: letters (\"w\"), digits, \"Space\", \"Enter\", \"Escape\", " +
      "\"Tab\", \"Shift\", \"Control\", \"Alt\", \"F1\"-\"F12\", \"ArrowUp\"/\"Down\"/" +
      "\"Left\"/\"Right\", \"`\" (the in-game console), \"-\", \"=\", \"[\", \"]\". " +
      "Instead of key, send text to type a whole string one character at a time -- " +
      "that is how you enter an in-game console command -- with enter:true to press " +
      "Enter afterwards.",
    inputSchema: {
      type: "object",
      properties: {
        key: { type: "string", description: "Key to send, e.g. \"w\", \"Space\", \"Escape\", \"`\"." },
        down: { type: "boolean", description: "true holds the key, false releases it; omit to tap it." },
        text: { type: "string", description: "A whole string to type instead of a single key." },
        enter: { type: "boolean", description: "With text: press Enter when the text is done." },
      },
      additionalProperties: false,
    },
  },
  {
    name: "quake2_mouse",
    description:
      "Turn the view by a mouse delta. The game holds the pointer lock, so dx and dy " +
      "are movements, not positions: dx turns right, dy looks down. Small values " +
      "(1-50) are a nudge.",
    inputSchema: {
      type: "object",
      properties: {
        dx: { type: "number", description: "Horizontal movement in pixels; positive turns right." },
        dy: { type: "number", description: "Vertical movement in pixels; positive looks down." },
      },
      required: ["dx", "dy"],
      additionalProperties: false,
    },
  },
  {
    name: "quake2_click",
    description: "Click a mouse button in the game: \"left\" fires the current weapon, \"right\" and \"middle\" are whatever the game binds them to.",
    inputSchema: {
      type: "object",
      properties: {
        button: { type: "string", enum: ["left", "right", "middle"], description: "Which button; defaults to left." },
      },
      additionalProperties: false,
    },
  },
  {
    name: "quake2_status",
    description:
      "Report what the game is showing: the frame's URL, whether the engine is running, " +
      "the canvas size, window focus and pointer lock, and the CDP target behind it. Also " +
      "reports framing: whether the game sits inside the ClawBox desktop shell (the host " +
      "page's origin) or is a tab of its own, and tells you plainly whether a screenshot " +
      "would come from the shell or from the game's own tab.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "quake2_state",
    description:
      "Read the game's state as JSON: whether the engine is running, whether a level is " +
      "up, the current map, the player's position and angles, the save slots, and the " +
      "tail of the engine's own console log. Without probe:true it sends no input at all " +
      "and reports what the engine has already printed; with probe:true it asks the " +
      "engine directly (opening its console for a moment and shutting it again). Quake 2 " +
      "has no way to print health, armour, ammo or whether the player is alive -- the " +
      "reply lists those in `unavailable`; read them from a quake2_screenshot instead.",
    inputSchema: {
      type: "object",
      properties: {
        probe: { type: "boolean", description: "true asks the engine directly for the live position (input: the console is opened and shut again)." },
      },
      additionalProperties: false,
    },
  },
  {
    name: "quake2_screenshot",
    description: "Take a PNG of the current game frame and return it as an image.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
];

// Runs one tool call and answers with MCP content blocks.
async function callTool(name, args) {
  switch (name) {
    case "quake2_key": {
      if (typeof args.text === "string") {
        if (args.text === "") throw new ControlError("text must not be empty", "BAD_REQUEST");
        const typed = await game.typeText(args.text);
        if (args.enter) await game.tap("Enter");
        return { content: [{ type: "text", text: "Typed " + typed.typed + " character(s)" + (args.enter ? " and pressed Enter" : "") + "." }] };
      }
      if (typeof args.key !== "string" || args.key === "") {
        throw new ControlError('either "key" or "text" is required', "BAD_REQUEST");
      }
      if (args.down === undefined) {
        await game.tap(args.key);
        return { content: [{ type: "text", text: "Tapped " + args.key + "." }] };
      }
      await game.key(args.key, !!args.down);
      return { content: [{ type: "text", text: (args.down ? "Held " : "Released ") + args.key + "." }] };
    }
    case "quake2_mouse": {
      const dx = Number(args.dx);
      const dy = Number(args.dy);
      if (!Number.isFinite(dx) || !Number.isFinite(dy)) throw new ControlError("dx and dy must be numbers", "BAD_REQUEST");
      const moved = await game.mouseMove(dx, dy);
      return { content: [{ type: "text", text: "Moved the mouse by (" + moved.dx + ", " + moved.dy + ")." }] };
    }
    case "quake2_click": {
      const clicked = await game.click(args.button === undefined ? "left" : String(args.button));
      return { content: [{ type: "text", text: "Clicked " + clicked.button + "." }] };
    }
    case "quake2_status": {
      return { content: [{ type: "text", text: JSON.stringify(await game.status(), null, 2) }] };
    }
    case "quake2_state": {
      return { content: [{ type: "text", text: JSON.stringify(await game.state({ probe: !!args.probe }), null, 2) }] };
    }
    case "quake2_screenshot": {
      const png = await game.screenshot();
      return { content: [{ type: "image", data: png.toString("base64"), mimeType: "image/png" }] };
    }
    default:
      throw new ControlError("no such tool: " + name, "NOT_FOUND");
  }
}

function write(message) {
  process.stdout.write(JSON.stringify(message) + "\n");
}

function reply(id, result) {
  write({ jsonrpc: "2.0", id, result });
}

function replyError(id, code, message, data) {
  write({ jsonrpc: "2.0", id, error: { code, message, ...(data === undefined ? {} : { data }) } });
}

async function handle(message) {
  const { id, method, params } = message;
  const hasId = id !== undefined && id !== null;
  // A notification (no id) never gets an answer, not even for an error.
  if (!hasId && method && method.startsWith("notifications/")) return;

  try {
    switch (method) {
      case "initialize": {
        const asked = params && params.protocolVersion;
        const version = PROTOCOL_VERSIONS.includes(asked) ? asked : PROTOCOL_VERSIONS[0];
        reply(id, {
          protocolVersion: version,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
          instructions:
            "Drives the Quake 2 game the ClawBox is showing. It is a first-person shooter: " +
            "use quake2_key with down:true/false for movement, quake2_mouse to aim, and " +
            "quake2_click to fire. Type \"`\" to open the in-game console and send text to " +
            "it to run commands. Take a quake2_screenshot to see the result.",
        });
        return;
      }
      case "ping":
        reply(id, {});
        return;
      case "tools/list":
        reply(id, { tools: TOOLS });
        return;
      case "tools/call": {
        const name = params && params.name;
        const args = (params && params.arguments) || {};
        try {
          reply(id, await withTimeout(callTool(name, args), CALL_TIMEOUT_MS));
        } catch (error) {
          // A failed tool call is a normal answer with isError, not a protocol error.
          const text = error instanceof ControlError ? error.message : String((error && error.stack) || error);
          reply(id, { content: [{ type: "text", text }], isError: true });
        }
        return;
      }
      // We advertise no resources or prompts, but a client may still ask.
      case "resources/list":
        reply(id, { resources: [] });
        return;
      case "resources/templates/list":
        reply(id, { resourceTemplates: [] });
        return;
      case "prompts/list":
        reply(id, { prompts: [] });
        return;
      default:
        if (hasId) replyError(id, -32601, "method not found: " + method);
        return;
    }
  } catch (error) {
    if (hasId) replyError(id, -32603, "internal error: " + String((error && error.message) || error));
  }
}

// stdin is the transport: a line at a time, so a partial write can never be
// mistaken for a whole message.
let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  // A line that grows past the cap without ever ending is not a message: drop
  // it and say so, rather than buffering without bound.
  if (buffer.length > MAX_LINE && !buffer.includes("\n")) {
    buffer = "";
    replyError(null, -32700, "request line over " + MAX_LINE + " bytes");
  }
  for (;;) {
    const newline = buffer.indexOf("\n");
    if (newline < 0) break;
    const line = buffer.slice(0, newline).trim();
    buffer = buffer.slice(newline + 1);
    if (!line) continue;
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      replyError(null, -32700, "parse error");
      continue;
    }
    // handle() is async; a rejection there must not take the server down.
    handle(message).catch((error) => {
      if (message && message.id !== undefined) replyError(message.id, -32603, "internal error");
      process.stderr.write(SERVER_NAME + ": " + (error && error.stack ? error.stack : String(error)) + "\n");
    });
  }
});
process.stdin.on("end", () => process.exit(0));
// stderr is free: it is where a supervisor expects the server's own log lines.
process.on("uncaughtException", (error) => {
  process.stderr.write(SERVER_NAME + ": " + (error && error.stack ? error.stack : String(error)) + "\n");
});
