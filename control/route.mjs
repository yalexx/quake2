// control/route.mjs -- answer "where do I go?" from the level's own data.
//
// The bridge can push keys, but a blind key-pusher cannot finish a level. The
// level already says where everything is: a Quake 2 map ships as a BSP whose
// entity lump holds the player start, the exit trigger, the monsters and the
// items, and whose planes/nodes/leafs describe the solids the player can walk
// between. This module reads that, so an agent can be told "the exit is at
// -1744 1576 48, the nearest monster is 900 units away, and here is a path".
//
// Where the map comes from, in order of preference:
//
//   1. the running engine's own file system, over the bridge, when a control
//      object is handed in -- the bytes the engine actually loaded;
//   2. baseq2/pak0.pak next to this file -- the same archive the page is served
//      from, so a route can be worked out with no browser at all.
//
// Zero dependencies. Node's built-in fs and zlib-free paths only: a BSP is
// stored uncompressed inside a PAK, so this is a couple of Buffer reads and a
// parser for Quake's `{ "key" "value" }` entity text.
//
//   import { loadMap } from "./route.mjs";
//   const demo1 = await loadMap("demo1");
//   console.log(demo1.exitPoint());          // where the level ends
//   console.log(demo1.nearest({x:0,y:0,z:0}, "monster"));   // and what is closest
//   console.log((await demo1.path(start, exit)).points);    // how to walk there
//
// A map that is not in the archive throws RouteError("MAP_NOT_FOUND") and names
// the maps that are; a map with no exit throws RouteError("NO_EXIT"). Neither
// ever answers with an empty result, because an empty answer to "where is the
// exit" reads like "there is none here" and would send an agent nowhere.

import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const PROJECT_ROOT = fileURLToPath(new URL("..", import.meta.url));
const DEFAULT_PAK = fileURLToPath(new URL("../baseq2/pak0.pak", import.meta.url));

// Quake 2's BSP. The ident is the four bytes "IBSP"; version 38 is Quake 2
// (Quake 1's is 29, and the lump table means something else there).
const BSP_IDENT = 0x50534249; // "IBSP" little-endian
const BSP_VERSION_Q2 = 38;
const HEADER_LUMPS = 19;
// Only five lumps are ever touched. The numbers are Quake 2's own (qfiles.h) and
// they are worth stating because they are easy to get wrong by one: Quake 1's
// BSP puts the models lump much earlier, and guessing from the record sizes
// alone gives a plausible-looking but wrong table -- the give-away is that the
// brush lump's `firstside + numsides` has to match the brushside lump exactly
// (here 14314), and that the models lump divides by 48 into one model per brush
// entity plus the world (here 35 = 1 + models *1 .. *34).
const LUMP_ENTITIES = 0;
const LUMP_PLANES = 1;
const LUMP_NODES = 4;
const LUMP_LEAFS = 8;
const LUMP_MODELS = 13;
// Fixed record sizes, from qfiles.h.
const MODEL_BYTES = 48; // 3 vec3 (mins, maxs, origin) + headnode + firstface + numfaces
const PLANE_BYTES = 20; // 3 floats normal + float dist
const NODE_BYTES = 28; // int planenum, int children[2], short mins[3], short maxs[3], u16 firstface, u16 numfaces
const LEAF_BYTES = 28; // int contents, short cluster, short area, short mins[3], short maxs[3], u16 x4
const PAK_ENTRY_BYTES = 64; // char name[56], int offset, int length

// Leaf contents bits (q_shared.h). Solid and glass stop a walking player; lava
// and slime are walkable but cost health, so a route avoids them when it can.
// Monsterclip is deliberately *not* blocking: it keeps monsters out, the player
// walks through it, and mappers lay it over ledges and ceilings where treating
// it as solid walls a route off for no reason.
//
// Playerclip is not blocking either, and that is a measurement of *this* engine
// rather than a reading of q_shared.h. Stock Quake 2 folds CONTENTS_PLAYERCLIP
// into MASK_PLAYERSOLID, and a planner that honours it is right for a stock
// build -- but on the build this app drives it walls the level off for no
// reason: a walking player stands with their origin inside a clip leaf
// (contents 0x08030000, detail|monsterclip|playerclip) and walks on through it.
// Honouring it here confined the whole of demo1 to a 128k-voxel bubble around
// the spawn and reported spawn -> exit as NO_ROUTE, against a player who
// demonstrably walks out of that bubble. So the player's mask is solid|window;
// CONTENTS_PLAYERCLIP and STOCK_PLAYER_SOLID are exported so a caller can ask
// for the stock mask back.
const CONTENTS_SOLID = 1;
const CONTENTS_WINDOW = 2;
const CONTENTS_LAVA = 8;
const CONTENTS_SLIME = 16;
const CONTENTS_PLAYERCLIP = 0x10000;
const CONTENTS_MONSTERCLIP = 0x20000;
const BLOCKING = CONTENTS_SOLID | CONTENTS_WINDOW;
// What stock Quake 2's MASK_PLAYERSOLID says, for callers that want it.
const STOCK_PLAYER_SOLID = CONTENTS_SOLID | CONTENTS_WINDOW | CONTENTS_PLAYERCLIP;
const HAZARDOUS = CONTENTS_LAVA | CONTENTS_SLIME;

// ---- Inline brush models --------------------------------------------------
//
// A brush entity -- `func_door`, `func_wall`, `func_train` -- is not part of the
// world model's node tree. Its brushes are a model of their own (the models
// lump's `*n` entries), each with its own `headnode` into the *shared* node and
// leaf lumps, and a `{ model "*n" }` key on the entity says which. That matters
// because the engine collides with them separately: the world hull decides what
// a point in the level is made of, and then every `SOLID_BSP` entity is traced
// against on its own. Reading only the world tree therefore gets both halves
// wrong -- a `func_wall` platform is a floor the level really has, and a
// `func_door` filling a doorway is a wall the level really has until it opens.
//
// The two halves are not the same kind of thing, so they are not treated the
// same way here:
//
//   static  -- a `func_wall`, `func_explosive` or `func_button` never moves.
//              It is geometry, always. A point inside one is solid, and its top
//              can be a floor.
//   movers  -- a `func_door`, `func_plat`, `func_train` or `func_rotating` moves
//              when the player opens, rides or triggers it. Its volume is
//              *passable in principle*, so it is not treated as solid: a route
//              may go through it, and path() reports every mover it crosses so
//              the caller knows to press use or wait for the lift. Treating a
//              closed door as solid would hide the only way into the next room;
//              treating a lift shaft as solid would hide the only way up it.
//
// `func_areaportal` is neither: it is an invisible seal the engine opens for
// visibility, never a collision volume.
const STATIC_BRUSH = /^func_wall$|^func_explosive$|^func_breakable$/;
const MOVING_BRUSH = /^func_door|^func_plat$|^func_train$|^func_rotating$|^func_button$/;
const NON_SOLID_BRUSH = /^func_areaportal$|^trigger_/;

export class RouteError extends Error {
  constructor(message, code) {
    super(message);
    this.name = "RouteError";
    this.code = code;
  }
}

// A binary heap keyed on `f`. The route search visits tens of thousands of
// cells, and picking the cheapest by scanning the open set would make that
// quadratic -- the difference between a second and never finishing.
class MinHeap {
  #items = [];

