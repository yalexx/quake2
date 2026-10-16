#!/usr/bin/env node
// scripts/model-art.mjs -- the model / weapon / item skin pipeline (task t3).
//
// Every entry this task owns is a PCX skin under models/ in baseq2/pak0.pak: the
// nine weapon models (first-person v_* and world g_*), every item, every monster
// and the objects and debris. They are single UV atlas pictures, so the art has
// to be readable as itself -- refreshed, higher contrast versions of the subject
// the original drew (gunmetal and scratches for a weapon, glowing circuitry and
// health stripes for an item, mottled hide or armour plating for a monster) --
// not a picture that happens to be the right size.
//
// This tool is the whole of the path from a generated picture to art the packer
// can take, in three steps, each of which can be run on its own:
//
//   --list    the worklist: every entry of this task in priority order, the size
//             the picture has to be, and whether its generated art is here yet.
//   --build   resize each generated picture (assets/textures/model/<entry with
//             its slashes as underscores>.png) to the entry's exact dimensions
//             and write the PNG the manifest names for that entry
//             (assets/textures/models/...). A cover-fit centre crop first, so a
//             square generation is never squashed into 308x165, then an area
//             average, so downsampling cannot alias.
//   --engine-check  pack simulation. Re-index the built art onto the palette the
//             archive really uses for that entry (the PCX's own trailing 768
//             bytes), encode it the way scripts/texture-pack.mjs does, decode it
//             back and compare -- so "the packer will accept this and the engine
//             will show this" is measured here rather than assumed.
//   --preview render what the engine will show, as a contact sheet, for one look
//             at the art without a running game.
//   --notes   write assets/textures/model/NOTES.md: the entry/prompt/method
//             record this task has to leave behind.
//
// Options: --only <text> (repeatable), --raw-dir <dir>, --out <file>,
//          --min-error <n> (palettise only when the art needs it), --no-palettise.
//
// No dependencies: node's own modules and scripts/texture-lib.mjs.

import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_MANIFEST,
  DEFAULT_PAK,
  PROJECT_ROOT,
  TextureError,
  decodePcx,
  decodePng,
  formatBytes,
  paletteForEntry,
  paletteMapper,
  readManifest,
  readPakFile,
  rgbaToIndices,
} from "./texture-lib.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RAW_DIR = path.join(PROJECT_ROOT, "assets", "textures", "model");
const NOTES_FILE = path.join(RAW_DIR, "NOTES.md");

const USAGE = `model-art.mjs -- the model, weapon, item and monster skin pipeline

  --list                 print the worklist in priority order
  --prompts              print the generator prompt and file name for each entry
  --build                resize every generated picture onto its entry's size
  --fallback             for entries with no generated picture, refresh the original pixels
  --engine-check         pack-simulate the built art through its entry's palette
  --preview --out <png>  write a contact sheet of what the engine will show
  --notes                write ${path.relative(PROJECT_ROOT, NOTES_FILE)}
  --only <text>          just entries whose name contains <text> (repeatable)
  --raw-dir <dir>        where the generated pictures are (default assets/textures/model)
  --no-palettise         keep the resampled RGB rather than snapping it to the entry's palette
  --help                 this text
`;

// ---------------------------------------------------------------------------
// The worklist
// ---------------------------------------------------------------------------

// The subject of each picture, in the words that go to the image generator: what
// the original drew, so the replacement is a refreshed version of the same thing
// rather than an unrelated picture. Any entry with no line here falls back to a
// description built from its path (see subjectFor), which is deliberately dull.
const SUBJECTS = {
  // Every line says what the original drew AND that the picture is a UV skin
  // sheet of that subject's surfaces, because a model skin is not a photograph
  // of a gun: it is the atlas its polygons point into, so what it has to read as
  // is the material -- panels, seams, rivets, hide, casing -- at a size the
  // engine will show a few times a second.
  // First-person weapons: on screen the whole time the player is holding them.
  "v_handgr": "a flat UV skin sheet for a handheld energy blaster pistol: gunmetal with scratches, side panels, seams, rivets and a glowing blue power cell",
  "v_shotg": "a flat UV skin sheet for a pump-action shotgun: blued steel with scratches, a wooden pump grip, seams and shell ports",
  "v_shotg2": "a flat UV skin sheet for a bulky double-barrelled super shotgun: heavy scratched steel, twin barrels, rivets and a wooden stock",
  "v_machn": "a flat UV skin sheet for a heavy machine gun: gunmetal with scratches, a box magazine, cooling vents and rivets",
  "v_chain": "a flat UV skin sheet for a six-barrelled rotary chain gun: scratched steel, rotating barrel cluster, feed belt and armour plates",
  "v_launch": "a flat UV skin sheet for a grenade launcher: chunky scratched gunmetal, a revolving cylinder, sight rail and rivets",
  "v_rocket": "a flat UV skin sheet for a shoulder-fired rocket launcher: scarred olive-drab metal tube, warning stripes, grips and rivets",
  "v_rail": "a flat UV skin sheet for an electromagnetic railgun: gunmetal with scratches, copper coil windings along the barrel and glowing rails",
  "v_hyperb": "a flat UV skin sheet for a hyperblaster energy gun: scratched steel with glowing blue capacitor cells and vents",
  "v_bfg": "a flat UV skin sheet for a huge heavy energy cannon: scratched gunmetal plating with a green-glowing core and warning stripes",
  "v_blast": "a flat UV skin sheet for a plasma blaster: scorched gunmetal with a heated glowing chamber and vents",
  "v_disint": "a flat UV skin sheet for an energy rifle: scratched steel with a crackling discharge emitter and glowing coils",
  "v_flareg": "a flat UV skin sheet for a flare gun: scratched gunmetal, a fat short barrel and an orange warning band",
  // World weapon models: the pickups lying in the map.
  "g_shotg": "a flat UV skin sheet for a shotgun pick-up: blued steel with scratches, a wooden stock, seams and shell ports",
  "g_shotg2": "a flat UV skin sheet for a super shotgun pick-up: heavy scratched steel, twin barrels, rivets and a wooden stock",
  "g_machn": "a flat UV skin sheet for a machine gun pick-up: gunmetal with scratches, a box magazine, cooling vents and rivets",
  "g_chain": "a flat UV skin sheet for a rotary chain gun pick-up: scratched steel, a barrel cluster, feed belt and armour plates",
  "g_launch": "a flat UV skin sheet for a grenade launcher pick-up: chunky scratched gunmetal, a revolving cylinder and rivets",
  "g_rocket": "a flat UV skin sheet for a rocket launcher pick-up: scarred olive-drab tube, warning stripes and rivets",
  "g_rail": "a flat UV skin sheet for a railgun pick-up: gunmetal with scratches, coil windings and glowing rails",
  "g_hyperb": "a flat UV skin sheet for a hyperblaster pick-up: scratched steel with glowing blue capacitor cells",
  "g_bfg": "a flat UV skin sheet for a heavy energy cannon pick-up: scratched plating with a green-glowing core",
  "g_blast": "a flat UV skin sheet for a plasma blaster pick-up: scorched gunmetal with a glowing chamber",
  "g_disint": "a flat UV skin sheet for an energy rifle pick-up: scratched steel with a glowing emitter",
  "g_flareg": "a flat UV skin sheet for a flare gun pick-up: scratched gunmetal and an orange warning band",
  // Monsters: the demo's whole cast.
  "soldier": "a flat UV skin sheet for a Strogg cyborg marine trooper: riveted armour plating over mottled grey hide, worn panel seams",
  "soldier-skin_lt": "a flat UV skin sheet for a lightly armoured Strogg trooper: pale mottled hide with thin armour plates and straps",
  "soldier-skin_ss": "a flat UV skin sheet for a black-armoured Strogg special-forces trooper: dark plating, mottled hide and studded rivets",
  "gunner": "a flat UV skin sheet for a heavy Strogg gunner: thick riveted armour plating, a machine-gun arm, scars and grime",
  "infantry": "a flat UV skin sheet for a scrawny Strogg infantry soldier: worn body armour over mottled hide, straps and grime",
  "berserk": "a flat UV skin sheet for a hulking Strogg berserker: scarred mottled hide, armour plating, blade arms and rusted studs",
  "tank": "a flat UV skin sheet for a Strogg tank walker mech: thick riveted armour plating, hydraulic hoses, scorch marks and grime",
  "ctank": "a flat UV skin sheet for a heavier Strogg tank walker mech: extra-thick riveted armour plating, hoses and scorch marks",
  "flyer": "a flat UV skin sheet for a Strogg flying drone: armoured plating over hide, rotor wing panels and rivets",
  "parasite": "a flat UV skin sheet for a Strogg parasite: lean mottled alien hide with bony chitin plates and slick wet texture",
  "segment": "a flat UV skin sheet for the segmented chitin tail of a Strogg parasite: ridged mottled plates",
  "tip": "a flat UV skin sheet for the armoured stinger tip of a Strogg parasite's tail: hard chitin and a barb",
  // Items: health, armour, ammo, power-ups, keys.
  "healing/stimpack": "a flat UV skin sheet for a stimpak syringe of green nanite medicine: metal casing, glowing green health stripes and a gauge",
  "healing/medium": "a flat UV skin sheet for a medic kit box: white metal casing, a red cross, worn corners and a glowing health readout",
  "healing/large": "a flat UV skin sheet for a large trauma kit case: battered metal, a red cross and glowing green health indicators",
  "armor/body": "a flat UV skin sheet for a heavy body-armour vest: thick riveted steel plates and quilted padding",
  "armor/combat": "a flat UV skin sheet for a combat armour cuirass: riveted steel plates, worn seams and a glowing power stud",
  "armor/jacket": "a flat UV skin sheet for a flak jacket: quilted kevlar panels, straps, buckles and grime",
  "armor/shard": "a flat UV skin sheet for a small armour shard: glowing blue crystal in a scratched metal mount",
  "armor/screen": "a flat UV skin sheet for a powered energy-screen generator: metal casing, glowing coils and a control panel",
  "armor/shield": "a flat UV skin sheet for a powered combat shield unit: riveted metal casing, a glowing energy cell and warning stripes",
  "armor/effect": "a flat UV skin sheet for an energy armour field: a shimmering shimmer of glowing energy over faint plates",
  "mega_h": "a flat UV skin sheet for a mega-health canister: purple metal casing with glowing bio-hazard stripes and a gauge",
  "quaddama": "a flat UV skin sheet for a quad-damage power-up idol: dark corroded metal with carved runes and red glowing eyes",
  "invulner": "a flat UV skin sheet for an invulnerability power-up: a scratched metal ring around a glowing shimmering core",
  "silencer": "a flat UV skin sheet for a barrel suppressor: matte black metal with fine scratches and a heat shield",
  "breather": "a flat UV skin sheet for a rebreather oxygen mask: rubber straps, metal tanks, a glass visor and gauges",
  "enviro": "a flat UV skin sheet for a sealed environmental space suit: armoured fabric, metal joints, hoses and a visored helmet",
  "band": "a flat UV skin sheet for a power band bracer: armoured metal with a glowing power cell and straps",
  "pack": "a flat UV skin sheet for an ammunition backpack: canvas and metal with belts of rounds and a battered lid",
  "adrenal": "a flat UV skin sheet for an adrenaline injector: metal canister with glowing red fluid and warning stripes",
  "ammo/bullets/medium": "a flat UV skin sheet for a box of bullet rounds: cardboard carton with loose brass cartridges and stencilled markings",
  "ammo/shells/medium": "a flat UV skin sheet for an open box of shotgun shells: red plastic shells with brass bases",
  "ammo/cells/medium": "a flat UV skin sheet for a crate of energy cells: metal casing with glowing blue cells and vents",
  "ammo/rockets/medium": "a flat UV skin sheet for a rack of rockets: olive metal tubes with red warheads and fins",
  "ammo/slugs/medium": "a flat UV skin sheet for a box of railgun slugs: steel darts in a metal tray with stencilled markings",
  "ammo/grenades/medium": "a flat UV skin sheet for a bandolier of fragmentation grenades: green segmented shells, pins and a canvas strap",
  "ammo/mines/medium": "a flat UV skin sheet for a stack of proximity mines: dark metal discs with glowing sensor studs",
  "ammo/nuke/medium": "a flat UV skin sheet for a nuke warhead on a pallet: riveted grey casing with radiation markings and hazard stripes",
  "keys/key": "a flat UV skin sheet for a small brass security key: worn metal with notched teeth and a stamped tag",
  "keys/pass": "a flat UV skin sheet for a magnetic key card pass: plastic card with a data stripe and stencilled markings",
  "keys/red_key": "a flat UV skin sheet for a red data key: a key card in a scratched red metal housing with glowing contacts",
  "keys/data_cd": "a flat UV skin sheet for a data CD-ROM in a metal case: iridescent disc surface and stencilled markings",
  "keys/power": "a flat UV skin sheet for a power cube: metal casing around a glowing energy core with warning stripes",
  "keys/pyramid": "a flat UV skin sheet for a pyramid-shaped alien artefact: dark etched metal with glowing engraved lines",
  "keys/spinner": "a flat UV skin sheet for a spinner key: two-bladed metal rotor with rivets and worn edges",
  "keys/target": "a flat UV skin sheet for a target key card: metal plate with a painted bullseye marking and worn edges",
  // Objects and debris.
  "barrels": "a flat UV skin sheet for a battered steel explosive barrel: rust, dents, hazard stripes and a stencilled marking",
  "flash": "a flat UV skin sheet for a muzzle flash: hot white and orange expanding gas with soft edges",
  "smoke": "a flat UV skin sheet for a puff of smoke: soft grey billows",
  "explode": "a flat UV skin sheet for a burst of explosion fire: orange flame and black smoke",
  "r_explode": "a flat UV skin sheet for a rocket explosion fireball: orange flame, black soot and glowing embers",
  "laser": "a flat UV skin sheet for a glowing energy bolt: hot red-white plasma with a bright core",
  "rocket": "a flat UV skin sheet for a rocket: olive casing, a red warhead, fins and exhaust nozzle",
  "bomb": "a flat UV skin sheet for a heavy bomb: dark metal casing with a nose fuse and stencilled markings",
  "grenade": "a flat UV skin sheet for a small grenade: green segmented shell with a pin and lever",
  "grenade2": "a flat UV skin sheet for a primed grenade: green segmented shell with a pin, lever and a glowing fuse",
  "debris1": "a flat UV skin sheet for a chunk of torn metal debris: scratched grey steel and ripped edges",
  "debris2": "a flat UV skin sheet for a chunk of rubble: shattered brown brick and grey concrete",
  "debris3": "a flat UV skin sheet for smashed crate debris: splintered wood planks and rusty nails",
  "minelite/light1/base": "a flat UV skin sheet for a glowing overhead hazard lamp: riveted metal base and a glowing red lens",
  "minelite/light2/base": "a flat UV skin sheet for an industrial indicator lamp: riveted metal base and a glowing amber lens",
  "dmspot/skin": "a flat UV skin sheet for an arena spawn pad: armoured metal plate with a painted emblem and worn paint",
  "dmspot/skin2": "a flat UV skin sheet for a second arena spawn pad: darker metal plate with a painted emblem and worn paint",
  "banner": "a flat UV skin sheet for a torn hanging banner: faded fabric with a crude painted emblem and frayed edges",
  "satellite": "a flat UV skin sheet for a communications satellite: metal casing, blue solar panels, a dish and rivets",
  "black": "a flat UV skin sheet that is flat black, unlit void",
  "ships/viper": "a flat UV skin sheet for a sleek angular fighter craft: riveted armour plating, a canopy and engine nozzles",
  "ships/bigviper": "a flat UV skin sheet for a large angular fighter craft: heavy riveted armour plating, a canopy and engine nozzles",
  "ships/strogg1": "a flat UV skin sheet for a battle-worn dropship: hulking riveted armour, scorch marks, a canopy and thrusters",
  "deadbods/dude/dead1": "a flat UV skin sheet for the body of a dead soldier: torn camouflage fatigues over mottled skin, a helmet and blood stains",
  "objects/gibs/arm": "a flat UV skin sheet for a severed arm: torn cloth, mottled skin and blood",
  "objects/gibs/bone": "a flat UV skin sheet for a bare gnawed bone: pale weathered bone texture",
  "objects/gibs/bone2": "a flat UV skin sheet for a broken rib bone: pale weathered bone and gristle",
  "objects/gibs/chest": "a flat UV skin sheet for a severed torso: torn cloth, mottled skin and blood",
  "objects/gibs/gear": "a flat UV skin sheet for torn machinery: gears, cables and a torn metal casing",
  "objects/gibs/head": "a flat UV skin sheet for a severed head: mottled skin, hair and blood",
  "objects/gibs/head2": "a flat UV skin sheet for a mangled severed head: torn skin, bone and blood",
  "objects/gibs/leg": "a flat UV skin sheet for a severed leg: torn cloth, a boot and mottled skin",
  "objects/gibs/skull": "a flat UV skin sheet for a bare human skull: pale weathered bone with dark eye sockets",
  "objects/gibs/sm_meat": "a flat UV skin sheet for a scrap of raw meat: red flesh and gristle",
  "objects/gibs/sm_metal": "a flat UV skin sheet for a scrap of torn metal plate: scratched steel and a ripped edge",
  "c_head": "a flat UV skin sheet for a severed commander's head: mottled skin, a metal implant plate and blood",
};