  get size() { return this.#items.length; }

  push(item) {
    const items = this.#items;
    items.push(item);
    let index = items.length - 1;
    while (index > 0) {
      const parent = (index - 1) >> 1;
      if (items[parent].f <= items[index].f) break;
      [items[parent], items[index]] = [items[index], items[parent]];
      index = parent;
    }
  }

  pop() {
    const items = this.#items;
    const top = items[0];
    const last = items.pop();
    if (!items.length) return top;
    items[0] = last;
    let index = 0;
    for (;;) {
      const left = index * 2 + 1;
      const right = left + 1;
      let smallest = index;
      if (left < items.length && items[left].f < items[smallest].f) smallest = left;
      if (right < items.length && items[right].f < items[smallest].f) smallest = right;
      if (smallest === index) break;
      [items[smallest], items[index]] = [items[index], items[smallest]];
      index = smallest;
    }
    return top;
  }
}

// ---- PAK and BSP readers --------------------------------------------------

// A PAK is a flat archive: a directory of fixed-size entries at the end, each
// naming a file and where its bytes start and stop. Both offsets are absolute
// in the archive, so an entry is a slice and nothing is decompressed.
export function readPakDirectory(pak) {
  if (pak.length < 12 || pak.toString("latin1", 0, 4) !== "PACK") {
    throw new RouteError("that file is not a Quake PAK (no PACK signature)", "BAD_PAK");
  }
  const directoryOffset = pak.readUInt32LE(4);
  const directoryLength = pak.readUInt32LE(8);
  if (directoryOffset + directoryLength > pak.length || directoryLength % PAK_ENTRY_BYTES !== 0) {
    throw new RouteError("the PAK directory is out of bounds (" + directoryOffset + "+" + directoryLength + " in " + pak.length + " bytes)", "BAD_PAK");
  }
  const entries = new Map();
  for (let offset = directoryOffset; offset < directoryOffset + directoryLength; offset += PAK_ENTRY_BYTES) {
    const name = pak.toString("latin1", offset, offset + 56).replace(/\0.*$/, "").replace(/\\/g, "/");
    if (!name) continue;
    entries.set(name.toLowerCase(), { name, offset: pak.readUInt32LE(offset + 56), length: pak.readUInt32LE(offset + 60) });
  }
  return entries;
}

// The bytes of one file inside a PAK, or null when the archive does not hold it.
export function readPakFile(pak, wanted) {
  const entry = readPakDirectory(pak).get(String(wanted).toLowerCase().replace(/\\/g, "/"));
  if (!entry) return null;
  if (entry.offset + entry.length > pak.length) {
    throw new RouteError('the PAK entry for "' + entry.name + '" runs past the end of the archive', "BAD_PAK");
  }
  return pak.subarray(entry.offset, entry.offset + entry.length);
}

// The lump table. Kept as a plain object of views so the parser below can read
// a lump without carrying the whole BSP around.
export function readBspHeader(bsp) {
  if (bsp.length < 8 + HEADER_LUMPS * 8) throw new RouteError("the BSP is shorter than its header", "BAD_BSP");
  const ident = bsp.readUInt32LE(0);
  if (ident !== BSP_IDENT) {
    throw new RouteError("that file is not a BSP (ident 0x" + ident.toString(16) + ", expected IBSP)", "BAD_BSP");
  }
  const version = bsp.readInt32LE(4);
  if (version !== BSP_VERSION_Q2) {
    throw new RouteError("that BSP is version " + version + ", not Quake 2's " + BSP_VERSION_Q2, "BAD_BSP");
  }
  const lumps = [];
  for (let index = 0; index < HEADER_LUMPS; index++) {
    const offset = bsp.readInt32LE(8 + index * 8);
    const length = bsp.readInt32LE(12 + index * 8);
    if (offset < 0 || length < 0 || offset + length > bsp.length) {
      throw new RouteError("BSP lump " + index + " is out of bounds", "BAD_BSP");
    }
    lumps.push({ offset, length });
  }
  return { version, lumps };
}

// Quake's entity text: a run of `{ "key" "value" "key" "value" }` blocks. Values
// may contain newlines as the literal two characters \n, so the tokeniser only
// has to respect quotes -- and it keeps a value that is not quoted, which some
// compilers emit for a plain number.
export function parseEntities(text) {
  const entities = [];
  let current = null;
  let index = 0;
  const length = text.length;
  const endOfLine = (at) => {
    const stop = text.indexOf("\n", at);
    return stop === -1 ? length : stop;
  };
  while (index < length) {
    const character = text[index];
    if (character === "\0") break;
    if (character === " " || character === "\t" || character === "\r" || character === "\n") { index++; continue; }
    if (character === "/" && text[index + 1] === "/") { index = endOfLine(index); continue; }
    if (character === "{") { current = {}; index++; continue; }
    if (character === "}") { if (current) entities.push(current); current = null; index++; continue; }
    // A key or a value: quoted, or a bare token up to whitespace.
    let token;
    if (character === '"') {
      const close = text.indexOf('"', index + 1);
      if (close === -1) break; // an unterminated value: stop rather than invent one
      token = text.slice(index + 1, close);
      index = close + 1;
    } else {
      let stop = index;
      while (stop < length && !" \t\r\n{}".includes(text[stop])) stop++;
      token = text.slice(index, stop);
      index = stop;
    }
    if (!current) continue;
    if (current.__pendingKey === undefined) {
      current.__pendingKey = token;
    } else {
      current[current.__pendingKey] = token;
      current.__pendingKey = undefined;
    }
  }
  for (const entity of entities) delete entity.__pendingKey;
  return entities;
}

// Quake's vector syntax: "x y z", space separated. Anything else is null rather
// than a zero vector, so a caller can tell "at the origin" from "unset".
export function parseOrigin(value) {
  if (typeof value !== "string") return null;
  const parts = value.trim().split(/\s+/).map(Number);
  if (parts.length !== 3 || parts.some((part) => !Number.isFinite(part))) return null;
  return { x: parts[0], y: parts[1], z: parts[2] };
}

export function distanceBetween(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}

// A number, or the fallback when the caller passed nothing sensible. Options
// arrive from CLIs and HTTP bodies, so "unset", "" and "abc" all have to land on
// the default rather than on NaN and a search that never terminates.
function numberOr(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

// ---- What a map is worth to an agent --------------------------------------

// Entity classnames grouped by what an agent would want from them. The `kind`
// is what callers ask nearest() and waypoints() for; the classname is what the
// level actually says. Anything not listed still appears as kind "other" only
// if asked for by classname, so the list stays readable.
const WAYPOINT_KINDS = [
  ["start", (name) => name === "info_player_start"],
  ["exit", (name) => name === "target_changelevel"],
  ["trigger", (name) => name.startsWith("trigger_")],
  ["enemy", (name) => name.startsWith("monster_")],
  ["key", (name) => name.startsWith("key_")],
  ["item", (name) => name.startsWith("item_") || name.startsWith("weapon_") || name.startsWith("ammo_")],
  ["path", (name) => name === "path_corner"],
  ["secret", (name) => name === "target_secret"],
  ["goal", (name) => name === "target_goal"],
  ["hint", (name) => name === "target_help"],
  ["teleport", (name) => name === "trigger_teleport" || name === "misc_teleporter" || name === "misc_teleporter_dest"],
  ["dead", (name) => name === "info_player_deathmatch" || name === "info_player_coop" || name === "info_player_intermission"],
];

function kindsOf(classname) {
  const name = String(classname || "").toLowerCase();
  const kinds = [];
  for (const [kind, matches] of WAYPOINT_KINDS) if (matches(name)) kinds.push(kind);
  return kinds;
}

// One entity, in the shape the rest of the module speaks. `origin` stays null
// when the level does not place the entity (a brush trigger takes its place
// from its brush, which this reader does not resolve) -- that distinction
// matters, because a missing origin is not the same as standing at 0 0 0.
function describeEntity(entity) {
  const classname = String(entity.classname || "");
  return {
    classname,
    targetname: entity.targetname ? String(entity.targetname) : null,
    target: entity.target ? String(entity.target) : null,
    origin: parseOrigin(entity.origin),
    angle: entity.angle !== undefined ? Number(entity.angle) : null,
    model: entity.model ? String(entity.model) : null,
    spawnflags: entity.spawnflags !== undefined ? Number(entity.spawnflags) : null,
    kinds: kindsOf(classname),
    raw: entity,
  };
}

export class RouteMap {
  constructor(name, bsp, source) {
    this.name = name;
    this.source = source;
    const header = readBspHeader(bsp);
    this.bsp = bsp;
    this.lumps = header.lumps;
    this.version = header.version;
    // The entity lump is text; everything else is binary and read on demand.
    this.entities = parseEntities(bsp.toString("latin1", header.lumps[LUMP_ENTITIES].offset, header.lumps[LUMP_ENTITIES].offset + header.lumps[LUMP_ENTITIES].length));
    this.described = this.entities.map(describeEntity);
    this.world = this.described.find((entity) => entity.classname === "worldspawn") || null;
    // The world's brushes are model 0, whose tree starts at node 0. Every other
    // model is a brush entity, and the entity that owns it is found by the
    // `model "*n"` key rather than by `origin` -- a brush entity usually has no
    // origin, and the marker a mapper leaves near one is not where it is.
    this.models = this.#readModels();
    this.#bounds = this.#computeBounds();
    // What the level is made of, which is the world *and* the brush entities
    // that never move. Built once: the per-column scan calls it millions of
    // times.
    this.#staticSolids = this.models.filter((model) => model.kind === "static");
  }

  #bounds = null;
  #columnCache = null;
  #staticSolids = [];
  #columnsCache = null;

  // The map's extent, from the leaf boxes rather than the entities: an entity
  // only places a thing, a leaf is the space the level actually occupies.
  #computeBounds() {
    const leafs = this.lumps[LUMP_LEAFS];
    const bsp = this.bsp;
    const box = { min: { x: Infinity, y: Infinity, z: Infinity }, max: { x: -Infinity, y: -Infinity, z: -Infinity } };
    let seen = 0;
    for (let offset = 0; offset + LEAF_BYTES <= leafs.length; offset += LEAF_BYTES) {
      const at = leafs.offset + offset;
      if (bsp.readInt32LE(at) === CONTENTS_SOLID) continue; // solid boxes pad the map out to nothing
      const mins = [0, 1, 2].map((axis) => bsp.readInt16LE(at + 8 + axis * 2));
      const maxs = [0, 1, 2].map((axis) => bsp.readInt16LE(at + 14 + axis * 2));
      box.min.x = Math.min(box.min.x, mins[0]); box.max.x = Math.max(box.max.x, maxs[0]);
      box.min.y = Math.min(box.min.y, mins[1]); box.max.y = Math.max(box.max.y, maxs[1]);
      box.min.z = Math.min(box.min.z, mins[2]); box.max.z = Math.max(box.max.z, maxs[2]);
      seen++;
    }
    if (!seen) throw new RouteError("the BSP has no non-solid leaves, so it has no space to walk in", "BAD_BSP");
    return box;
  }

  bounds() {
    return { min: { ...this.#bounds.min }, max: { ...this.#bounds.max } };
  }

  // The level's own one-line description and the next map it names, if any.
  // A map with no changelevel reports the reason instead of throwing, because a
  // summary is meant to be asked about any map.
  summary() {
    const world = this.world ? this.world.raw : {};
    let exit = null;
    try {
      const point = this.exitPoint();
      exit = { to: point.map, nextMap: point.nextMap, landmark: point.landmark, position: point.position, agreesWithWorldspawn: point.agrees };
    } catch (error) {
      exit = { error: error.code || "ERROR", message: error.message };
    }
    const counts = {};
    for (const entity of this.described) if (entity.classname !== "worldspawn") counts[entity.classname] = (counts[entity.classname] || 0) + 1;
    return {
      name: this.name,
      source: this.source,
      message: world.message || null,
      nextmap: world.nextmap || null,
      bounds: this.bounds(),
      entities: this.entities.length,
      playerStart: this.playerStart(),
      exit,
      counts,
    };
  }

  // Where a single-player game puts the player. The tagged starts are co-op
  // spawns (a mapper names them to mark a landing spot for another level), so an
  // untagged one wins -- that is the one the engine picks.
  playerStart() {
    const starts = this.described.filter((entity) => entity.classname === "info_player_start" && entity.origin);
    const untagged = starts.find((entity) => !entity.targetname);
    const chosen = untagged || starts[0] || this.described.find((entity) => entity.classname === "info_player_deathmatch" && entity.origin);
    if (!chosen) return null;
    return { classname: chosen.classname, position: chosen.origin, angle: chosen.angle === null ? 0 : chosen.angle, targetname: chosen.targetname, tagged: !untagged };
  }

  // The changelevel target, with the trigger that fires it. A level ends when a
  // trigger_* volume fires a target_changelevel; both halves are reported, so a
  // caller can aim at the trigger if the level placed one.
  #findExit() {
    const changelevel = this.described.find((entity) => entity.classname === "target_changelevel");
    if (!changelevel) return null;
    const trigger = this.described.find((entity) => entity.classname.startsWith("trigger_") && entity.target && entity.target === changelevel.targetname);
    return { changelevel, trigger: trigger || null };
  }

  // Where to walk to finish the level. `map` is the raw field ("demo2$base1"),
  // `nextMap` and `landmark` its two halves: Quake 2 splits a changelevel target
  // on "$" to mean "and start the player at the entity tagged <landmark>".
  exitPoint() {
    const found = this.#findExit();
    if (!found) {
      throw new RouteError(
        '"' + this.name + '" has no target_changelevel entity, so it has no exit to walk to' +
        (this.world && this.world.raw.nextmap ? ' (its worldspawn names "' + this.world.raw.nextmap + '" as nextmap, which a deathmatch map still carries)' : "") +
        ". Maps in this pack: see maps();", "NO_EXIT");
    }
    const raw = String(found.changelevel.raw.map || "");
    if (!raw) throw new RouteError('the target_changelevel in "' + this.name + '" has no map field', "NO_EXIT");
    const [nextMap, landmark] = raw.split("$");
    // The trigger's own origin is absent when it is a brush volume; the
    // changelevel entity's origin is the mapper's marker for it, so that is the
    // aim point either way.
    const position = found.changelevel.origin || (found.trigger && found.trigger.origin) || null;
    if (!position) {
      throw new RouteError('the exit in "' + this.name + '" has no origin to aim at (trigger "' + found.changelevel.targetname + '" is a brush with no marker)', "NO_EXIT");
    }
    const triggerVolume = found.trigger ? this.modelBounds(found.trigger.model) : null;
    // Walking into the volume is what fires it, so that -- not the marker -- is
    // what an agent should aim at. A marker is where the mapper drew the thing;
    // a brush entity's volume can be a storey away from it.
    const aim = triggerVolume ? triggerVolume.centre : position;
    return {
      map: raw,
      nextMap,
      landmark: landmark || null,
      classname: found.changelevel.classname,
      targetname: found.changelevel.targetname,
      position,
      aim,
      triggerClassname: found.trigger ? found.trigger.classname : null,
      triggerModel: found.trigger ? found.trigger.model : null,
      triggerPosition: found.trigger ? found.trigger.origin : null,
      triggerVolume,
      markerInsideTrigger: triggerVolume ? this.insideVolume(triggerVolume, position) : null,
      // The worldspawn name is what a level's own "next map" field says; when it
      // disagrees with the trigger, the trigger is what the engine obeys.
      worldspawnNextmap: this.world ? this.world.raw.nextmap || null : null,
      agrees: !!(this.world && this.world.raw.nextmap && this.world.raw.nextmap === nextMap),
      distanceFromStart: this.playerStart() ? distanceBetween(this.playerStart().position, position) : null,
    };
  }

  // Every entity an agent might steer towards, tagged with `kind`.
  waypoints(kind = null) {
    const wanted = kind === null || kind === undefined || kind === "*" ? null : new Set(Array.isArray(kind) ? kind.map((k) => String(k).toLowerCase()) : [String(kind).toLowerCase()]);
    const out = [];
    for (const entity of this.described) {
      if (entity.classname === "worldspawn") continue;
      const kinds = entity.kinds;
      if (!entity.origin && !kinds.length) continue;
      if (wanted) {
        const classMatch = wanted.has(entity.classname.toLowerCase());
        const kindMatch = kinds.some((entry) => wanted.has(entry));
        if (!classMatch && !kindMatch) continue;
      }
      out.push({
        kind: kinds[0] || "other",
        kinds,
        classname: entity.classname,
        position: entity.origin,
        angle: entity.angle,
        targetname: entity.targetname,
        target: entity.target,
        model: entity.model,
      });
    }
    return out;
  }

  // The closest thing of a kind (or several kinds, or a classname) to a point.
  // Returns null only when the map holds nothing of that kind -- a caller that
  // asks for an enemy on a map with no monsters gets null, not a far-off item.
  nearest(from, kind = "*") {
    const origin = parseOrigin(from && from.x !== undefined ? from.x + " " + from.y + " " + from.z : from);
    if (!origin) throw new RouteError("nearest(from, kind) needs a point like {x, y, z}", "BAD_REQUEST");
    let best = null;
    for (const waypoint of this.waypoints(kind)) {
      if (!waypoint.position) continue;
      const distance = distanceBetween(origin, waypoint.position);
      if (!best || distance < best.distance) best = { ...waypoint, distance };
    }
    return best;
  }

  // The authored patrol graph: path_corner entities chain through `target`. It
  // is the mapper's own idea of how to get around the level, and a good place to
  // start when no walkable path can be found -- but it is a monster route, not a
  // route to the exit, and copying it blindly walks a player into the same
  // ambushes.
  pathCorners() {
    const corners = this.described.filter((entity) => entity.classname === "path_corner");
    const byName = new Map();
    for (const corner of corners) if (corner.targetname) byName.set(corner.targetname, corner);
    return corners.map((corner, index) => ({
      index,
      targetname: corner.targetname,
      position: corner.origin,
      angle: corner.angle,
      next: corner.target && byName.has(corner.target) ? corner.target : null,
      nextPosition: corner.target && byName.has(corner.target) ? byName.get(corner.target).origin : null,
    }));
  }

  // Every inline brush model, paired with the entity that owns it. Model 0 is
  // the world and is left out: it is this.lumps[LUMP_MODELS]'s first record and
  // the tree everything else is measured against.
  #readModels() {
    const models = this.lumps[LUMP_MODELS];
    if (!models) return [];
    const byRef = new Map();
    for (const entity of this.described) if (entity.model) byRef.set(String(entity.model), entity);
    const out = [];
    for (let index = 1; (index + 1) * MODEL_BYTES <= models.length; index++) {
      const at = models.offset + index * MODEL_BYTES;
      const read = (field) => this.bsp.readFloatLE(at + field * 4);
      const ref = "*" + index;
      const owner = byRef.get(ref) || null;
      // A brush entity that carries an `origin` was built at the origin and is
      // *placed* by that key: qbsp writes the brushes around 0,0,0 and the
      // engine adds the origin when it draws and collides. A brush entity
      // without one was built where it stands, and its model is already in world
      // coordinates. Getting this backwards puts a func_rotating in the wrong
      // room entirely.
      const placed = owner && owner.origin && Number.isFinite(owner.origin.x) ? owner.origin : null;
      const shift = placed || { x: 0, y: 0, z: 0 };
      const mins = { x: read(0) + shift.x, y: read(1) + shift.y, z: read(2) + shift.z };
      const maxs = { x: read(3) + shift.x, y: read(4) + shift.y, z: read(5) + shift.z };
      const classname = owner ? owner.classname : null;
      const kind = !classname || NON_SOLID_BRUSH.test(classname) ? "none"
        : MOVING_BRUSH.test(classname) ? "mover"
        : STATIC_BRUSH.test(classname) ? "static" : "static";
      out.push({
        ref,
        index,
        classname,
        targetname: owner ? owner.targetname : null,
        target: owner ? owner.target : null,
        spawnflags: owner ? owner.spawnflags : null,
        kind,
        // The model's own tree is in the model's local space; `origin` is what
        // takes a local point to a world one.
        origin: { ...shift },
        headnode: this.bsp.readInt32LE(at + 36),
        mins,
        maxs,
        centre: { x: (mins.x + maxs.x) / 2, y: (mins.y + maxs.y) / 2, z: (mins.z + maxs.z) / 2 },
        size: { x: maxs.x - mins.x, y: maxs.y - mins.y, z: maxs.z - mins.z },
      });
    }
    return out;
  }

  // Whether a point is inside a model's box at all. The tree walk is the truth,
  // but a box test first is what keeps the per-column scan affordable: almost
  // every point is outside almost every model.
  #inBox(model, x, y, z) {
    return x >= model.mins.x && x <= model.maxs.x && y >= model.mins.y && y <= model.maxs.y && z >= model.mins.z && z <= model.maxs.z;
  }