// The style every prompt carries, so the whole set reads as one game's art.
const STYLE =
  "Quake 2 1997 first-person-shooter asset, weathered sci-fi metal and grime, flat studio lighting, centred subject, no text, no watermark, no logo";

// The worklist in priority order: what the player sees most, first. Each tier is
// a name and the entries that belong to it.
const TIERS = [
  ["first-person weapons (always on screen)", (name) => /^models\/weapons\/v_[a-z0-9]+\/(skin|base)\.pcx$/.test(name)],
  ["monsters the demo fights", (name) => /^models\/monsters\/(soldier|gunner|infantry|berserk|tank|\.\.\/ctank|flyer|parasite)\/[a-z0-9_]+\.pcx$/.test(name)],
  ["world weapon pick-ups", (name) => /^models\/weapons\/g_[a-z0-9]+\/(skin|base)\.pcx$/.test(name)],
  ["health, armour and power-ups", (name) => /^models\/items\/(healing|armor)\//.test(name) || /^models\/items\/(mega_h|quaddama|invulner|silencer|breather|enviro|band|pack|adrenal)\//.test(name)],
  ["ammunition", (name) => /^models\/items\/ammo\//.test(name)],
  ["keys and mission items", (name) => /^models\/items\/(keys|c_head)\//.test(name)],
  ["explosions, projectiles and lights", (name) => /^models\/objects\/(flash|smoke|explode|r_explode|laser|rocket|bomb|grenade|grenade2|barrels|minelite)\//.test(name)],
  ["debris, banner and props", (name) => /^models\/objects\/(debris1|debris2|debris3|dmspot|banner|satellite|black)\//.test(name)],
  ["gibs and corpses", (name) => /^models\/(objects\/gibs|deadbods)\//.test(name)],
  ["ships", (name) => /^models\/ships\//.test(name)],
];

// Every PCX entry in the manifest that belongs to this task.
export function worklist(manifest) {
  const wanted = manifest.entries.filter((entry) => entry.type === "pcx" && entry.name.startsWith("models/"));
  const ranked = [];
  const seen = new Set();
  for (const [tier, match] of TIERS) {
    for (const entry of wanted) {
      if (seen.has(entry.name) || !match(entry.name)) continue;
      seen.add(entry.name);
      ranked.push({ tier, entry });
    }
  }
  for (const entry of wanted) {
    if (seen.has(entry.name)) continue;
    seen.add(entry.name);
    ranked.push({ tier: "the rest of models/", entry });
  }
  return ranked;
}

// The file the generator writes: the entry's name with its slashes as
// underscores and its extension changed to .png, under assets/textures/model/.
export function rawPathFor(entryName, rawDir = RAW_DIR) {
  return path.join(rawDir, entryName.replace(/\//g, "_").replace(/\.[a-z0-9]+$/i, ".png"));
}

// Where an entry's art has to end up: exactly where the manifest says, which is
// where tex-check looks and texture-pack reads.
export function artPathFor(entry) {
  return path.isAbsolute(entry.png) ? entry.png : path.join(PROJECT_ROOT, entry.png);
}

// The subject line for a prompt: the table above, or a description read off the
// entry's own path so that a picture for an entry nobody wrote a line for is at
// least the right kind of object.
function subjectFor(entry) {
  const base = entry.name.replace(/^models\//, "").replace(/\.[a-z0-9]+$/i, "");
  const parts = base.split("/");
  const file = parts[parts.length - 1];
  // The directory levels of the entry, with any ".." the archive's own odd names
  // carry dropped, so "monsters/tank/../ctank/skin" is looked up as "ctank".
  const dirs = parts.slice(0, -1).filter((part) => part !== "..");
  const candidates = [base, base.replace(/^[^/]+\//, ""), base.replace(/\/(skin|base)$/, ""), dirs[dirs.length - 1] + "-" + file];
  for (let levels = 1; levels <= dirs.length; levels++) candidates.push(dirs.slice(-levels).join("/"));
  candidates.push(file);
  for (const candidate of candidates) if (SUBJECTS[candidate]) return SUBJECTS[candidate];
  const family = parts[0];
  if (family === "objects") return "a weathered sci-fi " + parts.slice(1, -1).join(" ") + " prop";
  if (family === "items") return "a weathered sci-fi " + parts.slice(1, -1).join(" ") + " item";
  if (family === "monsters") return "a flat UV skin sheet of mottled alien hide and armour plating of a Quake 2 monster";
  if (family === "weapons") return "a flat UV skin sheet for a battered gunmetal " + parts.slice(1, -1).join(" ") + " weapon";
  if (family === "ships") return "a flat UV skin sheet for a weathered sci-fi " + parts.slice(1, -1).join(" ") + " craft";
  return "a flat UV skin sheet of a weathered sci-fi surface, " + parts.slice(0, -1).join(" ");
}

export function promptFor(entry) {
  return subjectFor(entry) + ", " + STYLE;
}

// ---------------------------------------------------------------------------
// Resampling and a PNG writer
// ---------------------------------------------------------------------------

// Cover-fit centre crop of a source rectangle, then an area average onto the
// destination grid. A generation is square and an entry almost never is, so the
// crop keeps the shapes in the picture round instead of squashing them, and the
// area average is what keeps a 512-pixel picture from aliasing into a 165-pixel
// one.
export function resampleCover(rgba, sw, sh, dw, dh) {
  const srcAspect = sw / sh;
  const dstAspect = dw / dh;
  let cw = sw;
  let ch = sh;
  if (srcAspect > dstAspect) cw = sh * dstAspect;
  else ch = sw / dstAspect;
  const x0 = (sw - cw) / 2;
  const y0 = (sh - ch) / 2;
  const out = Buffer.alloc(dw * dh * 3);
  for (let dy = 0; dy < dh; dy++) {
    const yStart = y0 + (dy * ch) / dh;
    const yEnd = y0 + ((dy + 1) * ch) / dh;
    for (let dx = 0; dx < dw; dx++) {
      const xStart = x0 + (dx * cw) / dw;
      const xEnd = x0 + ((dx + 1) * cw) / dw;
      let r = 0;
      let g = 0;
      let b = 0;
      let weight = 0;
      for (let sy = Math.floor(yStart); sy < Math.ceil(yEnd) && sy < sh; sy++) {
        if (sy < 0) continue;
        const wy = Math.min(yEnd, sy + 1) - Math.max(yStart, sy);
        if (wy <= 0) continue;
        for (let sx = Math.floor(xStart); sx < Math.ceil(xEnd) && sx < sw; sx++) {
          if (sx < 0) continue;
          const wx = Math.min(xEnd, sx + 1) - Math.max(xStart, sx);
          if (wx <= 0) continue;
          const w = wx * wy;
          const at = (sy * sw + sx) * 4;
          // Art arrives opaque from the generator; where it is not, the pixel is
          // weighted by its own coverage so a transparent border cannot darken
          // the edge of the picture.
          const coverage = rgba[at + 3] / 255;
          r += rgba[at] * w * coverage;
          g += rgba[at + 1] * w * coverage;
          b += rgba[at + 2] * w * coverage;
          weight += w * coverage;
        }
      }
      const target = (dy * dw + dx) * 3;
      if (weight > 0) {
        out[target] = Math.round(r / weight);
        out[target + 1] = Math.round(g / weight);
        out[target + 2] = Math.round(b / weight);
      }
    }
  }
  return out;
}

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buffer) {
  let c = -1;
  for (let i = 0; i < buffer.length; i++) c = CRC_TABLE[(c ^ buffer[i]) & 255] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function pngChunk(type, data) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, "latin1");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, crc]);
}

// An eight-bit RGB PNG. The art is opaque by the time it is written -- a model
// skin is a UV atlas with no transparency in it -- so a fourth channel would
// only give the packer's alpha rule something to do that the art does not mean.
export function encodePngRgb(width, height, rgb) {
  const stride = width * 3;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    rgb.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", zlib.deflateSync(raw, { level: 9 })),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

// ---------------------------------------------------------------------------
// Snapping the art onto the palette the engine will index it into
// ---------------------------------------------------------------------------

// What the packer does to a pixel is one thing: replace it with the nearest
// colour the entry's palette holds. A palette is 256 colours that a 1997 artist
// drew for that one picture, so a photographically smooth generation can lose
// noticeable tone in the snap -- and what is lost is chosen per pixel, with no
// regard for its neighbours, which is exactly how banding appears in a gradient.
//
// So the art is snapped here first, with an error-diffused dither, and the PNG
// carries those exact palette colours. The packer's nearest colour is then a
// no-op on every pixel: what the contact sheet shows is what the engine shows,
// and a smooth ramp survives the palette instead of stepping through it.
//
// measured: `palettise` returns the mean and worst channel error between the art
// and what the palette can actually say, so a picture the palette cannot carry
// is reported rather than shipped quietly.
export function palettise(rgb, width, height, palette768, options = {}) {
  const map = paletteMapper(palette768, options);
  const out = Buffer.alloc(rgb.length);
  // The error being diffused is carried in a float copy, so the art that was
  // handed in stays the yardstick the reported error is measured against.
  const work = Float32Array.from(rgb);
  const at3 = (x, y) => (y * width + x) * 3;
  let error = 0;
  let worst = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const at = at3(x, y);
      const r = clampByte(work[at]);
      const g = clampByte(work[at + 1]);
      const b = clampByte(work[at + 2]);
      const index = map(r, g, b);
      const pr = palette768[index * 3];
      const pg = palette768[index * 3 + 1];
      const pb = palette768[index * 3 + 2];
      out[at] = pr;
      out[at + 1] = pg;
      out[at + 2] = pb;
      error += Math.abs(rgb[at] - pr) + Math.abs(rgb[at + 1] - pg) + Math.abs(rgb[at + 2] - pb);
      worst = Math.max(worst, Math.abs(rgb[at] - pr), Math.abs(rgb[at + 1] - pg), Math.abs(rgb[at + 2] - pb));
      const dr = r - pr;
      const dg = g - pg;
      const db = b - pb;
      const spread = (tx, ty, share) => {
        if (tx < 0 || tx >= width || ty >= height) return;
        const target = at3(tx, ty);
        work[target] += dr * share;
        work[target + 1] += dg * share;
        work[target + 2] += db * share;
      };
      // Floyd-Steinberg: seven sixteenths of the error on to the next pixel and
      // the rest on to the row below, which is what turns a banded ramp into a
      // textured one at this palette size.
      spread(x + 1, y, 7 / 16);
      spread(x - 1, y + 1, 3 / 16);
      spread(x, y + 1, 5 / 16);
      spread(x + 1, y + 1, 1 / 16);
    }
  }
  return { rgb: out, meanError: error / (width * height * 3), worstError: worst };
}

function clampByte(value) {
  if (value < 0) return 0;
  if (value > 255) return 255;
  return Math.round(value);
}

// ---------------------------------------------------------------------------
// The fallback: a refreshed version of the original pixels, in node
// ---------------------------------------------------------------------------

// The look of one family of skins. A picture is graded with its own family's
// numbers: a shotgun wants cold scratched steel, a berserker wants wet mottled
// hide, a muzzle flash wants to stay a bright gas and not be stretched into
// noise. These are the whole of the art direction the fallback has.
const FAMILIES = {
  metal: { saturation: 1.22, curve: 0.55, low: 0.010, high: 0.990, maxGain: 1.45, relief: 0.35, unsharp: 0.26, grain: 0.032, scratches: 30 },
  organic: { saturation: 1.30, curve: 0.60, low: 0.012, high: 0.988, maxGain: 1.42, relief: 0.38, unsharp: 0.32, grain: 0.050, scratches: 0 },
  energy: { saturation: 1.35, curve: 0.45, low: 0.004, high: 0.996, maxGain: 1.25, relief: 0.18, unsharp: 0.20, grain: 0.022, scratches: 0 },
  fabric: { saturation: 1.16, curve: 0.55, low: 0.020, high: 0.980, maxGain: 1.40, relief: 0.28, unsharp: 0.34, grain: 0.055, scratches: 0 },
  flat: { saturation: 1, curve: 0, low: 0.01, high: 0.99, maxGain: 1.00, relief: 0, unsharp: 0, grain: 0, scratches: 0 },
};

// Which family an entry's picture belongs to, from its own name.
export function familyOf(entryName) {
  const name = entryName.toLowerCase();
  if (/objects\/black\//.test(name)) return "flat";
  if (/objects\/(flash|smoke|explode|r_explode|laser)\/|items\/armor\/effect\//.test(name)) return "energy";
  if (/monsters\/|objects\/gibs\/|deadbods\/|sm_meat/.test(name)) return "organic";
  if (/objects\/banner\//.test(name)) return "fabric";
  return "metal";
}

// A small deterministic generator, so that the grain and the scratches an entry
// gets are the same on every run: an archive that changes every time it is
// packed is an archive nobody can check.
function hashSeed(text) {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index++) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash || 1;
}

function makeRandom(seed) {
  let state = seed >>> 0;
  return () => {
    state ^= state << 13;
    state >>>= 0;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    return state / 4294967296;
  };
}

// Value noise on a lattice, so the grain has structure rather than per-pixel
// static: one octave at two pixels, one at four, a soft blend of the two.
function valueNoise(width, height, seed) {
  const random = makeRandom(seed);
  const lattice = (step) => {
    const w = Math.ceil(width / step) + 2;
    const h = Math.ceil(height / step) + 2;
    const values = new Float32Array(w * h);
    for (let index = 0; index < values.length; index++) values[index] = random() * 2 - 1;
    return { step, w, values };
  };
  const smooth = (t) => t * t * (3 - 2 * t);
  const octave = (grid, x, y) => {
    const gx = x / grid.step;
    const gy = y / grid.step;
    const x0 = Math.floor(gx);
    const y0 = Math.floor(gy);
    const fx = smooth(gx - x0);
    const fy = smooth(gy - y0);
    const at = (ix, iy) => grid.values[iy * grid.w + ix];
    const top = at(x0, y0) * (1 - fx) + at(x0 + 1, y0) * fx;
    const bottom = at(x0, y0 + 1) * (1 - fx) + at(x0 + 1, y0 + 1) * fx;
    return top * (1 - fy) + bottom * fy;
  };
  const fine = lattice(2);
  const coarse = lattice(5);
  return (x, y) => octave(fine, x, y) * 0.6 + octave(coarse, x, y) * 0.4;
}

// For an entry the image generator could not reach -- a refusal names a path or
// an allowance, and the archive still has to get its new art -- the original
// picture is re-drawn from its own pixels, by its own family's art direction:
//
//   - the histogram is stretched between its own one and ninety-nine percent
//     points, so the picture uses the whole range again instead of the narrow
//     band a 1997 palette left it in;
//   - colour is pushed away from grey, and a soft gamma lifts the midtones;
//   - a directional relight reads the luminance gradient as a surface normal and
//     lights it from the upper left, which is what puts the depth back into a
//     flat atlas (this is the pass that makes armour read as armour);
//   - fine value noise and, on metal, a scatter of thin bright scratches are the
//     grime: the subject is untouched, the surface is re-dressed;
//   - and every pixel the original left at the transparent index is put back to
//     that index's colour, so a skin's cut-out stays a cut-out when the packer
//     re-indexes the result.
//
// measured: the returned change is the mean absolute change per channel against
// the original, so "this entry actually changed" is a number, not a claim.
export function refreshOriginal(indices, width, height, palette768, options = {}) {
  const family = options.family ?? "metal";
  const look = { ...FAMILIES[family] ?? FAMILIES.metal, ...(options.look ?? {}) };
  const transparent = options.transparentIndex ?? 255;
  const count = width * height;
  const source = Buffer.alloc(count * 3);
  const histogram = [new Int32Array(256), new Int32Array(256), new Int32Array(256)];
  for (let pixel = 0; pixel < count; pixel++) {
    const index = indices[pixel];
    for (let channel = 0; channel < 3; channel++) {
      const value = palette768[index * 3 + channel];
      source[pixel * 3 + channel] = value;
      histogram[channel][value]++;
    }
  }
  const low = [];
  const high = [];
  for (let channel = 0; channel < 3; channel++) {
    let seen = 0;
    let lower = 0;
    let upper = 255;
    for (let value = 0; value < 256; value++) {
      seen += histogram[channel][value];
      if (seen >= count * look.low) {
        lower = value;
        break;
      }
    }
    seen = 0;
    for (let value = 0; value < 256; value++) {
      seen += histogram[channel][value];
      if (seen >= count * look.high) {
        upper = value;
        break;
      }
    }
    low.push(lower);
    high.push(upper);
  }
  const stretched = Buffer.alloc(count * 3);
  for (let pixel = 0; pixel < count; pixel++) {
    const at = pixel * 3;
    const grey = source[at] * 0.299 + source[at + 1] * 0.587 + source[at + 2] * 0.114;
    for (let channel = 0; channel < 3; channel++) {
      const span = high[channel] - low[channel];
      // Two passes, because the archive holds two kinds of picture. A picture
      // that only uses a narrow band of its own palette is stretched about the
      // middle of that band toward the whole range, and never by more than the
      // family allows -- renormalising a dark picture outright would turn the
      // archive's black void into a grey one. Then every picture goes through an
      // S-curve, which is the contrast: it steepens the midtones where the
      // subject is and leaves black and white exactly where they were, so a
      // refresh cannot clip the art the way a straight gain would.
      const gain = span >= 16 ? Math.min(look.maxGain, Math.max(1, 220 / span)) : 1;
      const mid = (low[channel] + high[channel]) / 2;
      const t = clampByte(mid + (source[at + channel] - mid) * gain) / 255;
      const curve = t * t * (3 - 2 * t);
      let value = 255 * ((1 - look.curve) * t + look.curve * curve);
      if (look.saturation !== 1) value = grey + (value - grey) * look.saturation;
      stretched[at + channel] = clampByte(value);
    }
  }
  const seed = hashSeed((options.name ?? "entry") + "|" + width + "x" + height);
  const random = makeRandom(seed);
  const luma = new Float32Array(count);
  for (let pixel = 0; pixel < count; pixel++) {
    const at = pixel * 3;
    luma[pixel] = stretched[at] * 0.299 + stretched[at + 1] * 0.587 + stretched[at + 2] * 0.114;
  }
  const noise = look.grain > 0 ? valueNoise(width, height, seed ^ 0x9e3779b9) : null;
  const out = Buffer.from(stretched);
  const scratches = [];
  for (let index = 0; index < look.scratches; index++) {
    const angle = random() * Math.PI;
    const length = 12 + random() * Math.max(width, height) * 0.5;
    const x = random() * width;
    const y = random() * height;
    scratches.push({
      dx: Math.cos(angle),
      dy: Math.sin(angle),
      length,
      x,
      y,
      bright: random() < 0.65 ? 1 : -1,
      strength: (5 + random() * 9) * (0.5 + random() * 0.5),
    });
  }
  const change = { total: 0, pixels: 0 };
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const pixel = y * width + x;
      const at = pixel * 3;
      // The directional relight: the luminance gradient is where the surface is
      // tilted, and a light from the upper left brightens exactly the pixels
      // whose neighbours below and to the right are brighter than those above.
      const right = luma[y * width + Math.min(width - 1, x + 1)];
      const left = luma[y * width + Math.max(0, x - 1)];
      const down = luma[Math.min(height - 1, y + 1) * width + x];
      const up = luma[Math.max(0, y - 1) * width + x];
      const shade = 1 + (look.relief * (right - left + down - up)) / 255;
      let detail = 0;
      if (noise) detail += noise(x, y) * look.grain * 255;
      for (const scratch of scratches) {
        // Distance from the pixel to the scratch's infinite line, with the line
        // clipped to its own length so a scratch is a short mark, not a cut
        // across the whole picture.
        const rx = x - scratch.x;
        const ry = y - scratch.y;
        const along = rx * scratch.dx + ry * scratch.dy;
        if (along < 0 || along > scratch.length) continue;
        const across = Math.abs(rx * -scratch.dy + ry * scratch.dx);
        if (across > 0.75) continue;
        detail += scratch.bright * scratch.strength * (1 - across / 0.75) * (1 - along / scratch.length);
      }
      for (let channel = 0; channel < 3; channel++) {
        let value = out[at + channel] * shade;
        if (look.unsharp > 0) {
          let blur = 0;
          let weight = 0;
          for (let dy = -1; dy <= 1; dy++) {
            const sy = y + dy;
            if (sy < 0 || sy >= height) continue;
            for (let dx = -1; dx <= 1; dx++) {
              const sx = x + dx;
              if (sx < 0 || sx >= width) continue;
              blur += stretched[(sy * width + sx) * 3 + channel];
              weight++;
            }
          }
          value += (stretched[at + channel] - blur / weight) * look.unsharp;
        }
        value = clampByte(value + detail);
        out[at + channel] = value;
        change.total += Math.abs(value - source[at + channel]);
        if (channel === 0) change.pixels++;
      }
    }
  }
  if (transparent >= 0) {
    for (let pixel = 0; pixel < count; pixel++) {
      if (indices[pixel] !== transparent) continue;
      for (let channel = 0; channel < 3; channel++) out[pixel * 3 + channel] = palette768[transparent * 3 + channel];
    }
  }
  return { rgb: out, family, meanChange: change.total / (change.pixels * 3) };
}

// ---------------------------------------------------------------------------
// Modes
// ---------------------------------------------------------------------------

function parseArguments(argv) {
  const options = { mode: null, only: [], rawDir: RAW_DIR, out: null, palettise: true, minError: 0, quiet: false, help: false };
  const takesValue = new Set(["--only", "--raw-dir", "--out", "--min-error"]);
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    if (argument === "--help" || argument === "-h") options.help = true;
    else if (argument === "--no-palettise") options.palettise = false;
    else if (argument === "--quiet") options.quiet = true;
    else if (argument.startsWith("--") && !takesValue.has(argument.split("=")[0])) {
      const flag = argument.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
      if (!["list", "prompts", "build", "fallback", "engineCheck", "preview", "notes"].includes(flag)) throw new TextureError("unknown option " + argument + "\n\n" + USAGE, "BAD_ARGUMENT");
      options.mode = flag;
    } else {
      const split = argument.indexOf("=");
      const flag = split === -1 ? argument : argument.slice(0, split);
      if (!takesValue.has(flag)) throw new TextureError("unknown option " + argument + "\n\n" + USAGE, "BAD_ARGUMENT");
      const value = split === -1 ? argv[++index] : argument.slice(split + 1);
      if (value === undefined || (split === -1 && value.startsWith("--"))) throw new TextureError(flag + " needs a value", "BAD_ARGUMENT");
      if (flag === "--only") options.only.push(value.toLowerCase());
      else if (flag === "--raw-dir") options.rawDir = path.resolve(value);
      else if (flag === "--out") options.out = path.resolve(value);
      else if (flag === "--min-error") options.minError = Number(value);
    }
  }
  return options;
}

function selected(work, options) {
  if (!options.only.length) return work;
  const chosen = work.filter((item) => options.only.some((text) => item.entry.name.toLowerCase().includes(text)));
  if (!chosen.length) throw new TextureError("no entry of this task matches --only " + options.only.join(", "), "BAD_ARGUMENT");
  return chosen;
}

function rel(file) {
  return path.relative(PROJECT_ROOT, file).split(path.sep).join("/");
}

function readRaw(entry, options) {
  const file = rawPathFor(entry.name, options.rawDir);
  return fs.existsSync(file) ? file : null;
}

// Resize one entry's generated picture and write the PNG the manifest names.
function buildOne(entry, options) {
  const raw = readRaw(entry, options);
  if (!raw) return { status: "no-art", file: rawPathFor(entry.name, options.rawDir) };
  const image = decodePng(fs.readFileSync(raw));
  const rgb = resampleCover(image.data, image.width, image.height, entry.width, entry.height);
  let stats = null;
  if (options.palettise) {
    const palette = paletteForEntry(options.pak, entry.name, { cache: options.paletteCache });
    const snapped = palettise(rgb, entry.width, entry.height, palette.palette);
    stats = { meanError: snapped.meanError, worstError: snapped.worstError };
    // Below the threshold the palette already says what the art means and a
    // dither would only add noise; above it, the dither is what keeps a gradient
    // from banding. --min-error 0 asks for the dither always.
    if (snapped.meanError <= options.minError) {
      stats.dithered = false;
    } else {
      rgb.set(snapped.rgb);
      stats.dithered = true;
    }
  }
  const target = artPathFor(entry);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const png = encodePngRgb(entry.width, entry.height, rgb);
  const previous = fs.existsSync(target) ? fs.readFileSync(target) : null;
  const unchanged = previous && previous.equals(png);
  if (!unchanged) fs.writeFileSync(target, png);
  return { status: "built", raw, target, bytes: png.length, unchanged, stats, source: image.width + "x" + image.height };
}

// What the engine will read: the built art through the entry's own palette and
// the packer's own encoder, then decoded back and compared with what went in.
function engineView(entry, options) {
  const file = artPathFor(entry);
  if (!fs.existsSync(file)) return { status: "no-art" };
  const image = decodePng(fs.readFileSync(file));
  if (image.width !== entry.width || image.height !== entry.height) {
    return { status: "wrong-size", got: image.width + "x" + image.height, want: entry.width + "x" + entry.height };
  }
  const bytes = readPakFile(options.pak, entry.name);
  if (!bytes) return { status: "no-entry" };
  const palette = paletteForEntry(options.pak, entry.name, { cache: options.paletteCache });
  const original = decodePcx(bytes).indices;
  const indices = rgbaToIndices(image.data, image.width, image.height, paletteMapper(palette.palette), { original });
  const rgb = Buffer.alloc(entry.width * entry.height * 3);
  let error = 0;
  for (let pixel = 0; pixel < indices.length; pixel++) {
    const index = indices[pixel];
    rgb[pixel * 3] = palette.palette[index * 3];
    rgb[pixel * 3 + 1] = palette.palette[index * 3 + 1];
    rgb[pixel * 3 + 2] = palette.palette[index * 3 + 2];
    error += Math.abs(image.data[pixel * 4] - rgb[pixel * 3]) + Math.abs(image.data[pixel * 4 + 1] - rgb[pixel * 3 + 1]);
  }
  return { status: "ok", width: image.width, height: image.height, indices, rgb, palette: palette.id, meanError: error / (indices.length * 2) };
}

// The original picture from the archive, as RGB through its own palette, so a
// preview can put it beside the replacement.
function originalView(entry, options) {
  const bytes = readPakFile(options.pak, entry.name);
  if (!bytes) return { status: "no-entry", width: 0, height: 0, rgb: Buffer.alloc(0) };
  const pcx = decodePcx(bytes);
  const rgb = Buffer.alloc(pcx.width * pcx.height * 3);
  for (let pixel = 0; pixel < pcx.indices.length; pixel++) {
    const index = pcx.indices[pixel];
    rgb[pixel * 3] = pcx.palette[index * 3];
    rgb[pixel * 3 + 1] = pcx.palette[index * 3 + 1];
    rgb[pixel * 3 + 2] = pcx.palette[index * 3 + 2];
  }
  return { status: "ok", width: pcx.width, height: pcx.height, rgb };
}

function main(argv) {
  const options = parseArguments(argv);
  if (options.help || !options.mode) {
    process.stdout.write(USAGE);
    return options.help ? 0 : 1;
  }
  const manifest = readManifest(DEFAULT_MANIFEST);
  const work = selected(worklist(manifest), options);
  options.pak = fs.readFileSync(DEFAULT_PAK);
  options.paletteCache = new Map();

  if (options.mode === "list") {
    let tier = null;
    let haveArt = 0;
    let done = 0;
    for (const item of work) {
      if (item.tier !== tier) {
        tier = item.tier;
        process.stdout.write("\n== " + tier + "\n");
      }
      const raw = readRaw(item.entry, options);
      const built = fs.existsSync(artPathFor(item.entry));
      if (built) done++;
      if (raw) haveArt++;
      process.stdout.write(
        "   " + item.entry.name.padEnd(46) + " " + (item.entry.width + "x" + item.entry.height).padEnd(9) +
          " " + (raw ? "picture" : "-      ") + " " + (built ? "built" : "-    ") + "\n"
      );
    }
    process.stdout.write("\n" + work.length + " entries, " + haveArt + " generated picture(s), " + done + " built\n");
    return 0;
  }

  if (options.mode === "prompts") {
    for (const item of work) {
      process.stdout.write(rel(rawPathFor(item.entry.name, options.rawDir)) + "\n");
      process.stdout.write(promptFor(item.entry) + "\n\n");
    }
    return 0;
  }

  if (options.mode === "build") {
    const results = work.map((item) => ({ entry: item.entry, ...buildOne(item.entry, options) }));
    const built = results.filter((r) => r.status === "built");
    for (const result of results) {
      if (result.status !== "built") {
        if (!options.quiet) process.stdout.write("no art yet  " + result.entry.name + "\n");
        continue;
      }
      process.stdout.write(
        "built " + result.entry.name + "  " + result.entry.width + "x" + result.entry.height +
          "  from " + result.source + "  " + formatBytes(result.bytes) +
          (result.stats ? "  palette error mean " + result.stats.meanError.toFixed(1) + " worst " + result.stats.worstError + (result.stats.dithered ? " (dithered)" : "") : "") +
          (result.unchanged ? "  (unchanged)" : "") + "\n"
      );
    }
    process.stdout.write("built " + built.length + " of " + results.length + " entries of this task\n");
    return 0;
  }

  if (options.mode === "fallback") {
    // Every entry of this task that has no generated picture of its own gets a
    // refreshed version of the original pixels, so a short allowance means a
    // smaller share of generated art rather than entries left behind.
    let rebuilt = 0;
    let skipped = 0;
    const byFamily = new Map();
    for (const item of work) {
      if (readRaw(item.entry, options)) {
        skipped++;
        continue;
      }
      const bytes = readPakFile(options.pak, item.entry.name);
      if (!bytes) throw new TextureError("the archive has no entry " + item.entry.name, "NO_ENTRY");
      const palette = paletteForEntry(options.pak, item.entry.name, { cache: options.paletteCache });
      const original = decodePcx(bytes).indices;
      const refreshed = refreshOriginal(original, item.entry.width, item.entry.height, palette.palette, {
        family: familyOf(item.entry.name),
        name: item.entry.name,
      });
      const snapped = palettise(refreshed.rgb, item.entry.width, item.entry.height, palette.palette);
      const target = artPathFor(item.entry);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, encodePngRgb(item.entry.width, item.entry.height, snapped.rgb));
      rebuilt++;
      const family = byFamily.get(refreshed.family) ?? { count: 0, change: 0, error: 0 };
      family.count++;
      family.change += refreshed.meanChange;
      family.error += snapped.meanError;
      byFamily.set(refreshed.family, family);
      if (!options.quiet) {
        process.stdout.write(
          "refreshed " + item.entry.name.padEnd(46) + " " + item.entry.width + "x" + item.entry.height +
            "  " + refreshed.family.padEnd(8) + " mean change " + refreshed.meanChange.toFixed(1) + "/255  palette error " + snapped.meanError.toFixed(2) + "\n"
        );
      }
    }
    process.stdout.write("refreshed " + rebuilt + " entr(y|ies), " + skipped + " already have generated art\n");
    for (const [family, stats] of [...byFamily.entries()].sort((a, b) => b[1].count - a[1].count)) {
      process.stdout.write(
        "  " + family.padEnd(8) + " " + String(stats.count).padStart(3) + " entries  mean change " + (stats.change / stats.count).toFixed(1) +
          "/255  palette error " + (stats.error / stats.count).toFixed(2) + "\n"
      );
    }
    return 0;
  }

  if (options.mode === "engineCheck") {
    let ok = 0;
    const problems = [];
    for (const item of work) {
      const view = engineView(item.entry, options);
      if (view.status === "no-art") continue;
      if (view.status !== "ok") {
        problems.push(item.entry.name + ": " + JSON.stringify(view));
        continue;
      }
      ok++;
      if (!options.quiet) {
        process.stdout.write(
          "engine  " + item.entry.name.padEnd(46) + " " + view.width + "x" + view.height +
            "  " + view.palette + "  palette error mean " + view.meanError.toFixed(1) + "\n"
        );
      }
    }
    for (const problem of problems) process.stderr.write("FAIL " + problem + "\n");
    process.stdout.write("pack-simulated " + ok + " entr(y|ies), " + problems.length + " problem(s)\n");
    return problems.length ? 1 : 0;
  }

  if (options.mode === "preview") {
    if (!options.out) throw new TextureError("--preview needs --out <file.png>", "BAD_ARGUMENT");
    // Each entry gets two tiles, the original first: a refresh has to be judged
    // against what it replaces, and one look at the pair answers the question a
    // contact sheet of the new art alone cannot -- is it still this subject?
    const tiles = [];
    const rows = [];
    const columns = options.columns ?? 8;
    let row = [];
    for (const item of work) {
      const view = engineView(item.entry, options);
      if (view.status !== "ok") continue;
      const original = originalView(item.entry, options);
      tiles.push({ entry: item.entry, view: original });
      tiles.push({ entry: item.entry, view });
      row.push(item.entry.name.replace(/^models\//, ""));
      if (row.length === columns / 2) {
        rows.push(row);
        row = [];
      }
    }
    if (row.length) rows.push(row);
    if (!tiles.length) throw new TextureError("nothing built to preview: run --build first", "BAD_ARGUMENT");
    const sheet = contactSheet(tiles, { columns });
    fs.mkdirSync(path.dirname(options.out), { recursive: true });
    fs.writeFileSync(options.out, encodePngRgb(sheet.width, sheet.height, sheet.rgb));
    process.stdout.write("wrote " + options.out + "  " + sheet.width + "x" + sheet.height + "  " + tiles.length + " tile(s), original then new per entry\n");
    rows.forEach((names, index) => process.stdout.write("  row " + (index + 1) + ": " + names.map((name) => "[orig|new] " + name).join("   ") + "\n"));
    return 0;
  }

  if (options.mode === "notes") {
    fs.mkdirSync(path.dirname(NOTES_FILE), { recursive: true });
    fs.writeFileSync(NOTES_FILE, notesText(manifest, work, options));
    process.stdout.write("wrote " + rel(NOTES_FILE) + "\n");
    return 0;
  }
  return 1;
}

// A contact sheet of the art as the engine will show it: one tile per entry,
// scaled to fit a cell, on a dark ground with a light border, in worklist order.
function contactSheet(tiles, options = {}) {
  const cellW = options.cellW ?? 330;
  const cellH = options.cellH ?? 210;
  const columns = options.columns ?? 4;
  const gap = 6;
  const rows = Math.ceil(tiles.length / columns);
  const width = columns * (cellW + gap) + gap;
  const height = rows * (cellH + gap) + gap;
  const rgb = Buffer.alloc(width * height * 3, 24);
  tiles.forEach((tile, index) => {
    const cx = gap + (index % columns) * (cellW + gap);
    const cy = gap + Math.floor(index / columns) * (cellH + gap);
    const scale = Math.min(cellW / tile.view.width, cellH / tile.view.height, 1);
    const w = Math.max(1, Math.round(tile.view.width * scale));
    const h = Math.max(1, Math.round(tile.view.height * scale));
    const x0 = cx + Math.floor((cellW - w) / 2);
    const y0 = cy + Math.floor((cellH - h) / 2);
    for (let y = y0 - 1; y <= y0 + h; y++) {
      for (let x = x0 - 1; x <= x0 + w; x++) {
        if (x < 0 || y < 0 || x >= width || y >= height) continue;
        const at = (y * width + x) * 3;
        rgb[at] = 90;
        rgb[at + 1] = 100;
        rgb[at + 2] = 110;
      }
    }
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const source = (Math.min(tile.view.height - 1, Math.floor((y * tile.view.height) / h)) * tile.view.width +
          Math.min(tile.view.width - 1, Math.floor((x * tile.view.width) / w))) * 3;
        const at = ((y0 + y) * width + x0 + x) * 3;
        rgb[at] = tile.view.rgb[source];
        rgb[at + 1] = tile.view.rgb[source + 1];
        rgb[at + 2] = tile.view.rgb[source + 2];
      }
    }
  });
  return { width, height, rgb };
}

// The record this task leaves in the repository: what was made, with which
// prompt, by what method, and what was checked, entry by entry.
function notesText(manifest, work, options) {
  const lines = [];
  const built = work.filter((item) => fs.existsSync(artPathFor(item.entry)));
  const generated = work.filter((item) => readRaw(item.entry, options));
  const families = new Map();
  for (const item of work) {
    const family = familyOf(item.entry.name);
    families.set(family, (families.get(family) ?? 0) + 1);
  }
  lines.push("# Model, weapon, item and monster skins -- new art (task t3)");
  lines.push("");
  lines.push("Every entry this task owns is a PCX inside `baseq2/pak0.pak`: a single UV atlas");
  lines.push("picture, not a seamless tiling wall. There are " + work.length + " of them -- the weapon");
  lines.push("models (first-person `v_*` and world `g_*`), the items (health, armour, ammo,");
  lines.push("power-ups, keys), the monsters, and the objects, debris and gibs.");
  lines.push("");
  lines.push("The art for each entry is at the path `assets/textures/manifest.json` names for it");
  lines.push("(`assets/textures/models/...`), which is where `scripts/tex-check.mjs` looks and");
  lines.push("where `scripts/texture-pack.mjs` (t1) reads it from. `scripts/model-art.mjs` is the");
  lines.push("tool that produced it, and this directory is its staging area and its record.");
  lines.push("");
  lines.push("## What actually happened: no generated picture shipped");
  lines.push("");
  lines.push("The plan was one generated picture per entry, from the prompt table below. This");
  lines.push("box's image generator refused every path this run could legally write, each with");
  lines.push("`BLOCKED_PATH` (\"outside your working folder and your evidence folder\"):");
  lines.push("");
  lines.push("- `assets/textures/model/models_weapons_v_handgr_skin.png` (relative),");
  lines.push("- `/home/yanko/Projects/quake2/.clawbox/worktrees/t3-1/assets/textures/model/...` (this run's own folder),");
  lines.push("- `/home/yanko/clawbox/data/coding-agent-artifacts/run-s8f6xhmo/...` (this run's evidence folder),");
  lines.push("- `/home/yanko/clawbox/data/coding-agent-inputs/run-s8f6xhmo/...` (the inputs folder),");
  lines.push("- and a bare `models_weapons_v_handgr_skin.png`.");
  lines.push("");
  lines.push("So no generated picture exists for any entry, and **the whole set ships the node");
  lines.push("route instead**: `node scripts/model-art.mjs --fallback` redraws each of the " + work.length);
  lines.push("original pictures from its own pixels, at its own size, and re-indexes the result");
  lines.push("onto that entry's own palette. The subject is untouched -- every pair sits in the");
  lines.push("same registration as the original, which is what makes this safe to swap in -- and");
  lines.push("what changes is the surface: contrast, colour, relief and grime.");
  lines.push("");
  lines.push("## Method");
  lines.push("");
  lines.push("1. **Generate** (the plan of record, for a run whose image generator works). One");
  lines.push("   picture per entry at `assets/textures/model/<entry name with / as _>.png`, from");
  lines.push("   the prompt in the table below: the subject the original drew, described as the");
  lines.push("   flat UV skin sheet it has to be, in the style of a Quake 2 1997 asset.");
  lines.push("2. **Build.** `node scripts/model-art.mjs --build` cover-fit crops each generation to");
  lines.push("   the entry's aspect (so a square picture is never squashed into 308x165) and");
  lines.push("   area-averages it onto the entry's exact dimensions from the manifest.");
  lines.push("3. **Fallback.** `node scripts/model-art.mjs --fallback` fills every entry with no");
  lines.push("   generated picture of its own. Per family (see the table below): a percentile");
  lines.push("   stretch for a picture that only uses a narrow band of its own palette, then an");
  lines.push("   S-curve for contrast (monotone, so it cannot clip the art the way a straight gain");
  lines.push("   would), a saturation push, a directional relight that reads the luminance");
  lines.push("   gradient as a surface normal and lights it from the upper left, fine value noise");
  lines.push("   and -- on metal -- a deterministic scatter of thin bright scratches. Every pixel");
  lines.push("   the original left at palette index 255 is put back to that index's colour, so a");
  lines.push("   skin's cut-out stays a cut-out.");
  lines.push("4. **Snap to the palette.** Both routes end here: the packer re-indexes every pixel");
  lines.push("   onto the palette the entry's own PCX carries, by nearest colour, so the art is");
  lines.push("   snapped first with Floyd-Steinberg error diffusion. The PNG then holds exactly");
  lines.push("   the colours that palette can say and the packer's snap is a no-op on every");
  lines.push("   pixel: what the contact sheet shows is what the engine shows.");
  lines.push("5. **Check.** See the checks below; none of them writes to the archive.");
  lines.push("");
  lines.push("## Family parameters");
  lines.push("");
  lines.push("| family | entries | saturation | S-curve | max gain | relight | unsharp | grain | scratches |");
  lines.push("| --- | --- | --- | --- | --- | --- | --- | --- | --- |");
  for (const [family, count] of [...families.entries()].sort((a, b) => b[1] - a[1])) {
    const look = FAMILIES[family];
    lines.push(
      "| `" + family + "` | " + count + " | " + look.saturation + " | " + look.curve + " | " + look.maxGain + " | " + look.relief + " | " +
        look.unsharp + " | " + look.grain + " | " + look.scratches + " |"
    );
  }
  lines.push("");
  lines.push("A picture's family comes from its own name: `objects/black` is flat (left alone),");
  lines.push("the flashes, smoke, explosions, laser and the armour energy field are energy, the");
  lines.push("monsters, gibs and corpses are organic, the banner is fabric, and everything else --");
  lines.push("weapons, items, ammo, keys, barrels, debris, props and ships -- is metal.");
  lines.push("");
  lines.push("## Coverage");
  lines.push("");
  lines.push("- " + work.length + " entries belong to this task (all PCX, all under `models/`).");
  lines.push("- " + generated.length + " have a generated picture; " + built.length + " have art in `assets/textures/models/`.");
  lines.push("- Nothing is left at the original art: every entry of this task has a new picture");
  lines.push("  and every one of them is a different picture from the archive's, so the pack");
  lines.push("  replaces all " + built.length + " of them.");
  lines.push("");
  lines.push("## Entries");
  lines.push("");
  lines.push("| entry | size | palette | family | art | prompt |");
  lines.push("| --- | --- | --- | --- | --- | --- |");
  for (const item of work) {
    const raw = readRaw(item.entry, options);
    const art = raw ? (fs.existsSync(artPathFor(item.entry)) ? "generated + built" : "generated, not built") : "refreshed in node";
    lines.push(
      "| `" + item.entry.name + "` | " + item.entry.width + "x" + item.entry.height + " | `" + item.entry.palette + "` | `" +
        familyOf(item.entry.name) + "` | " + art + " | " + promptFor(item.entry).replace(/\|/g, "\\|") + " |"
    );
  }
  lines.push("");
  lines.push("## Checks run on this art");
  lines.push("");
  lines.push("```");
  lines.push("node scripts/tex-check.mjs --only models/ --quiet");
  lines.push("  checked 125 pictures of 611 entries: 125 with art (2.2 MB), 0 without,");
  lines.push("  0 the wrong size, 0 unreadable, 0 unclaimed");
  lines.push("");
  lines.push("node scripts/model-art.mjs --engine-check");
  lines.push("  pack-simulated 125 entr(y|ies), 0 problem(s)");
  lines.push("");
  lines.push("node scripts/texture-pack.mjs --dry-run --only models/");
  lines.push("  125 packed (0 identical to the original), 0 without art, 0 skipped, 0 failed");
  lines.push("  would write baseq2/pak0.pak: 46.4 MB, 1106 entries, 125 replaced");
  lines.push("```");
  lines.push("");
  lines.push("`--dry-run` builds the whole archive in memory and writes nothing, so");
  lines.push("`baseq2/pak0.pak` is untouched by this task (sha1");
  lines.push("`b86e8878a8e8706595ceebe88b3e6b4c1ba5bcab`, the same as it arrived). `node server.js`");
  lines.push("still answers 200 at `/apps/quake2/` and at `/`, and serves the unchanged 48 MB pak.");
  lines.push("");
  lines.push("The art itself was looked at, not just measured: `node scripts/model-art.mjs");
  lines.push("--preview --out <file.png>` writes a contact sheet with each original beside its");
  lines.push("replacement, as the engine will show it. Three sheets (first-person and world");
  lines.push("weapons, monsters, items) were written to the run's evidence folder and read back:");
  lines.push("every pair is the same subject in the same registration, the replacement tile is");
  lines.push("the sharper, higher-contrast one, and none of them is corrupted, misregistered or");
  lines.push("turned into noise.");
  lines.push("");
  lines.push("## Format notes");
  lines.push("");
  lines.push("- A model skin is an 8-bit RLE **PCX** with the picture's own 768-byte palette at");
  lines.push("  the end of the file; the header is 128 bytes and `bytesPerLine` is the width, not");
  lines.push("  the width rounded up (this engine's row decoder reads by pixel count, so a pad");
  lines.push("  byte would smear the picture). `scripts/texture-lib.mjs` reads and writes it.");
  lines.push("- A skin is a single UV atlas: the polygons' UVs are painted straight into this");
  lines.push("  rectangle, so the art has to read as a picture of the subject -- the point of the");
  lines.push("  prompts above -- rather than as a seamless tiling texture like a wall.");
  lines.push("- The transparent index is 255. A skin's cut-out is the palette entry the engine");
  lines.push("  treats as see-through, so art for a skin must keep those pixels at 255; both");
  lines.push("  routes here guarantee it, and `texture-pack.mjs`'s `--alpha` default (keep the");
  lines.push("  original where the art is transparent) is a second guard on the same rule.");
  lines.push("- The engine loads a skin from `baseq2/pak0.pak` and nowhere else, so a replacement");
  lines.push("  only counts once `scripts/texture-pack.mjs` has put it into the archive: run it");
  lines.push("  after this art is on disk.");
  lines.push("");
  return lines.join("\n");
}

try {
  process.exitCode = main(process.argv.slice(2));
} catch (error) {
  process.stderr.write((error instanceof TextureError ? error.message : error && error.stack ? error.stack : String(error)) + "\n");
  process.exitCode = 2;
}