  // The contents of one inline model at a point, or 0 when the point is outside
  // its box. Where the point is *inside* the box, the model's own tree is walked
  // in the model's local space: a model with an `origin` was built around 0,0,0
  // and the origin is what takes a local point to a world one, so it comes back
  // off before the walk. A model without one is already in world coordinates --
  // its `origin` is the zero vector and subtracting it changes nothing.
  modelContentsAt(model, x, y, z) {
    if (!this.#inBox(model, x, y, z)) return 0;
    const leafs = this.lumps[LUMP_LEAFS];
    const local = { x: x - model.origin.x, y: y - model.origin.y, z: z - model.origin.z };
    return this.bsp.readInt32LE(leafs.offset + this.#leafFrom(model.headnode, local.x, local.y, local.z) * LEAF_BYTES);
  }

  // ---- Geometry ------------------------------------------------------------

  // Which leaf a point falls in, by walking the BSP's node tree: each node is a
  // splitting plane, and a negative child is a leaf -- the Quake convention is
  // that leaf n is encoded as -(n + 1). `headnode` is where the walk starts:
  // 0 is the world, and an inline model names its own.
  leafIndexAt(x, y, z, headnode = 0) {
    return this.#leafFrom(headnode, x, y, z);
  }

  #leafFrom(headnode, x, y, z) {
    const nodes = this.lumps[LUMP_NODES];
    const planes = this.lumps[LUMP_PLANES];
    const bsp = this.bsp;
    let node = headnode;
    // The tree is balanced, so this is ~20 steps; the cap only stops a corrupt
    // file from spinning forever.
    for (let step = 0; step < 4096; step++) {
      const at = nodes.offset + node * NODE_BYTES;
      if (at + NODE_BYTES > nodes.offset + nodes.length) throw new RouteError("a BSP node points past the node lump", "BAD_BSP");
      const planeIndex = bsp.readInt32LE(at);
      const planeAt = planes.offset + planeIndex * PLANE_BYTES;
      if (planeAt + PLANE_BYTES > planes.offset + planes.length) throw new RouteError("a BSP node names a plane past the plane lump", "BAD_BSP");
      const side = bsp.readFloatLE(planeAt) * x + bsp.readFloatLE(planeAt + 4) * y + bsp.readFloatLE(planeAt + 8) * z - bsp.readFloatLE(planeAt + 12);
      const child = bsp.readInt32LE(at + 4 + (side < 0 ? 4 : 0));
      if (child < 0) return -child - 1;
      node = child;
    }
    throw new RouteError("the BSP node tree did not reach a leaf", "BAD_BSP");
  }

  // What the world's own brushes make of a point, with no brush entity applied.
  // Kept separate because "inside the rock" and "inside a func_wall standing in
  // front of the rock" are different facts, and a caller looking at a blocker
  // needs to tell them apart.
  worldContentsAt(x, y, z) {
    const leafs = this.lumps[LUMP_LEAFS];
    return this.bsp.readInt32LE(leafs.offset + this.leafIndexAt(x, y, z) * LEAF_BYTES);
  }

  // What the level makes of a point: the world's brushes, or any brush entity
  // that never moves. Movers are deliberately left out -- see the note above the
  // brush class patterns.
  contentsAt(x, y, z) {
    let contents = this.worldContentsAt(x, y, z);
    if (contents & BLOCKING) return contents;
    for (const model of this.#staticSolids) {
      if (!this.#inBox(model, x, y, z)) continue;
      contents |= this.modelContentsAt(model, x, y, z);
      if (contents & BLOCKING) return contents;
    }
    return contents;
  }

  // Every brush entity that moves, with the volume a route has to pass through.
  // This is what a caller asks when it wants to know which doors to open or
  // which lift to ride; `kind` is "mover" for all of them.
  barriers() {
    return this.models.filter((model) => model.kind === "mover").map((model) => ({
      classname: model.classname,
      model: model.ref,
      targetname: model.targetname,
      target: model.target,
      centre: { ...model.centre },
      mins: { ...model.mins },
      maxs: { ...model.maxs },
      size: { ...model.size },
      // A door wants the use key; a platform or train wants the player to stand
      // on it; a button wants to be shot or used.
      action: /^func_door/.test(model.classname) ? "open"
        : /^func_plat$|^func_train$/.test(model.classname) ? "ride"
        : /^func_button$/.test(model.classname) ? "press"
        : "wait",
    }));
  }

  // The brushes whose volume contains a point, movers included: what a caller
  // wants when it has a position and needs to know what is standing there.
  brushesAt(x, y, z) {
    return this.models.filter((model) => this.#inBox(model, x, y, z)).map((model) => ({
      classname: model.classname,
      model: model.ref,
      kind: model.kind,
      targetname: model.targetname,
      centre: { ...model.centre },
    }));
  }

  // Where a brush entity actually is. An entity with `model "*27"` is not placed
  // at its `origin` -- brush entities usually have none, and the marker a mapper
  // leaves nearby is not the volume. The volume is the inline model's bounding
  // box, and that is what has to be walked into for the thing to fire: demo1's
  // exit marker sits at z 48 while its trigger volume tops out at z 32.
  modelBounds(modelRef) {
    const index = Number(String(modelRef === null || modelRef === undefined ? "" : modelRef).replace(/^\*/, ""));
    if (!Number.isInteger(index) || index <= 0) return null;
    const models = this.lumps[LUMP_MODELS];
    if ((index + 1) * MODEL_BYTES > models.length) return null;
    const at = models.offset + index * MODEL_BYTES;
    const read = (field) => this.bsp.readFloatLE(at + field * 4);
    const mins = { x: read(0), y: read(1), z: read(2) };
    const maxs = { x: read(3), y: read(4), z: read(5) };
    return {
      index,
      mins,
      maxs,
      centre: { x: (mins.x + maxs.x) / 2, y: (mins.y + maxs.y) / 2, z: (mins.z + maxs.z) / 2 },
      size: { x: maxs.x - mins.x, y: maxs.y - mins.y, z: maxs.z - mins.z },
      headnode: this.bsp.readInt32LE(at + 36),
      faces: this.bsp.readInt32LE(at + 44),
    };
  }

  // Whether a point is inside a volume modelBounds() returned. The trigger tests
  // the player's box against the volume, so a caller aiming a player at one has
  // to leave room for the player being 56 units tall.
  insideVolume(bounds, point) {
    return !!bounds && point.x >= bounds.mins.x && point.x <= bounds.maxs.x &&
      point.y >= bounds.mins.y && point.y <= bounds.maxs.y && point.z >= bounds.mins.z && point.z <= bounds.maxs.z;
  }

  isSolid(x, y, z) {
    return (this.contentsAt(x, y, z) & BLOCKING) !== 0;
  }

  // Can a standing player have their feet here? In Quake 2 the 32x32x56 player
  // box hangs from 24 below the entity origin to 32 above it, so a grid point
  // can be either the feet or the origin; this module uses the *feet*, because
  // that is the floor a mapper's geometry describes. The clearances then sample
  // the knees, waist, chest and the top of the head.
  standable(x, y, z) {
    if (this.isSolid(x, y, z)) return false;
    for (const lift of [8, 24, 40, 52]) if (this.isSolid(x, y, z + lift)) return false;
    return true;
  }

  // A floor in a column is where open space stops and solid begins, walking
  // down -- not wherever a fixed z ladder happens to land, because mappers put
  // floors at whatever height the geometry came out at. The surface is the last
  // open sample before the solid one, and it is kept only if a standing player
  // fits above it.
  #floorsInColumn(x, y, top, bottom, step) {
    const floors = [];
    // Nothing above the top of the map is walkable, so the first sample cannot
    // be the open side of a transition.
    let aboveOpen = false;
    for (let z = top; z >= bottom; z -= step) {
      const solid = this.isSolid(x, y, z);
      if (solid) {
        if (aboveOpen) {
          const feet = z + step; // the open sample the player would stand on
          // Two surfaces less than a storey apart are one floor seen twice (a
          // step, a lip, a lamp housing); 40 or more apart are two floors and
          // both are worth keeping.
          if ((!floors.length || floors[floors.length - 1] - feet >= 40) && this.standable(x, y, feet)) floors.push(feet);
        }
        aboveOpen = false;
      } else {
        aboveOpen = true;
      }
    }
    return floors;
  }

  // A grid of walkable points over the whole map, discovered per column rather
  // than on a fixed z ladder: floors sit at arbitrary heights, and a ladder that
  // does not land on one misses the storey entirely.
  floorGrid(cell = 32, step = 4) {
    // Both parameters shape the grid, so both are in the cache key: a caller who
    // asks for a coarser scan after a fine one must not be handed the fine grid.
    if (this.#columnCache && this.#columnCache.cell === cell && this.#columnCache.step === step) return this.#columnCache;
    const bounds = this.#bounds;
    const minX = Math.floor(bounds.min.x / cell) * cell;
    const minY = Math.floor(bounds.min.y / cell) * cell;
    const top = Math.ceil(bounds.max.z / step) * step;
    const bottom = Math.floor(bounds.min.z / step) * step;
    const columnsX = Math.floor((bounds.max.x - minX) / cell) + 1;
    const columnsY = Math.floor((bounds.max.y - minY) / cell) + 1;
    const floors = new Map();
    for (let ix = 0; ix < columnsX; ix++) {
      for (let iy = 0; iy < columnsY; iy++) {
        const x = minX + ix * cell;
        const y = minY + iy * cell;
        const found = this.#floorsInColumn(x, y, top, bottom, step);
        if (found.length) floors.set(ix + "," + iy, found);
      }
    }
    this.#columnCache = { cell, step, minX, minY, floors, columnsX, columnsY };
    return this.#columnCache;
  }

  // The floor of a column nearest a reference height: how a route that arrives
  // at a cell picks the storey it meant.
  #levelAt(grid, ix, iy, referenceZ) {
    const floors = grid.floors.get(ix + "," + iy);
    if (!floors) return null;
    let best = floors[0];
    for (const z of floors) if (Math.abs(z - referenceZ) < Math.abs(best - referenceZ)) best = z;
    return best;
  }

  // A* over the floor grid. Returns the walkable points, or a reason it could
  // not find any, never a straight line pretending to be a route.
  path(from, to, options = {}) {
    const start = parseOrigin(from && from.x !== undefined ? from.x + " " + from.y + " " + from.z : from);
    const goal = parseOrigin(to && to.x !== undefined ? to.x + " " + to.y + " " + to.z : to);
    if (!start || !goal) throw new RouteError("path(from, to) needs points like {x, y, z}", "BAD_REQUEST");
    // A route that can be walked is asked for before one that has to be jumped,
    // and the answer to the walk is used whenever there is one.
    //
    // `maxJump` is opt-in because a route that silently leaps a chasm is not the
    // same promise as one that walks (see below), and it is also -- measured on
    // demo1 -- seventy times the cost. The same plan comes back in 60 ms without
    // the jump search and 4,225 ms with it: every cell the search expands tries
    // 48 jump candidates and runs a line trace down each, and 4,518 cells is
    // 4,518 chances to pay for a leap the route does not use. Those seconds land
    // on the *game* and not on the planner. The walker plans inside its own
    // loop, so a re-plan is four seconds in which the player is standing still,
    // and standing still is the one thing demo1 punishes.
    //
    // So a caller who allows jumps gets them only where they are needed. The
    // fallback keeps the promise exactly: if the walk-only search has no route,
    // the jump search runs and its answer is returned, jumps and all.
    if (numberOr(options.maxJump, 0) > 0) {
      const walked = this.path(from, to, { ...options, maxJump: 0 });
      if (walked.points.length) return walked;
    }
    const cell = options.cell || 32;
    const step = options.step || 4;
    const maxStepUp = options.maxStepUp === undefined ? 24 : options.maxStepUp;
    const maxDrop = options.maxDrop === undefined ? 96 : options.maxDrop;
    // Off by default: a step is a step, and a route that silently leaps a chasm
    // is not the same promise as one that walks. A caller that wants the player
    // to jump -- the walker does, over the gaps demo1's canyon has -- asks for it
    // by naming a distance.
    const maxJump = Math.max(0, numberOr(options.maxJump, 0));
    const maxJumpDown = numberOr(options.maxJumpDown, Math.max(maxDrop, 200));
    const grid = this.floorGrid(cell, step);
    const indexOf = (point) => [Math.round((point.x - grid.minX) / cell), Math.round((point.y - grid.minY) / cell)];
    const key = (ix, iy, z) => ix + "," + iy + "," + z;

    // Deliberately absent: a way to route *around* the monsters. `waypoints("enemy")`
    // is the list, `contentsAt` is the geometry, and it looks like the obvious
    // answer to "the level is not blocked, it is defended" -- so it was built and
    // measured. Scoring every cell inside a soldier's reach as expensive changes
    // the route on demo1 from 4,693 units to between 4,877 and 5,261, and the
    // closest the route ever comes to a monster stays where it was: 33 units
    // before, 8 to 29 units after, at every radius tried from 100 to 640. The
    // level is a corridor and a doorway; there is no way round a soldier who is
    // standing in one, and the search can only trade a longer walk through the
    // same fight for a shorter one. That is worth knowing before building it
    // again.

    // Snap each end onto the floor of its own column, searching outward when the
    // exact cell is inside a wall (a target is often a marker in mid-air).
    const snap = (point, radius) => {
      const [ix, iy] = indexOf(point);
      for (let ring = 0; ring <= radius; ring++) {
        for (let dx = -ring; dx <= ring; dx++) {
          for (let dy = -ring; dy <= ring; dy++) {
            if (Math.max(Math.abs(dx), Math.abs(dy)) !== ring) continue;
            const level = this.#levelAt(grid, ix + dx, iy + dy, point.z);
            if (level !== null) return { ix: ix + dx, iy: iy + dy, z: level };
          }
        }
      }
      return null;
    };
    const fromCell = snap(start, options.snapRadius === undefined ? 4 : options.snapRadius);
    const toCell = snap(goal, options.snapRadius === undefined ? 4 : options.snapRadius);
    if (!fromCell) return { points: [], reason: "START_OFF_GRID", message: "no walkable floor within " + (options.snapRadius || 4) + " cells of the start " + JSON.stringify(start) };
    if (!toCell) return { points: [], reason: "GOAL_OFF_GRID", message: "no walkable floor within " + (options.snapRadius || 4) + " cells of the goal " + JSON.stringify(goal) };

    const heuristic = (ix, iy) => Math.hypot(ix - toCell.ix, iy - toCell.iy) * cell;
    const startKey = key(fromCell.ix, fromCell.iy, fromCell.z);
    const open = new MinHeap();
    const best = new Map([[startKey, { g: 0, prev: null }]]);
    const closed = new Map();
    open.push({ f: heuristic(fromCell.ix, fromCell.iy), key: startKey, g: 0 });
    // What a grid cell is made of, asked once. The search asks this for every
    // neighbour of every cell it expands, and the answer for a cell is the same
    // every time: the level does not change while a route is being planned. It
    // is not a small saving. `contentsAt` is a BSP walk down the world tree plus
    // one per static brush model, so on demo1 -- 14,314 brushsides and four
    // static models -- a single uncached plan is around 250,000 of those walks,
    // and measured on this box it took 8.4 seconds. That is not a number about
    // the planner, it is a number about the *game*: the walker plans inside its
    // own loop, so every re-plan is eight seconds in which the player is not
    // moving, and on demo1 a player who is not moving is a player the soldiers
    // kill. The same plan with the answers kept costs a fraction of a second.
    const contentsCache = new Map();
    const contentsOf = (nx, ny, level) => {
      const at = nx + "," + ny + "," + level;
      const known = contentsCache.get(at);
      if (known !== undefined) return known;
      const value = this.contentsAt(grid.minX + nx * cell, grid.minY + ny * cell, level);
      contentsCache.set(at, value);
      return value;
    };
    const limit = options.maxNodes || 400000;
    let bestKey = startKey;
    let bestScore = heuristic(fromCell.ix, fromCell.iy);
    let expanded = 0;
    const neighbours = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]];

    while (open.size && expanded < limit) {
      const current = open.pop();
      // Lazy deletion: the same cell can be pushed more than once when a better
      // route to it turns up, and only the first pop is the cheapest.
      if (closed.has(current.key)) continue;
      closed.set(current.key, true);
      expanded++;
      const [ix, iy, z] = current.key.split(",").map(Number);
      const goalScore = Math.hypot(ix - toCell.ix, iy - toCell.iy) * cell;
      if (goalScore < bestScore) { bestScore = goalScore; bestKey = current.key; }
      if (ix === toCell.ix && iy === toCell.iy) {
        const points = this.#reconstruct(best, grid, current.key);
        return {
          points,
          steps: expanded,
          cells: closed.size,
          cell,
          from: fromCell,
          to: toCell,
          distance: pathLength(points),
          // Every brush entity that moves and that the route walks through or
          // over: what the caller has to open, press or ride. Reported in the
          // order the route meets them, because a door early on gates everything
          // after it.
          crossings: this.#crossingsOn(points),
        };
      }
      for (const [dx, dy] of neighbours) {
        const nx = ix + dx;
        const ny = iy + dy;
        const diagonal = dx !== 0 && dy !== 0;
        if (diagonal) {
          // Do not cut a corner the player cannot squeeze through.
          const sideA = this.#levelAt(grid, ix + dx, iy, z);
          const sideB = this.#levelAt(grid, ix, iy + dy, z);
          if (sideA === null || sideB === null) continue;
          if (Math.abs(sideA - z) > maxStepUp || Math.abs(sideB - z) > maxStepUp) continue;
        }
        // Every floor in the neighbour's column is a candidate, not just the one
        // nearest the height the search is at. A column can hold several: a
        // ledge over a floor, the top and bottom of a lift shaft, the storeys of
        // a room. Offering only the nearest is what makes a search believe it
        // cannot step down a level it has walked over.
        for (const level of grid.floors.get(nx + "," + ny) || []) {
          const climb = level - z;
          if (climb > maxStepUp || -climb > maxDrop) continue;
          // A drop is free going down and impossible coming back; the search is
          // one-way, so it is allowed, but a cell that blocks or burns is not.
          const contents = contentsOf(nx, ny, level);
          if (contents & BLOCKING) continue;
          const nextKey = key(nx, ny, level);
          if (closed.has(nextKey)) continue;
          const g = current.g + (diagonal ? cell * 1.414 : cell) + (contents & HAZARDOUS ? cell * 40 : 0) + Math.abs(climb) * 2;
          const known = best.get(nextKey);
          if (known && known.g <= g) continue;
          best.set(nextKey, { g, prev: current.key });
          open.push({ f: g + heuristic(nx, ny), key: nextKey, g });
        }
      }
      // Gaps: a floor the player can reach by jumping over open air. Only when
      // the caller asked for it (maxJump > 0), because a jump is a risk the
      // route should not take silently.
      if (maxJump > 0) {
        const reach = Math.ceil(maxJump / cell);
        for (const [dx, dy] of neighbours) {
          for (let r = 2; r <= reach; r++) {
            // `maxJump` is a distance, not a number of cells: a diagonal run of
            // r cells is r * 1.414 cells long, so counting cells alone would let
            // a "160 unit" jump reach 237 units at 24-unit cells -- further than
            // the option asked for and further than a run-and-leap carries.
            if (Math.hypot(dx * r, dy * r) * cell > maxJump) continue;
            const nx = ix + dx * r, ny = iy + dy * r;
            for (const level of grid.floors.get(nx + "," + ny) || []) {
              if (level - z > maxStepUp || z - level > maxJumpDown) continue;
              const nextKey = key(nx, ny, level);
              if (closed.has(nextKey)) continue;
              if (!this.#clearLine(grid.minX + ix * cell, grid.minY + iy * cell, z, grid.minX + nx * cell, grid.minY + ny * cell, level)) continue;
              const contents = contentsOf(nx, ny, level);
              if (contents & BLOCKING) continue;
              const g = current.g + r * cell + Math.abs(level - z) * 2 + cell * 4; // a jump costs more than a step
              const known = best.get(nextKey);
              if (known && known.g <= g) continue;
              best.set(nextKey, { g, prev: current.key, jump: r * cell });
              open.push({ f: g + heuristic(nx, ny), key: nextKey, g });
            }
          }
        }
      }
    }
    const [cix, ciy, ciz] = bestKey.split(",").map(Number);
    const reached = { x: grid.minX + cix * cell, y: grid.minY + ciy * cell, z: ciz };
    const blockers = this.#blockersNear(reached);
    return {
      points: [],
      reason: expanded >= limit ? "NODE_LIMIT" : "NO_ROUTE",
      message: expanded >= limit
        ? "gave up after " + expanded + " cells (raise maxNodes)"
        : "the floor grid does not connect " + JSON.stringify({ x: grid.minX + fromCell.ix * cell, y: grid.minY + fromCell.iy * cell, z: fromCell.z }) +
          " to " + JSON.stringify({ x: grid.minX + toCell.ix * cell, y: grid.minY + toCell.iy * cell, z: toCell.z }) +
          " on foot; the closest the search reached was " + bestScore.toFixed(0) + " units short" +
          (blockers.length ? ", and the brush entities nearest that point are " +
            blockers.map((b) => b.classname + " " + b.model + " at " + b.distance.toFixed(0) + " units (" + b.why + ")").join(", ") : ""),
      closest: [cix, ciy, ciz],
      reached,
      blockers,
      cells: closed.size,
      steps: expanded,
      cell,
      from: fromCell,
      to: toCell,
    };
  }

  // Walk the predecessor chain back and drop the points that are already on a
  // straight line between their neighbours: a hundred identical steps are hard
  // to read and no easier to follow.
  #reconstruct(best, grid, lastKey) {
    const points = [];
    let cursor = lastKey;
    while (cursor) {
      const [ix, iy, z] = cursor.split(",").map(Number);
      const node = best.get(cursor);
      points.push({ x: grid.minX + ix * grid.cell, y: grid.minY + iy * grid.cell, z, jump: node && node.jump ? node.jump : 0 });
      cursor = node ? node.prev : null;
      if (points.length > grid.columnsX * grid.columnsY * 400) break; // a corrupt chain must not spin
    }
    points.reverse();
    // Collapse runs that travel in the same direction: a hundred identical steps
    // are hard to read and no easier to follow. A jump is never collapsed: it is
    // the one step the follower has to treat differently.
    const simplified = [];
    for (let i = 0; i < points.length; i++) {
      if (i === 0 || i === points.length - 1) { simplified.push(points[i]); continue; }
      const previous = points[i - 1];
      const next = points[i + 1];
      const straight = (points[i].x - previous.x) * (next.y - points[i].y) === (points[i].y - previous.y) * (next.x - points[i].x);
      if (!straight || points[i].z !== previous.z || points[i].z !== next.z || points[i].jump) simplified.push(points[i]);
    }
    return simplified;
  }

  // Can a player run from one spot to another through open air? Sampled at the
  // body's height, because that is what a jump has to clear: the pit's lip, not
  // the floor it lands on.
  #clearLine(ax, ay, az, bx, by, bz) {
    const span = Math.hypot(bx - ax, by - ay);
    const steps = Math.max(2, Math.ceil(span / 8));
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      const x = ax + (bx - ax) * t;
      const y = ay + (by - ay) * t;
      const z = az + (bz - az) * t;
      for (const lift of [8, 24, 40, 52]) if (this.isSolid(x, y, z + lift)) return false;
    }
    return true;
  }

  // The brush entities a route walks through or over, in route order. A point is
  // "in" a mover when it is inside its box with a little slack: the route's grid
  // points stop at the floor, and a door's floor is the world's, not the door's.
  #crossingsOn(points, slack = 24) {
    const seen = new Set();
    const crossings = [];
    for (const point of points) {
      for (const model of this.models) {
        if (model.kind !== "mover" || seen.has(model.ref)) continue;
        const inside =
          point.x >= model.mins.x - slack && point.x <= model.maxs.x + slack &&
          point.y >= model.mins.y - slack && point.y <= model.maxs.y + slack &&
          point.z >= model.mins.z - slack && point.z <= model.maxs.z + slack;
        if (!inside) continue;
        seen.add(model.ref);
        crossings.push({
          classname: model.classname, model: model.ref, targetname: model.targetname, target: model.target,
          centre: { ...model.centre },
          action: /^func_door/.test(model.classname) ? "open" : /^func_plat$|^func_train$/.test(model.classname) ? "ride" : "press",
          at: { x: point.x, y: point.y, z: point.z },
        });
      }
    }
    return crossings;
  }

  // The brush entities standing nearest a point where a search stopped. This is
  // what turns "there is no route" into "there is no route, and a func_door is
  // 30 units from where it gave up": a caller can then open the door, or say
  // honestly that the level's static floor plan does not connect.
  #blockersNear(point, radius = 192) {
    const out = [];
    for (const model of this.models) {
      if (model.kind === "none") continue;
      const distance = Math.max(0, distanceBetween(point, model.centre) - Math.max(model.size.x, model.size.y, model.size.z) / 2);
      if (distance > radius) continue;
      const contents = this.modelContentsAt(model, model.centre.x, model.centre.y, model.centre.z);
      out.push({
        classname: model.classname,
        model: model.ref,
        kind: model.kind,
        targetname: model.targetname,
        centre: { ...model.centre },
        size: { ...model.size },
        distance,
        // Named, so the answer says *why* this one is in the way rather than
        // just that something is.
        why: model.kind === "mover"
          ? "moves: the route may pass once it is opened, pressed or ridden"
          : (contents & BLOCKING) !== 0 ? "static brush entity, solid" : "static brush entity, thin or hollow",
      });
    }
    return out.sort((a, b) => a.distance - b.distance).slice(0, 8);
  }
}

// How long a route is along the ground, jumps and all.
function pathLength(points) {
  let total = 0;
  for (let i = 1; i < points.length; i++) total += distanceBetween(points[i - 1], points[i]);
  return total;
}

// ---- Loading --------------------------------------------------------------

const CACHE = new Map();

// Accept "demo1", "demo1.bsp", "maps/demo1.bsp" -- an agent should not have to
// guess how much of the path the engine wants.
export function normalizeMapName(name) {
  const cleaned = String(name || "").trim().toLowerCase().replace(/\\/g, "/").replace(/^.*\//, "").replace(/\.bsp$/, "");
  if (!cleaned) throw new RouteError("a map name is required", "BAD_REQUEST");
  return cleaned;
}

// Read a byte range out of the engine's own file system, through the bridge.
// Only the ranges that are needed cross the wire -- the archive is 50 MB and
// the four lumps this module uses are a few hundred kilobytes of it.
function engineReadExpression(path, offset, length) {
  return `(function () {
    try {
      const stream = FS.open(${JSON.stringify(path)}, "r");
      const buffer = new Uint8Array(${length});
      const read = FS.read(stream, buffer, 0, ${length}, ${offset});
      FS.close(stream);
      let binary = "";
      const chunk = 0x8000;
      for (let at = 0; at < read; at += chunk) {
        binary += String.fromCharCode.apply(null, buffer.subarray(at, Math.min(at + chunk, read)));
      }
      return btoa(binary);
    } catch (error) {
      return "ERR:" + (error && error.message ? error.message : String(error));
    }
  })()`;
}

function decodeBase64(text, what) {
  const bytes = Buffer.from(String(text), "base64");
  if (!bytes.length && text !== "") throw new RouteError("the engine's " + what + " came back empty", "ENGINE_READ");
  return bytes;
}

// The engine's copy of the archive. The offsets are read from the header and
// then each needed range in turn: header, directory, then the BSP's lumps --
// which means two round trips for the archive and one per lump.
async function loadMapFromEngine(control, name) {
  const pakPath = "/baseq2/pak0.pak";
  const headerText = await control.evaluate(engineReadExpression(pakPath, 0, 12));
  if (typeof headerText !== "string" || headerText.startsWith("ERR:")) {
    throw new RouteError("the engine could not read " + pakPath + " (" + headerText + ")", "ENGINE_READ");
  }
  const header = decodeBase64(headerText, "PAK header");
  if (header.toString("latin1", 0, 4) !== "PACK") throw new RouteError("the engine's " + pakPath + " is not a PAK", "BAD_PAK");
  const directoryOffset = header.readUInt32LE(4);
  const directoryLength = header.readUInt32LE(8);
  const directoryText = await control.evaluate(engineReadExpression(pakPath, directoryOffset, directoryLength));
  if (typeof directoryText !== "string" || directoryText.startsWith("ERR:")) {
    throw new RouteError("the engine could not read the PAK directory (" + directoryText + ")", "ENGINE_READ");
  }
  const directory = decodeBase64(directoryText, "PAK directory");
  // The entries in the directory are relative to the archive's start, and the
  // BSP is read straight out of the archive in ranges, so nothing is copied
  // whole.
  const wanted = ("maps/" + name + ".bsp").toLowerCase();
  let entry = null;
  const available = [];
  for (let offset = 0; offset + PAK_ENTRY_BYTES <= directory.length; offset += PAK_ENTRY_BYTES) {
    const entryName = directory.toString("latin1", offset, offset + 56).replace(/\0.*$/, "").replace(/\\/g, "/");
    if (!entryName) continue;
    if (entryName.toLowerCase().startsWith("maps/")) available.push(entryName);
    if (entryName.toLowerCase() === wanted) {
      entry = { name: entryName, offset: directory.readUInt32LE(offset + 56), length: directory.readUInt32LE(offset + 60) };
    }
  }
  if (!entry) throw new RouteError(mapNotFoundMessage(name, available), "MAP_NOT_FOUND");

  const headerBytes = 8 + HEADER_LUMPS * 8;
  const bspHeaderText = await control.evaluate(engineReadExpression(pakPath, entry.offset, headerBytes));
  const head = decodeBase64(bspHeaderText, "BSP header");
  if (head.readUInt32LE(0) !== BSP_IDENT) throw new RouteError("maps/" + name + ".bsp in the engine is not a BSP", "BAD_BSP");
  if (head.readInt32LE(4) !== BSP_VERSION_Q2) throw new RouteError("maps/" + name + ".bsp in the engine is BSP version " + head.readInt32LE(4) + ", not 38", "BAD_BSP");

  // Only four lumps are needed, and they are read one range at a time. They are
  // then written back into a BSP of our own -- a fresh header with those lumps
  // packed after it -- so the geometry code below sees an ordinary BSP and never
  // has to know the bytes arrived in pieces.
  const requested = [LUMP_ENTITIES, LUMP_PLANES, LUMP_NODES, LUMP_LEAFS];
  const pieces = [];
  for (const lumpIndex of requested) {
    const offset = head.readInt32LE(8 + lumpIndex * 8);
    const length = head.readInt32LE(12 + lumpIndex * 8);
    if (length <= 0) throw new RouteError("maps/" + name + ".bsp has an empty lump " + lumpIndex + ", so its geometry cannot be read", "BAD_BSP");
    const text = await control.evaluate(engineReadExpression(pakPath, entry.offset + offset, length));
    if (typeof text !== "string" || text.startsWith("ERR:")) throw new RouteError("the engine could not read BSP lump " + lumpIndex + " (" + text + ")", "ENGINE_READ");
    pieces.push({ lumpIndex, bytes: decodeBase64(text, "BSP lump " + lumpIndex) });
  }
  const total = pieces.reduce((sum, piece) => sum + piece.bytes.length, 0);
  const rebuild = Buffer.alloc(headerBytes + total);
  rebuild.writeUInt32LE(BSP_IDENT, 0);
  rebuild.writeInt32LE(BSP_VERSION_Q2, 4);
  let cursor = headerBytes;
  for (const piece of pieces) {
    rebuild.writeInt32LE(cursor, 8 + piece.lumpIndex * 8);
    rebuild.writeInt32LE(piece.bytes.length, 12 + piece.lumpIndex * 8);
    piece.bytes.copy(rebuild, cursor);
    cursor += piece.bytes.length;
  }
  return { bsp: rebuild, source: "engine:/baseq2/pak0.pak" };
}

function mapNotFoundMessage(name, available) {
  return 'no map named "' + name + '" in the archive. It holds: ' + (available.length ? available.join(", ") : "(no maps at all)");
}

// Load a map by name. options.control (a QuakeControl, or anything with an async
// evaluate) reads the map out of the running engine instead of off the disk;
// options.pak points at a different archive; options.source forces "pak" or
// "engine".
export async function loadMap(name, options = {}) {
  const mapName = normalizeMapName(name);
  const source = options.source || (options.control ? "engine" : "pak");
  const cacheKey = source + ":" + mapName + ":" + (options.pak || DEFAULT_PAK);
  if (CACHE.has(cacheKey)) return CACHE.get(cacheKey);

  let bsp;
  let where;
  if (source === "engine") {
    if (!options.control) throw new RouteError('source "engine" needs a control object to ask', "BAD_REQUEST");
    const loaded = await loadMapFromEngine(options.control, mapName);
    bsp = loaded.bsp;
    where = loaded.source;
  } else {
    const pakPath = options.pak || DEFAULT_PAK;
    if (!existsSync(pakPath)) {
      throw new RouteError("no PAK at " + pakPath + " (pass options.pak, or options.control to read the engine's copy)", "NO_PAK");
    }
    const pak = readFileSync(pakPath);
    const found = readPakFile(pak, "maps/" + mapName + ".bsp");
    if (!found) {
      const available = [...readPakDirectory(pak).keys()].filter((entry) => entry.startsWith("maps/")).sort();
      throw new RouteError(mapNotFoundMessage(mapName, available), "MAP_NOT_FOUND");
    }
    bsp = Buffer.from(found);
    where = pakPath;
  }
  const map = new RouteMap(mapName, bsp, where);
  CACHE.set(cacheKey, map);
  return map;
}

// The map names this archive holds -- what a caller wants when a name was wrong.
export function listMaps(pakPath = DEFAULT_PAK) {
  if (!existsSync(pakPath)) throw new RouteError("no PAK at " + pakPath, "NO_PAK");
  return [...readPakDirectory(readFileSync(pakPath)).keys()]
    .filter((entry) => entry.startsWith("maps/") && entry.endsWith(".bsp"))
    .map((entry) => entry.replace(/^maps\//, "").replace(/\.bsp$/, ""))
    .sort();
}

// ---- The three questions, as free functions -------------------------------

// Where does this level end? Throws rather than answering with nothing.
export async function exitPoint(map, options) {
  return (await loadMap(map, options)).exitPoint();
}

// Everything worth steering towards, tagged by kind.
export async function waypoints(map, kind, options) {
  return (await loadMap(map, options)).waypoints(kind);
}

// The closest one of those to a point.
export async function nearest(map, from, kind, options) {
  return (await loadMap(map, options)).nearest(from, kind);
}

// A walkable route between two points, or a reason there is none.
export async function path(map, from, to, options) {
  return (await loadMap(map, options)).path(from, to, options);
}

// ---- A tiny CLI, because "where is the exit" is worth asking by hand --------

if (process.argv[1] && import.meta.url === new URL("file://" + process.argv[1]).href) {
  const [, , command = "list", argument] = process.argv;
  const run = async () => {
    if (command === "list") { console.log(listMaps().join("\n")); return; }
    if (command === "pak") {
      const pak = readFileSync(argument || DEFAULT_PAK);
      const wanted = process.argv[4] || null;
      const entries = [...readPakDirectory(pak).values()].filter((entry) => !wanted || entry.name.includes(wanted));
      console.log(entries.map((entry) => entry.name.padEnd(40) + entry.length).join("\n"));
      return;
    }
    const map = await loadMap(argument || "demo1");
    if (command === "exit") { console.log(JSON.stringify(map.exitPoint(), null, 2)); return; }
    if (command === "waypoints") { console.log(JSON.stringify(map.waypoints(process.argv[4] || null), null, 2)); return; }
    if (command === "path") {
      const from = map.playerStart().position;
      const to = map.exitPoint().position;
      const found = map.path(from, to);
      console.log(JSON.stringify({ from, to, reason: found.reason || null, steps: found.steps, points: found.points.length, message: found.message || null }, null, 2));
      if (found.points.length) console.log(found.points.map((point) => `${point.x} ${point.y} ${point.z}`).join("\n"));
      return;
    }
    console.log(JSON.stringify(map.summary(), null, 2));
  };
  run().catch((error) => {
    console.error((error.code ? error.code + ": " : "") + error.message);
    process.exitCode = 1;
  });
}

export { DEFAULT_PAK, PROJECT_ROOT };
export { CONTENTS_SOLID, CONTENTS_WINDOW, CONTENTS_PLAYERCLIP, CONTENTS_MONSTERCLIP, BLOCKING, STOCK_PLAYER_SOLID, HAZARDOUS };
export default loadMap;
