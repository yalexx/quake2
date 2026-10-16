// scripts/texture-lib.mjs -- read and write the image formats this app's Quake 2
// archive is built from, so new art can be put where the engine actually reads it.
//
// Six separate jobs want to replace textures in baseq2/pak0.pak. They all need the
// same three things to be true, and this module is where that is decided once:
//
//   1. the archive is rewritten without disturbing a single byte of the files that
//      were not replaced (writePak);
//   2. a generated PNG becomes the exact paletted bytes the engine wants -- a
//      Quake 2 WAL for a wall, an 8-bit PCX for a picture or a sprite frame
//      (encodeWal, encodePcx8);
//   3. the indices an artist's RGB art is reduced to come from the palette the
//      engine will actually use for that image, never an invented one
//      (paletteMapper, globalPalette, nearestPalette).
//
// Zero dependencies, no build step: node's own fs, path, zlib and crypto, and
// nothing else. zlib.inflateSync is the whole of the PNG decoder.
//
// The formats, as measured on this archive (49,951,322 bytes, 1106 entries):
//
//   PAK  a flat archive. "PACK", u32 directory offset, u32 directory length,
//        then the files back to back from byte 12, then a directory of fixed
//        64-byte entries: name[56] (NUL padded), u32 offset, u32 size, both
//        absolute in the archive. In this file every entry is packed with no gap
//        and the directory begins exactly where the last file ends, which is why
//        an unchanged rewrite is byte-identical.
//
//   WAL  a paletted wall texture. 100-byte header -- name[32], u32 width,
//        u32 height, u32 mip offsets[4], animname[32], i32 flags, i32 contents,
//        i32 value -- then four 8-bit mip levels, each one half the last in both
//        directions (floor, minimum 1), then nothing. offset[0] is 100 and the
//        offsets are absolute from the start of the entry; the mip chain runs to
//        the end of the entry, so there is NO palette in a Quake 2 WAL. All 303
//        of them here follow that arithmetic exactly, which is what makes an
//        unchanged re-encode the same length as the original.
//
//   PCX  128-byte header, 8 bits per pixel, one plane, RLE, then 0x0c and 768
//        bytes of palette at the end of the file. All 300 here are that shape,
//        and every one of them writes its own width as bytesPerLine -- 101 for a
//        101-wide picture -- so the row length in this archive is never padded.
//        That matters, because the Quake 2 re-release loader this app runs
//        (PCX_Decode in the renderer module) decodes a row by pixel count and not
//        by bytesPerLine, so a pad byte would be read as the first pixel of the
//        next row and would smear the picture one pixel to the left per row. The
//        encoder therefore writes the width as the row length, which is even for
//        every even-width picture and identical to what the file it replaces
//        already does; options.padRows writes the format's even padded row
//        instead, for a caller who has checked their loader honours it.
//
//   SP2  a Quake 2 sprite: "IDS2", i32 version, i32 numframes, then 80 bytes per
//        frame -- i32 width, i32 height, i32 origin_x, i32 origin_y, name[64].
//        The frame's `name` is another entry in the archive (all eight sprites
//        here name sprites/*.pcx files), so a sprite's pixels are replaced by
//        replacing those PCX entries and the SP2 itself need not change.
//
// WHICH PALETTE. A Quake 2 WAL carries no palette of its own: the engine loads
// one global palette and every paletted wall texture is indexed into it. That
// palette is the 768 bytes at the end of pics/colormap.pcx, and globalPalette()
// reads it out of the archive rather than shipping a copy. A PCX carries its own
// palette at its end, and paletteForEntry() returns whichever of the two applies.
// Re-indexing generated art onto anything else would render a wall in the wrong
// colours, so every entry in the manifest names the palette it must use.
//
// BSP TEXTURES. A Quake 2 BSP has no texture lump -- the names live in the
// texinfo lump (lump 5, 76 bytes each: float vecs[2][4], i32 flags, i32 value,
// char texture[32], i32 nexttexinfo), and every face (lump 6, 20 bytes, u16
// texinfo at offset 10) points at one of them. The engine turns the name into
// "textures/" + texture + ".wal", so bspTextureUsage() reports, per name, how
// many faces use it -- the count that says which texture is worth re-drawing
// first. maps/demo1.bsp has 631 texinfos, 7905 faces and 108 distinct names,
// every one of which resolves to a WAL in the archive.
//
//   import { readPakDirectory, decodePng, encodeWal, globalPalette } from "./texture-lib.mjs";
//
// Two command line tools sit on top of this module: texture-pack.mjs (art ->
// archive) and tex-check.mjs (art -> dimensions). See their headers.

import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));

// Where this project keeps things. Everything else takes these as defaults so a
// tool run from anywhere in the checkout still means the same files.
export const PROJECT_ROOT = path.join(HERE, "..");
export const DEFAULT_PAK = path.join(PROJECT_ROOT, "baseq2", "pak0.pak");
export const DEFAULT_ART_DIR = path.join(PROJECT_ROOT, "assets", "textures");
export const DEFAULT_MANIFEST = path.join(DEFAULT_ART_DIR, "manifest.json");
export const MANIFEST_SCHEMA = 1;

// The one global palette, and the id every WAL in the manifest points at.
export const GLOBAL_PALETTE_ENTRY = "pics/colormap.pcx";
export const GLOBAL_PALETTE_ID = "q2:global";

// Fixed sizes, from qfiles.h and the file formats themselves.
export const PAK_ENTRY_BYTES = 64; // char name[56], int offset, int length
export const PAK_NAME_BYTES = 56;
export const PAK_HEADER_BYTES = 12; // "PACK", u32 diroff, u32 dirlen
export const WAL_HEADER_BYTES = 100;
export const WAL_NAME_BYTES = 32;
export const WAL_MIP_LEVELS = 4; // offsets[4] is all the header has room for
export const PCX_HEADER_BYTES = 128;
export const PALETTE_BYTES = 768;
export const SP2_HEADER_BYTES = 12;
export const SP2_FRAME_BYTES = 80; // w, h, origin_x, origin_y, name[64]
export const SP2_NAME_BYTES = 64;

const BSP_IDENT = 0x50534249; // "IBSP" little-endian
const BSP_VERSION_Q2 = 38;
const BSP_HEADER_LUMPS = 19;
const LUMP_TEXINFO = 5;
const LUMP_FACES = 6;
const TEXINFO_BYTES = 76;
const FACE_BYTES = 20;

// An error with a code, so a caller can tell "there is no such entry" from "that
// file is not what it claims to be".
export class TextureError extends Error {
  constructor(message, code = "TEXTURE_ERROR") {
    super(message);
    this.name = "TextureError";
    this.code = code;
  }
}

const sha1 = (buffer) => crypto.createHash("sha1").update(buffer).digest("hex");

// ---------------------------------------------------------------------------
// PAK: the archive
// ---------------------------------------------------------------------------

// A PAK is a flat archive: a directory of fixed-size entries at the end, each
// naming a file and where its bytes start and stop. Both offsets are absolute in
// the archive, so an entry is a slice and nothing is decompressed. The logic
// here is the same as control/route.mjs's reader, kept in step so a route can be
// planned from the same bytes an image is read from.
export function readPakDirectory(pak) {
  if (pak.length < PAK_HEADER_BYTES || pak.toString("latin1", 0, 4) !== "PACK") {
    throw new TextureError("that file is not a Quake PAK (no PACK signature)", "BAD_PAK");
  }
  const directoryOffset = pak.readUInt32LE(4);
  const directoryLength = pak.readUInt32LE(8);
  if (directoryOffset + directoryLength > pak.length || directoryLength % PAK_ENTRY_BYTES !== 0) {
    throw new TextureError(
      "the PAK directory is out of bounds (" + directoryOffset + "+" + directoryLength + " in " + pak.length + " bytes)",
      "BAD_PAK"
    );
  }
  const entries = new Map();
  for (let offset = directoryOffset; offset < directoryOffset + directoryLength; offset += PAK_ENTRY_BYTES) {
    const name = pak.toString("latin1", offset, offset + PAK_NAME_BYTES).replace(/\0.*$/, "").replace(/\\/g, "/");
    if (!name) continue;
    entries.set(name.toLowerCase(), { name, offset: pak.readUInt32LE(offset + 56), length: pak.readUInt32LE(offset + 60) });
  }
  return entries;
}

// The bytes of one file inside a PAK, or null when the archive does not hold it.
export function readPakFile(pak, wanted) {
  const entry = readPakDirectory(pak).get(normalizeName(wanted));
  if (!entry) return null;
  if (entry.offset + entry.length > pak.length) {
    throw new TextureError('the PAK entry for "' + entry.name + '" runs past the end of the archive', "BAD_PAK");
  }
  return pak.subarray(entry.offset, entry.offset + entry.length);
}

// One directory record, or null. Unlike readPakFile this hands back where the
// bytes are rather than the bytes, which is what the manifest wants.
export function pakEntry(pak, wanted) {
  const entry = readPakDirectory(pak).get(normalizeName(wanted));
  return entry ? { ...entry } : null;
}

export function normalizeName(name) {
  return String(name).toLowerCase().replace(/\\/g, "/");
}

// Read a PAK from disk, or accept one already in memory.
export function loadPak(source) {
  if (Buffer.isBuffer(source)) return source;
  if (source instanceof Uint8Array) return Buffer.from(source);
  if (typeof source === "string") {
    try {
      return fs.readFileSync(source);
    } catch (error) {
      throw new TextureError("cannot read the PAK at " + source + ": " + error.message, "NO_PAK");
    }
  }
  throw new TextureError("a PAK must be a path or a Buffer", "BAD_ARGUMENT");
}

// The archive with `replacements` swapped in.
//
// Every entry keeps its place in the directory and every entry not named in the
// map keeps its bytes exactly as they were. The files are then re-laid out in
// directory order from byte 12 -- which is where the first file already starts,
// with no gap and no padding, so a replacement map that changes nothing produces
// a byte-identical archive. New names, which the archive does not already hold,
// are appended to the directory in sorted order, so the same input always gives
// the same output.
//
//   replacements  Map<entryName, Buffer> (a plain object works too)
export function buildPak(source, replacements = new Map(), options = {}) {
  const pak = loadPak(source);
  const original = readPakDirectory(pak);
  const wanted = new Map();
  for (const [name, value] of toPairs(replacements)) {
    if (value === null || value === undefined) {
      throw new TextureError('the replacement for "' + name + '" is empty', "BAD_ARGUMENT");
    }
    const buffer = Buffer.isBuffer(value) ? value : Buffer.from(value);
    const key = normalizeName(name);
    if (wanted.has(key)) throw new TextureError('"' + name + '" is replaced twice', "BAD_ARGUMENT");
    wanted.set(key, { name: key, buffer, matched: original.has(key) });
  }
  const added = [...wanted.values()].filter((item) => !item.matched).map((item) => item.name).sort();
  for (const name of added) {
    if (Buffer.byteLength(name, "latin1") > PAK_NAME_BYTES - 1) {
      throw new TextureError('the new entry name "' + name + '" is longer than ' + (PAK_NAME_BYTES - 1) + " characters", "BAD_ARGUMENT");
    }
  }

  // Directory order: the archive's own order, with any new names after it.
  const order = [];
  for (const [key, entry] of original) order.push({ key, name: entry.name, entry });
  for (const name of added) order.push({ key: name, name, entry: null });

  const data = new Map();
  const records = [];
  let cursor = PAK_HEADER_BYTES;
  for (const item of order) {
    const replacement = wanted.get(item.key);
    const bytes = replacement ? replacement.buffer : pak.subarray(item.entry.offset, item.entry.offset + item.entry.length);
    if (!replacement && item.entry.offset + item.entry.length > pak.length) {
      throw new TextureError('the PAK entry for "' + item.name + '" runs past the end of the archive', "BAD_PAK");
    }
    records.push({ name: item.name, offset: cursor, length: bytes.length, replaced: Boolean(replacement) });
    data.set(item.name, bytes);
    cursor += bytes.length;
  }
  const directoryOffset = cursor;
  const directoryLength = records.length * PAK_ENTRY_BYTES;

  const out = Buffer.alloc(PAK_HEADER_BYTES + (directoryOffset - PAK_HEADER_BYTES) + directoryLength);
  out.write("PACK", 0, "latin1");
  out.writeUInt32LE(directoryOffset, 4);
  out.writeUInt32LE(directoryLength, 8);
  for (const record of records) {
    const bytes = data.get(record.name);
    bytes.copy(out, record.offset);
  }
  let at = directoryOffset;
  for (const record of records) {
    out.write(record.name, at, "latin1");
    at += PAK_NAME_BYTES;
    out.writeUInt32LE(record.offset, at);
    out.writeUInt32LE(record.length, at + 4);
    at += 8;
  }

  return {
    buffer: out,
    records,
    replaced: records.filter((record) => record.replaced).map((record) => record.name),
    added,
    unchanged: records.length - records.filter((record) => record.replaced).length,
  };
}

// Write the archive out, replacing whatever is at `dst` in one step: the whole
// file is written to a temporary beside it, flushed, and only then renamed over
// the target, so a reader either sees the old archive or the new one and never
// half of either. A rewrite that would not change anything is not written at all,
// which is what makes running the packer twice in a row a no-op.
//
//   writePak(src, replacements, dst, options)
//     src           path or Buffer -- the archive to read
//     replacements  Map<entryName, Buffer>
//     dst           path to write
//     options.dryRun     build the archive and report, but do not write
//     options.force      write even when the result is identical to dst
export function writePak(source, replacements = new Map(), dst, options = {}) {
  if (typeof dst !== "string" || !dst) throw new TextureError("writePak needs a destination path", "BAD_ARGUMENT");
  const built = buildPak(source, replacements, options);
  const plan = {
    path: dst,
    bytes: built.buffer.length,
    entries: built.records.length,
    replaced: built.replaced,
    added: built.added,
    unchanged: built.unchanged,
    changed: true,
    written: false,
  };
  const existing = readExisting(dst);
  if (existing && existing.length === built.buffer.length && existing.equals(built.buffer) && !options.force) {
    plan.changed = false;
    return plan;
  }
  if (options.dryRun) return plan;

  const directory = path.dirname(dst);
  if (!fs.existsSync(directory)) {
    throw new TextureError("there is no directory to write into: " + directory, "NO_DIRECTORY");
  }
  const temporary = path.join(directory, "." + path.basename(dst) + ".tmp-" + process.pid);
  const handle = fs.openSync(temporary, "w");
  try {
    let written = 0;
    while (written < built.buffer.length) written += fs.writeSync(handle, built.buffer, written, built.buffer.length - written);
    fs.fsyncSync(handle);
  } finally {
    fs.closeSync(handle);
  }
  try {
    fs.renameSync(temporary, dst);
  } catch (error) {
    try {
      fs.unlinkSync(temporary);
    } catch {
      /* the temporary is already gone; the rename error is the one that matters */
    }
    throw new TextureError("cannot replace " + dst + ": " + error.message, "NO_WRITE");
  }
  plan.written = true;
  return plan;
}

function readExisting(file) {
  try {
    return fs.readFileSync(file);
  } catch {
    return null;
  }
}

function toPairs(replacements) {
  if (replacements instanceof Map) return replacements.entries();
  if (replacements && typeof replacements === "object") return Object.entries(replacements);
  return [];
}

// ---------------------------------------------------------------------------
// PNG: what the art arrives as
// ---------------------------------------------------------------------------

// A minimal PNG reader: the eight-bit greyscale, RGB, RGBA and palette forms,
// any filter, zlib.inflateSync doing the decompression. Sixteen-bit samples are
// read at their high byte, which is what an eight-bit engine would do with them
// anyway. Returns RGBA, row-major, so the caller never has to think about the
// source's channel count or row filters. Interlaced PNGs are refused rather than
// half-decoded.
export function decodePng(buffer) {
  if (buffer.length < 8 || buffer.readUInt32BE(0) !== 0x89504e47) {
    throw new TextureError("not a PNG", "BAD_PNG");
  }
  let offset = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  let palette = null;
  let transparency = null;
  const parts = [];
  while (offset + 8 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString("latin1", offset + 4, offset + 8);
    if (offset + 12 + length > buffer.length) {
      throw new TextureError("the PNG chunk at " + offset + " runs past the end of the file", "BAD_PNG");
    }
    const data = buffer.subarray(offset + 8, offset + 8 + length);
    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
      if (data[12] !== 0) throw new TextureError("interlaced PNG is not supported", "BAD_PNG");
    } else if (type === "PLTE") {
      palette = Buffer.from(data);
    } else if (type === "tRNS") {
      transparency = Buffer.from(data);
    } else if (type === "IDAT") {
      parts.push(data);
    } else if (type === "IEND") {
      break;
    }
    offset += 12 + length;
  }
  if (!width || !height) throw new TextureError("the PNG has no header", "BAD_PNG");
  if (!parts.length) throw new TextureError("the PNG has no image data", "BAD_PNG");
  const channels = colorType === 6 ? 4 : colorType === 4 ? 2 : colorType === 2 ? 3 : colorType === 0 ? 1 : 0;
  if (!channels && colorType !== 3) {
    throw new TextureError("unsupported PNG colour type " + colorType, "BAD_PNG");
  }
  const sampleBytes = bitDepth === 16 ? 2 : 1;
  if (bitDepth !== 8 && bitDepth !== 16 && !(colorType === 3 && [1, 2, 4, 8].includes(bitDepth))) {
    throw new TextureError("unsupported PNG (colour type " + colorType + ", depth " + bitDepth + ")", "BAD_PNG");
  }
  const raw = zlib.inflateSync(Buffer.concat(parts));
  const stride = colorType === 3 ? Math.ceil((width * bitDepth) / 8) : width * channels * sampleBytes;
  const expected = height * (stride + 1);
  if (raw.length < expected) {
    throw new TextureError("the PNG image data is short (" + raw.length + " of " + expected + " bytes)", "BAD_PNG");
  }
  const plane = unfilter(raw, width, height, stride, colorType === 3 ? 1 : channels * sampleBytes);
  const rgba = Buffer.alloc(width * height * 4);
  for (let pixel = 0; pixel < width * height; pixel++) {
    const target = pixel * 4;
    if (colorType === 3) {
      const index = paletteIndex(plane, pixel, bitDepth);
      if (!palette || index * 3 + 2 >= palette.length) rgba[target + 3] = 0;
      else {
        rgba[target] = palette[index * 3];
        rgba[target + 1] = palette[index * 3 + 1];
        rgba[target + 2] = palette[index * 3 + 2];
        rgba[target + 3] = transparency && index < transparency.length ? transparency[index] : 255;
      }
      continue;
    }
    const source = pixel * channels * sampleBytes;
    // A sixteen-bit sample is read at its high byte: an eight-bit engine would
    // throw the rest away anyway, and this keeps the channel arithmetic one
    // expression for both depths.
    const high = (channel) => plane[source + channel * sampleBytes];
    // Colour type 0 is grey (one channel, repeated), 4 is grey and alpha, 2 is
    // RGB and 6 is RGBA. The loop above has already sent palette images home.
    if (channels === 1 || channels === 2) {
      const value = high(0);
      rgba[target] = value;
      rgba[target + 1] = value;
      rgba[target + 2] = value;
      rgba[target + 3] = channels === 2 ? high(1) : 255;
    } else {
      rgba[target] = high(0);
      rgba[target + 1] = high(1);
      rgba[target + 2] = high(2);
      rgba[target + 3] = channels === 4 ? high(3) : 255;
    }
  }
  return { width, height, data: rgba };
}

// The five PNG filters, undone row by row. `bytesPerPixel` is the distance to
// the pixel on the left, which for a palette image is one byte whatever the bit
// depth.
function unfilter(raw, width, height, stride, bytesPerPixel) {
  const out = Buffer.alloc(height * stride);
  let previous = Buffer.alloc(stride);
  let at = 0;
  for (let y = 0; y < height; y++) {
    const filter = raw[at++];
    const line = raw.subarray(at, at + stride);
    at += stride;
    const row = Buffer.alloc(stride);
    for (let i = 0; i < stride; i++) {
      const a = i >= bytesPerPixel ? row[i - bytesPerPixel] : 0;
      const b = previous[i];
      const c = i >= bytesPerPixel ? previous[i - bytesPerPixel] : 0;
      const x = line[i];
      let value;
      switch (filter) {
        case 0: value = x; break;
        case 1: value = x + a; break;
        case 2: value = x + b; break;
        case 3: value = x + ((a + b) >> 1); break;
        case 4: {
          const pa = Math.abs(b - c);
          const pb = Math.abs(a - c);
          const pc = Math.abs(a + b - 2 * c);
          value = x + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c);
          break;
        }
        default: throw new TextureError("unknown PNG filter " + filter + " on row " + y, "BAD_PNG");
      }
      row[i] = value & 255;
    }
    row.copy(out, y * stride);
    previous = row;
  }
  return out;
}

function paletteIndex(plane, pixel, bitDepth) {
  if (bitDepth === 8) return plane[pixel];
  if (bitDepth === 4) return (plane[pixel >> 1] >> (pixel & 1 ? 0 : 4)) & 0x0f;
  if (bitDepth === 2) return (plane[pixel >> 2] >> (6 - 2 * (pixel & 3))) & 0x03;
  return (plane[pixel >> 3] >> (7 - (pixel & 7))) & 0x01;
}

// ---------------------------------------------------------------------------
// WAL: a wall texture
// ---------------------------------------------------------------------------

// The header of a WAL, without the pixels. `name` is the texture's own name --
// "e1u1/metal2_1", no directory prefix and no extension -- which the engine uses
// for animated chains and the manifest keeps, so a replacement does not rename a
// texture the map is looking for.
export function readWal(buffer) {
  if (buffer.length < WAL_HEADER_BYTES) throw new TextureError("the WAL is shorter than its header", "BAD_WAL");
  const width = buffer.readUInt32LE(32);
  const height = buffer.readUInt32LE(36);
  if (!width || !height) throw new TextureError("the WAL has no size", "BAD_WAL");
  const offsets = [0, 1, 2, 3].map((index) => buffer.readUInt32LE(40 + index * 4));
  return {
    name: buffer.toString("latin1", 0, WAL_NAME_BYTES).replace(/\0.*$/, ""),
    width,
    height,
    offsets,
    mipLevels: offsets.filter((offset) => offset > 0).length,
    animname: buffer.toString("latin1", 56, 88).replace(/\0.*$/, ""),
    flags: buffer.readInt32LE(88),
    contents: buffer.readInt32LE(92),
    value: buffer.readInt32LE(96),
  };
}

// The mip levels, in the order the offsets point at them, with each level's size
// derived the way encodeWal lays them out: half the last, floor, minimum 1.
export function walMipSizes(width, height, levels = WAL_MIP_LEVELS) {
  const sizes = [];
  let w = width;
  let h = height;
  for (let level = 0; level < levels; level++) {
    sizes.push({ width: w, height: h, pixels: w * h });
    w = Math.max(1, w >> 1);
    h = Math.max(1, h >> 1);
  }
  return sizes;
}

// The level-zero pixels as palette indices, which is all a replacement needs to
// fall back on where the new art is transparent.
export function decodeWal(buffer) {
  const header = readWal(buffer);
  const sizes = walMipSizes(header.width, header.height, header.mipLevels || WAL_MIP_LEVELS);
  const first = header.offsets[0];
  const needed = sizes[0].pixels;
  if (first + needed > buffer.length) {
    throw new TextureError('the WAL "' + header.name + '" is shorter than its pixels', "BAD_WAL");
  }
  return {
    ...header,
    mips: sizes.map((size, level) => ({ ...size, offset: header.offsets[level] })),
    indices: Buffer.from(buffer.subarray(first, first + needed)),
  };
}

// A WAL, built from palette indices.
//
//   encodeWal(name, width, height, indices, palette768, options)
//     name        the texture's own name, at most 31 characters
//     indices     width*height palette indices into palette768
//     palette768  the palette the indices are in -- REQUIRED, and only written
//                 into the file if options.paletteAtEof asks for it (see below)
//     options.animname, options.flags, options.contents, options.value
//                 copied from the WAL being replaced, so a wall keeps the
//                 SURF_* flags, sky marker and contents the engine reads
//     options.mipLevels   how many levels to write, up to 4 (default 4)
//     options.paletteAtEof  append the 768-byte palette after the last mip
//                 (default false)
//
// On paletteAtEof: a Quake 2 WAL has no palette -- the engine indexes every
// paletted wall texture into the one global palette, and the mip chain of a WAL
// in this archive runs to the very last byte of the entry, all 303 of them. So
// the palette argument is here to make the caller state which palette the
// indices are in rather than to be stored, and appending it is off by default.
// With paletteAtEof the bytes land after the last mip, where the engine ignores
// them, for a tool that wants the archive to be self-describing.
export function encodeWal(name, width, height, indices, palette768, options = {}) {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
    throw new TextureError("a WAL needs whole, positive dimensions (got " + width + "x" + height + ")", "BAD_ARGUMENT");
  }
  if (Buffer.byteLength(String(name), "latin1") > WAL_NAME_BYTES - 1) {
    throw new TextureError('the WAL name "' + name + '" is longer than ' + (WAL_NAME_BYTES - 1) + " characters", "BAD_ARGUMENT");
  }
  const pixels = Buffer.isBuffer(indices) ? indices : Buffer.from(indices);
  if (pixels.length !== width * height) {
    throw new TextureError("a " + width + "x" + height + " WAL needs " + width * height + " indices, got " + pixels.length, "BAD_ARGUMENT");
  }
  if (palette768 !== null && palette768 !== undefined && palette768.length !== PALETTE_BYTES) {
    throw new TextureError("a palette is " + PALETTE_BYTES + " bytes, got " + palette768.length, "BAD_ARGUMENT");
  }
  const levels = Math.max(1, Math.min(WAL_MIP_LEVELS, options.mipLevels ?? WAL_MIP_LEVELS));
  const sizes = walMipSizes(width, height, levels);
  const mips = [pixels];
  for (let level = 1; level < levels; level++) mips.push(downsampleIndexed(mips[level - 1], sizes[level - 1].width, sizes[level - 1].height));

  const offsets = [0, 0, 0, 0];
  let cursor = WAL_HEADER_BYTES;
  for (let level = 0; level < levels; level++) {
    offsets[level] = cursor;
    cursor += sizes[level].pixels;
  }
  const tail = options.paletteAtEof ? PALETTE_BYTES : 0;
  const out = Buffer.alloc(cursor + tail);
  out.write(String(name), 0, "latin1");
  out.writeUInt32LE(width, 32);
  out.writeUInt32LE(height, 36);
  for (let level = 0; level < WAL_MIP_LEVELS; level++) out.writeUInt32LE(offsets[level], 40 + level * 4);
  if (options.animname) out.write(String(options.animname), 56, "latin1");
  out.writeInt32LE(options.flags ?? 0, 88);
  out.writeInt32LE(options.contents ?? 0, 92);
  out.writeInt32LE(options.value ?? 0, 96);
  let at = WAL_HEADER_BYTES;
  for (let level = 0; level < levels; level++) {
    mips[level].copy(out, at);
    at += sizes[level].pixels;
  }
  if (tail) {
    if (!palette768) throw new TextureError("paletteAtEof needs a palette", "BAD_ARGUMENT");
    Buffer.from(palette768).copy(out, at);
  }
  return out;
}

// Half of a paletted image: the top-left pixel of each 2x2 block. Averaging
// palette indices would blend two unrelated colours into a third that may be
// nothing like either, so mips of a paletted texture are point-sampled.
export function downsampleIndexed(indices, width, height) {
  const outWidth = Math.max(1, width >> 1);
  const outHeight = Math.max(1, height >> 1);
  const out = Buffer.alloc(outWidth * outHeight);
  for (let y = 0; y < outHeight; y++) {
    const sourceY = Math.min(height - 1, y * 2);
    for (let x = 0; x < outWidth; x++) {
      out[y * outWidth + x] = indices[sourceY * width + Math.min(width - 1, x * 2)];
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// PCX: a picture or a sprite frame
// ---------------------------------------------------------------------------

// The 128-byte PCX header of an eight-bit single-plane picture. Quake 2 refuses
// anything else: manufacturer 0x0a, version 5, encoding 1, eight bits per pixel,
// one plane, and no dimension of 1024 or more.
export function readPcx(buffer) {
  if (buffer.length < PCX_HEADER_BYTES) throw new TextureError("the PCX is shorter than its header", "BAD_PCX");
  if (buffer[0] !== 0x0a || buffer[1] !== 5 || buffer[2] !== 1 || buffer[3] !== 8) {
    throw new TextureError("that PCX is not an eight-bit RLE picture (manufacturer " + buffer[0] + ", version " + buffer[1] + ", encoding " + buffer[2] + ", " + buffer[3] + " bits)", "BAD_PCX");
  }
  const width = buffer.readUInt16LE(8) - buffer.readUInt16LE(4) + 1;
  const height = buffer.readUInt16LE(10) - buffer.readUInt16LE(6) + 1;
  if (width <= 0 || height <= 0) throw new TextureError("the PCX has no size", "BAD_PCX");
  return {
    width,
    height,
    bytesPerLine: buffer.readUInt16LE(66),
    planes: buffer[65],
    bitsPerPixel: buffer[3],
    palette: paletteFromPcx(buffer),
    header: Buffer.from(buffer.subarray(0, PCX_HEADER_BYTES)),
  };
}

// The 768 bytes a PCX keeps at its end, behind the 0x0c marker that says they are
// there. A PCX without the marker has no palette of its own and is refused,
// because guessing one would silently recolour the picture.
export function paletteFromPcx(buffer, name = "that PCX") {
  if (buffer.length < PCX_HEADER_BYTES + 1 + PALETTE_BYTES || buffer[buffer.length - PALETTE_BYTES - 1] !== 0x0c) {
    throw new TextureError('"' + name + '" has no palette at its end', "NO_PALETTE");
  }
  return Buffer.from(buffer.subarray(buffer.length - PALETTE_BYTES));
}

// The pixels as palette indices, read the way this app's engine reads them: a row
// is `width` pixels, whatever the header's bytesPerLine says. That is deliberate.
// A padded row decodes here exactly as badly as it would render in the game,
// instead of decoding perfectly and hiding a file the engine would smear.
export function decodePcx(buffer) {
  const header = readPcx(buffer);
  const { width, height } = header;
  const rowBytes = width;
  const indices = Buffer.alloc(width * height);
  let at = PCX_HEADER_BYTES;
  const end = buffer.length - PALETTE_BYTES - 1;
  for (let y = 0; y < height; y++) {
    let x = 0;
    while (x < rowBytes) {
      if (at >= end) throw new TextureError("the PCX runs out of data on row " + y, "BAD_PCX");
      const byte = buffer[at++];
      if ((byte & 0xc0) === 0xc0) {
        const count = byte & 0x3f;
        if (at >= end) throw new TextureError("the PCX runs out of data on row " + y, "BAD_PCX");
        const value = buffer[at++];
        for (let i = 0; i < count && x < rowBytes; i++) {
          if (x < width) indices[y * width + x] = value;
          x++;
        }
      } else {
        if (x < width) indices[y * width + x] = byte;
        x++;
      }
    }
  }
  return { ...header, indices };
}

// An eight-bit RLE PCX, built from palette indices.
//
//   encodePcx8(width, height, indices, palette768, options)
//     options.header        the 128-byte header of the PCX being replaced, so its
//                           resolution, EGA palette and palette type survive
//     options.bytesPerLine  force the row length (must be at least the width; a
//                           longer row is written with the pad the format wants)
//     options.padRows       write the format's even row -- width rounded up, with
//                           a zero pad byte -- instead of the width itself
//     options.paletteInfo   the header's palette-type word (default: the
//                           original's, or 0)
//
// The row length defaults to the width itself, not to an even number, because
// that is what every picture in the archive does and what the engine's own row
// decoder expects: a row is read by pixel count, so a pad byte would become the
// next row's first pixel. padRows is there for a loader that does honour
// bytesPerLine; it is not what this app runs.
//
// Runs never cross a row, and a byte whose top two bits are set is escaped with a
// one-byte run, so the picture survives the round trip byte for byte.
export function encodePcx8(width, height, indices, palette768, options = {}) {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
    throw new TextureError("a PCX needs whole, positive dimensions (got " + width + "x" + height + ")", "BAD_ARGUMENT");
  }
  if (width > 1024 || height > 1024) {
    throw new TextureError("Quake 2 refuses a picture " + width + "x" + height + " or larger (limit 1024)", "BAD_ARGUMENT");
  }
  const pixels = Buffer.isBuffer(indices) ? indices : Buffer.from(indices);
  if (pixels.length !== width * height) {
    throw new TextureError("a " + width + "x" + height + " PCX needs " + width * height + " indices, got " + pixels.length, "BAD_ARGUMENT");
  }
  const palette = Buffer.isBuffer(palette768) ? palette768 : Buffer.from(palette768 ?? []);
  if (palette.length !== PALETTE_BYTES) {
    throw new TextureError("a palette is " + PALETTE_BYTES + " bytes, got " + palette.length, "BAD_ARGUMENT");
  }
  const rowBytes = options.bytesPerLine ?? (options.padRows ? width + (width & 1) : width);
  if (rowBytes < width) {
    throw new TextureError("a row of " + rowBytes + " bytes cannot hold " + width + " pixels", "BAD_ARGUMENT");
  }
  const header = options.header ? Buffer.from(options.header.subarray(0, PCX_HEADER_BYTES)) : Buffer.alloc(PCX_HEADER_BYTES);
  header[0] = 0x0a;
  header[1] = 5;
  header[2] = 1;
  header[3] = 8;
  header.writeUInt16LE(0, 4);
  header.writeUInt16LE(0, 6);
  header.writeUInt16LE(width - 1, 8);
  header.writeUInt16LE(height - 1, 10);
  header[65] = 1;
  header.writeUInt16LE(rowBytes, 66);
  header.writeUInt16LE(options.paletteInfo ?? header.readUInt16LE(68), 68);
  if (!options.header) {
    header.writeUInt16LE(72, 12); // horizontal resolution, in dpi
    header.writeUInt16LE(72, 14);
  }
  const rows = [];
  for (let y = 0; y < height; y++) rows.push(encodePcxRow(pixels, y * width, width, rowBytes));
  return Buffer.concat([header, ...rows, Buffer.from([0x0c]), palette]);
}

// One row, RLE encoded, padded out to rowBytes. A run is 2..63 pixels; a lone
// pixel that happens to start with two set bits is escaped as a run of one.
function encodePcxRow(pixels, start, width, rowBytes) {
  const parts = [];
  let x = 0;
  while (x < width) {
    const value = pixels[start + x];
    let run = 1;
    while (x + run < width && pixels[start + x + run] === value && run < 63) run++;
    if (run > 1) parts.push(0xc0 | run, value);
    else if ((value & 0xc0) === 0xc0) parts.push(0xc1, value);
    else parts.push(value);
    x += run;
  }
  const pad = rowBytes - width;
  if (pad > 0) {
    if (pad === 1) parts.push(0);
    else parts.push(0xc0 | pad, 0);
  }
  return Buffer.from(parts);
}

// ---------------------------------------------------------------------------
// SP2: a sprite
// ---------------------------------------------------------------------------

// A Quake 2 sprite is a header and a list of frames, each naming another entry in
// the archive. This archive's eight sprites all name sprites/*.pcx, so replacing
// a sprite's pixels means replacing those PCX entries; the frames are read here
// so the manifest can say which pictures a sprite is made of.
export function readSp2(buffer) {
  if (buffer.length < SP2_HEADER_BYTES || buffer.toString("latin1", 0, 4) !== "IDS2") {
    throw new TextureError("that file is not a Quake 2 sprite (no IDS2 signature)", "BAD_SP2");
  }
  const version = buffer.readInt32LE(4);
  const numframes = buffer.readInt32LE(8);
  if (numframes < 1 || buffer.length < SP2_HEADER_BYTES + numframes * SP2_FRAME_BYTES) {
    throw new TextureError("the sprite claims " + numframes + " frames but is only " + buffer.length + " bytes", "BAD_SP2");
  }
  const frames = [];
  for (let index = 0; index < numframes; index++) {
    const at = SP2_HEADER_BYTES + index * SP2_FRAME_BYTES;
    frames.push({
      width: buffer.readInt32LE(at),
      height: buffer.readInt32LE(at + 4),
      originX: buffer.readInt32LE(at + 8),
      originY: buffer.readInt32LE(at + 12),
      name: buffer.toString("latin1", at + 16, at + 16 + SP2_NAME_BYTES).replace(/\0.*$/, ""),
    });
  }
  return { version, frames, width: frames[0].width, height: frames[0].height };
}

// ---------------------------------------------------------------------------
// Palettes: which colours the indices mean
// ---------------------------------------------------------------------------

// The one palette every paletted WAL is indexed into, read out of the archive
// rather than kept as a copy here. Quake 2 loads it from pics/colormap.pcx and
// Re-indexing art onto anything else would put the wrong colours on a wall.
export function globalPalette(pak, options = {}) {
  const entry = readPakFile(pak, options.entry ?? GLOBAL_PALETTE_ENTRY);
  if (!entry) {
    throw new TextureError(
      'the archive has no "' + (options.entry ?? GLOBAL_PALETTE_ENTRY) + '", so the global palette cannot be read -- a WAL cannot be re-indexed without it',
      "NO_GLOBAL_PALETTE"
    );
  }
  const palette = paletteFromPcx(entry, options.entry ?? GLOBAL_PALETTE_ENTRY);
  return { palette, source: options.entry ?? GLOBAL_PALETTE_ENTRY, id: GLOBAL_PALETTE_ID, sha1: sha1(palette) };
}

// The palette an archive entry's indices are in: the global one for a WAL, the
// entry's own trailing 768 bytes for a PCX. `options.cache` is a Map a caller
// keeps across a whole run, so a loop over 611 entries reads the global palette
// once instead of 303 times.
export function paletteForEntry(pak, name, options = {}) {
  const type = classifyEntry(name);
  if (type !== "wal" && type !== "pcx") {
    throw new TextureError('"' + name + '" is not a paletted entry (type ' + (type ?? "unknown") + ")", "NO_PALETTE");
  }
  const key = type === "wal" ? GLOBAL_PALETTE_ID : "pcx:" + normalizeName(name);
  const cache = options.cache;
  if (cache?.has(key)) return cache.get(key);

  let result;
  if (type === "wal") {
    result = globalPalette(pak, options);
  } else {
    const bytes = readPakFile(pak, name);
    if (!bytes) throw new TextureError('the archive has no entry "' + name + '"', "NO_ENTRY");
    const palette = paletteFromPcx(bytes, name);
    const digest = sha1(palette);
    result = { palette, source: name, id: "pcx:" + digest.slice(0, 12), sha1: digest };
  }
  if (cache) cache.set(key, result);
  return result;
}

// Which of the three formats an archive name is, or null for anything else
// (sounds, models, maps, and the six sky TGAs).
export function classifyEntry(name) {
  const lower = normalizeName(name);
  if (lower.endsWith(".wal")) return "wal";
  if (lower.endsWith(".pcx")) return "pcx";
  if (lower.endsWith(".sp2")) return "sp2";
  return null;
}

// The closest palette entry to an RGB triple, by squared distance in RGB. Exact
// matches win, as they must: a colour the palette already holds has to keep its
// own index rather than a neighbour that happens to round the same way.
export function nearestPalette(rgb, palette768, options = {}) {
  const map = options.map ?? paletteMapper(palette768, options);
  return typeof rgb === "number" ? map(rgb >> 16 & 255, rgb >> 8 & 255, rgb & 255) : map(rgb[0], rgb[1], rgb[2]);
}

// A reusable (r,g,b) -> index function, with the palette's own colours in a hash
// table and the answers for colours the palette does not hold memoised, so a
// megapixel of generated art costs one 256-entry scan per distinct colour.
export function paletteMapper(palette768, options = {}) {
  const palette = Buffer.isBuffer(palette768) ? palette768 : Buffer.from(palette768 ?? []);
  if (palette.length < PALETTE_BYTES) {
    throw new TextureError("a palette is " + PALETTE_BYTES + " bytes, got " + palette.length, "BAD_ARGUMENT");
  }
  const excluded = new Set(options.exclude ?? []);
  const exact = new Map();
  for (let index = 0; index < 256; index++) {
    if (excluded.has(index)) continue;
    const key = (palette[index * 3] << 16) | (palette[index * 3 + 1] << 8) | palette[index * 3 + 2];
    if (!exact.has(key)) exact.set(key, index);
  }
  const nearest = new Map();
  return function map(r, g, b) {
    if (r < 0) r = 0; else if (r > 255) r = 255;
    if (g < 0) g = 0; else if (g > 255) g = 255;
    if (b < 0) b = 0; else if (b > 255) b = 255;
    const key = (r << 16) | (g << 8) | b;
    const found = exact.get(key);
    if (found !== undefined) return found;
    const memo = nearest.get(key);
    if (memo !== undefined) return memo;
    let best = 0;
    let bestDistance = Infinity;
    for (let index = 0; index < 256; index++) {
      if (excluded.has(index)) continue;
      const dr = r - palette[index * 3];
      const dg = g - palette[index * 3 + 1];
      const db = b - palette[index * 3 + 2];
      const distance = dr * dr + dg * dg + db * db;
      if (distance < bestDistance) {
        bestDistance = distance;
        best = index;
      }
    }
    nearest.set(key, best);
    return best;
  };
}

// RGBA pixels -> palette indices, with the rule the whole team's art turns on:
//
//   a pixel with alpha at or above the cut-off takes the closest colour in the
//   palette; a pixel below it keeps whatever the ORIGINAL image had there.
//
// That single rule is right for both formats. A sprite frame's background is
// index 255 in the original, so transparent art stays transparent; a wall has no
// transparency at all, so transparent art keeps the wall it is replacing instead
// of punching a black hole through it. `original` may be null for a brand new
// entry, in which case a transparent pixel falls back to options.fallback
// (default 0).
export function rgbaToIndices(rgba, width, height, map, options = {}) {
  const cut = options.alphaCutoff ?? 128;
  const fallback = options.fallback ?? 0;
  const original = options.original ?? null;
  const indices = Buffer.alloc(width * height);
  const originalOf = typeof original === "function" ? original : (index) => (original ? original[index] : fallback);
  for (let index = 0; index < indices.length; index++) {
    const at = index * 4;
    indices[index] = rgba[at + 3] >= cut ? map(rgba[at], rgba[at + 1], rgba[at + 2]) : originalOf(index);
  }
  return indices;
}

// ---------------------------------------------------------------------------
// BSP: which textures the map actually asks for
// ---------------------------------------------------------------------------

// A Quake 2 BSP's lump table. The ident is "IBSP" and version 38 is Quake 2.
function readBspLumps(bsp) {
  if (bsp.length < 8 + BSP_HEADER_LUMPS * 8) throw new TextureError("the BSP is shorter than its header", "BAD_BSP");
  const ident = bsp.readUInt32LE(0);
  if (ident !== BSP_IDENT) {
    throw new TextureError("that file is not a BSP (ident 0x" + ident.toString(16) + ", expected IBSP)", "BAD_BSP");
  }
  const version = bsp.readInt32LE(4);
  if (version !== BSP_VERSION_Q2) {
    throw new TextureError("that BSP is version " + version + ", not Quake 2's " + BSP_VERSION_Q2, "BAD_BSP");
  }
  const lumps = [];
  for (let index = 0; index < BSP_HEADER_LUMPS; index++) {
    const offset = bsp.readInt32LE(8 + index * 8);
    const length = bsp.readInt32LE(12 + index * 8);
    if (offset < 0 || length < 0 || offset + length > bsp.length) {
      throw new TextureError("BSP lump " + index + " is out of bounds", "BAD_BSP");
    }
    lumps.push({ offset, length });
  }
  return lumps;
}

// One record per texinfo: the texture name the map's faces point at, the flags
// and light value that go with it, and how many faces use it.
//
// Quake 2's BSP has no texture lump -- the name is in the texinfo, as a path
// relative to textures/ with no extension ("e1u1/metal2_1" becomes
// "textures/e1u1/metal2_1.wal") -- so this is the lump that answers "which
// textures does this map load".
export function readBspTexinfo(bsp) {
  const lumps = readBspLumps(bsp);
  const texinfo = lumps[LUMP_TEXINFO];
  const faces = lumps[LUMP_FACES];
  if (texinfo.length % TEXINFO_BYTES !== 0) {
    throw new TextureError("the BSP's texinfo lump is not a whole number of " + TEXINFO_BYTES + "-byte records", "BAD_BSP");
  }
  if (faces.length % FACE_BYTES !== 0) {
    throw new TextureError("the BSP's face lump is not a whole number of " + FACE_BYTES + "-byte records", "BAD_BSP");
  }
  const count = texinfo.length / TEXINFO_BYTES;
  const records = [];
  for (let index = 0; index < count; index++) {
    const at = texinfo.offset + index * TEXINFO_BYTES;
    records.push({
      index,
      name: bsp.toString("latin1", at + 40, at + 72).replace(/\0.*$/, ""),
      flags: bsp.readInt32LE(at + 32),
      value: bsp.readInt32LE(at + 36),
      nexttexinfo: bsp.readInt32LE(at + 72),
      faces: 0,
    });
  }
  const faceCount = faces.length / FACE_BYTES;
  for (let index = 0; index < faceCount; index++) {
    const texinfoIndex = bsp.readUInt16LE(faces.offset + index * FACE_BYTES + 10);
    if (texinfoIndex < count) records[texinfoIndex].faces++;
  }
  return { records, faces: faceCount, texinfos: count };
}

// Per texture name: how many faces use it. That count is the "use" a texture has
// in a map -- a name on one face is scenery, a name on six hundred is the floor
// the player spends the level looking at.
export function bspTextureUsage(bsp) {
  const { records, faces, texinfos } = readBspTexinfo(bsp);
  const byName = new Map();
  for (const record of records) {
    if (!record.name) continue;
    const found = byName.get(record.name) ?? { name: record.name, uses: 0, texinfos: 0, flags: record.flags, value: record.value };
    found.uses += record.faces;
    found.texinfos++;
    byName.set(record.name, found);
  }
  const names = [...byName.values()].sort((a, b) => b.uses - a.uses || (a.name < b.name ? -1 : 1));
  return { faces, texinfos, names };
}

// The archive entry a BSP texture name resolves to. The engine builds this the
// same way for every texinfo: "textures/" + the name + ".wal". A name that is
// already a path with an extension ("textures/e1u1/x.wal") is taken as it stands,
// because the maps that ship that way mean it literally.
export function walNameFor(texture) {
  const name = String(texture).replace(/\\/g, "/").replace(/^\/+/, "");
  if (/\.(wal|pcx|tga)$/i.test(name)) return name;
  return /^textures\//i.test(name) ? name + ".wal" : "textures/" + name + ".wal";
}

// ---------------------------------------------------------------------------
// The manifest: the archive's image entries, as data the team shares
// ---------------------------------------------------------------------------

// Where a generated PNG for one archive entry goes:
//
//   assets/textures/<the archive path, with its extension replaced by .png>
//
// so textures/e1u1/metal2_1.wal is assets/textures/textures/e1u1/metal2_1.png
// and sprites/s_bfg1_0.pcx is assets/textures/sprites/s_bfg1_0.png. The archive
// path, not just the file name, because pics/, textures/ and sprites/ all hold
// files with the same sort of names.
export function artPathFor(entryName, artDir = DEFAULT_ART_DIR) {
  const name = normalizeName(entryName);
  return path.join(path.resolve(artDir), name.replace(/\.[a-z0-9]+$/i, ".png"));
}

// The manifest path of a generated PNG, relative to the project, with forward
// slashes, so it is the same string on any machine. Always the default art
// directory: the manifest records the project's convention, and a tool that is
// pointed somewhere else by --art works that out for itself.
export function artPathInProject(entryName) {
  return path.relative(PROJECT_ROOT, artPathFor(entryName, DEFAULT_ART_DIR)).split(path.sep).join("/");
}

// Everything the six art tasks need to know about one archive entry, as one
// plain object: where it is, what it is, how big it is, which palette its indices
// mean, and where its new art belongs.
export function describeEntry(pak, name) {
  const entry = pakEntry(pak, name);
  if (!entry) throw new TextureError('the archive has no entry "' + name + '"', "NO_ENTRY");
  const bytes = pak.subarray(entry.offset, entry.offset + entry.length);
  const type = classifyEntry(entry.name);
  const record = {
    name: entry.name,
    offset: entry.offset,
    size: entry.length,
    type: type ?? "other",
    width: 0,
    height: 0,
    palette: null,
  };
  if (type === "wal") {
    const wal = readWal(bytes);
    record.width = wal.width;
    record.height = wal.height;
    record.palette = GLOBAL_PALETTE_ID;
    record.miptex = wal.name;
    record.mipLevels = wal.mipLevels;
    record.animname = wal.animname;
    record.flags = wal.flags;
    record.contents = wal.contents;
    record.value = wal.value;
  } else if (type === "pcx") {
    const pcx = readPcx(bytes);
    record.width = pcx.width;
    record.height = pcx.height;
    record.bytesPerLine = pcx.bytesPerLine;
    record.palette = "pcx:" + sha1(pcx.palette).slice(0, 12);
  } else if (type === "sp2") {
    const sprite = readSp2(bytes);
    record.width = sprite.width;
    record.height = sprite.height;
    record.frames = sprite.frames.length;
    record.frameNames = sprite.frames.map((frame) => frame.name);
    // A sprite has no picture of its own -- its frames are separate entries in
    // the archive, each with its own art path -- so it has no art path here, and
    // its palette is the one its frames are drawn in. Mixed frames are reported
    // as such rather than silently presented as one palette.
    const framePalettes = sprite.frames.map((frame) => {
      const frameBytes = readPakFile(pak, frame.name);
      return frameBytes ? "pcx:" + sha1(paletteFromPcx(frameBytes, frame.name)).slice(0, 12) : null;
    });
    record.palette = framePalettes.every((id) => id && id === framePalettes[0]) ? framePalettes[0] : null;
    record.framePalettes = [...new Set(framePalettes)];
  }
  // Only a WAL and a PCX are drawn from a picture of their own; a sprite is
  // drawn from its frames, which have entries and art paths of their own.
  record.png = record.type === "sp2" ? null : artPathInProject(entry.name);
  return record;
}

// The manifest for an archive: one record per WAL, PCX and SP2 entry, the
// palettes those entries are indexed into, and what maps/demo1.bsp asks for.
//
// `palette` per entry is an identifier, not a colour table: WALs all name the one
// global palette ("q2:global"), PCXs name their own by a hash of the 768 bytes at
// their end, so two pictures that share a palette visibly share an id, and a
// sprite names its frames'. The palettes themselves are not copied in here --
// they are read from the archive by globalPalette()/paletteForEntry() when art is
// actually re-indexed, which is why replacing a picture cannot change colours.
export function buildManifest(pak, options = {}) {
  const buffer = loadPak(pak);
  const pakPath = options.pakPath ?? (typeof pak === "string" ? path.relative(PROJECT_ROOT, path.resolve(pak)) : DEFAULT_PAK);
  const directory = readPakDirectory(buffer);
  const global = globalPalette(buffer);

  const entries = [];
  const counts = { wal: 0, pcx: 0, sp2: 0 };
  for (const [, found] of directory) {
    const record = describeEntry(buffer, found.name);
    if (record.type === "other") continue;
    counts[record.type]++;
    entries.push(record);
  }

  // The palettes list is counted off the entries themselves, so it cannot drift
  // from what the entries say: one group per distinct id, with how many entries
  // name it, where the palette lives, and the first entry that names it.
  const palettes = new Map();
  const groupFor = (id, source) => {
    const found = palettes.get(id) ?? {
      id,
      kind: id === GLOBAL_PALETTE_ID ? "wal" : "pcx",
      sha1: id === GLOBAL_PALETTE_ID ? global.sha1 : id.slice(4),
      bytes: PALETTE_BYTES,
      source: id === GLOBAL_PALETTE_ID ? global.source : source,
      entries: 0,
    };
    palettes.set(id, found);
    return found;
  };
  for (const record of entries) if (record.palette) groupFor(record.palette, record.name).entries++;

  const seen = new Map();
  for (const entry of entries) {
    if (!entry.png) continue;
    const clash = seen.get(entry.png);
    if (clash) throw new TextureError('"' + entry.name + '" and "' + clash + '" would both be drawn from ' + entry.png, "MANIFEST_CLASH");
    seen.set(entry.png, entry.name);
  }

  // Which textures each map in the archive asks for, most-used first, with the
  // entry each name resolves to and whether the archive actually holds it.
  const maps = [];
  for (const [, found] of directory) {
    if (!/^maps\/.*\.bsp$/i.test(found.name)) continue;
    const bsp = buffer.subarray(found.offset, found.offset + found.length);
    const usage = bspTextureUsage(bsp);
    maps.push({
      name: found.name,
      texinfos: usage.texinfos,
      faces: usage.faces,
      textures: usage.names.map((texture) => {
        const wal = walNameFor(texture.name);
        return {
          name: texture.name,
          wal,
          uses: texture.uses,
          texinfos: texture.texinfos,
          present: directory.has(wal.toLowerCase()),
        };
      }),
    });
  }
  maps.sort((a, b) => (/demo1/i.test(a.name) ? -1 : /demo1/i.test(b.name) ? 1 : a.name < b.name ? -1 : 1));

  return {
    schema: MANIFEST_SCHEMA,
    generator: "scripts/texture-lib.mjs buildManifest()",
    notes: [
      "One record per WAL, PCX and SP2 entry in baseq2/pak0.pak, in archive order.",
      "png is where that entry's generated art goes, relative to the project root. A sprite has none: it is drawn from its frame pictures, which are entries of their own in this list (see frameNames).",
      "palette names the palette the entry's indices mean; read the palette itself out of the source archive with paletteForEntry().",
      "uses is the number of faces in the map that draw the texture; texinfos counts the map's texinfo records for it.",
      "Do not edit this file by hand: regenerate it with `node scripts/texture-pack.mjs --refresh-manifest`.",
    ],
    pak: {
      path: path.relative(PROJECT_ROOT, path.resolve(pakPath)).split(path.sep).join("/"),
      size: buffer.length,
      sha1: sha1(buffer),
      directoryOffset: buffer.readUInt32LE(4),
      entryCount: directory.size,
    },
    counts,
    palettes: [...palettes.values()].sort((a, b) => b.entries - a.entries || (a.id < b.id ? -1 : 1)),
    maps,
    entries,
  };
}

// The manifest as text: one field per line, so a change to one texture is one
// change in the diff.
export function manifestText(manifest) {
  return JSON.stringify(manifest, null, 1) + "\n";
}

// Write the manifest, atomically, beside the art it describes.
export function writeManifest(manifest, outPath = DEFAULT_MANIFEST) {
  const directory = path.dirname(outPath);
  fs.mkdirSync(directory, { recursive: true });
  const temporary = path.join(directory, "." + path.basename(outPath) + ".tmp-" + process.pid);
  fs.writeFileSync(temporary, manifestText(manifest));
  fs.renameSync(temporary, outPath);
  return outPath;
}

// Read a manifest back, checking that it is one of ours before a caller trusts a
// field from it. Every way this can go wrong ends in a sentence a person can act
// on -- which file, what is wrong with it, and the command that rebuilds it --
// because six tools stand on this file and a bare stack trace out of it says
// nothing about the texture anyone was trying to replace.
export function readManifest(file = DEFAULT_MANIFEST) {
  const remedy = " -- regenerate it with `node scripts/texture-pack.mjs --refresh-manifest`";
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (error) {
    throw new TextureError("cannot read the manifest at " + file + " (" + error.message + ")" + remedy, "NO_MANIFEST");
  }
  let manifest;
  try {
    manifest = JSON.parse(text);
  } catch (error) {
    throw new TextureError("the manifest at " + file + " is not JSON (" + error.message + ")" + remedy, "BAD_MANIFEST");
  }
  if (manifest === null || typeof manifest !== "object" || Array.isArray(manifest)) {
    const what = manifest === null ? "null" : Array.isArray(manifest) ? "an array" : "a " + typeof manifest;
    throw new TextureError("the manifest at " + file + " is " + what + ", not a manifest object" + remedy, "BAD_MANIFEST");
  }
  if (manifest.schema !== MANIFEST_SCHEMA) {
    throw new TextureError(
      "the manifest at " + file + " says schema " + JSON.stringify(manifest.schema) + ", and this reads schema " + MANIFEST_SCHEMA + remedy,
      "BAD_MANIFEST"
    );
  }
  if (!Array.isArray(manifest.entries) || !manifest.entries.length) {
    throw new TextureError("the manifest at " + file + " lists no entries" + remedy, "BAD_MANIFEST");
  }
  for (const entry of manifest.entries) {
    const named = entry && typeof entry.name === "string" && entry.name ? '"' + entry.name + '"' : "an entry with no name";
    if (!entry || !entry.name) throw new TextureError("the manifest at " + file + " has an entry with no name" + remedy, "BAD_MANIFEST");
    if (!Number.isInteger(entry.width) || !Number.isInteger(entry.height) || entry.width <= 0 || entry.height <= 0) {
      throw new TextureError(
        "the manifest entry " + named + " has no usable size (" + JSON.stringify(entry.width) + "x" + JSON.stringify(entry.height) + ")" + remedy,
        "BAD_MANIFEST"
      );
    }
    if (!("png" in entry) || (entry.png !== null && typeof entry.png !== "string")) {
      throw new TextureError("the manifest entry " + named + " has no art path (png is " + JSON.stringify(entry.png) + ")" + remedy, "BAD_MANIFEST");
    }
  }
  return manifest;
}

// ---------------------------------------------------------------------------
// Small shared helpers
// ---------------------------------------------------------------------------

export function isPowerOfTwo(value) {
  return Number.isInteger(value) && value > 0 && (value & (value - 1)) === 0;
}

export function dimensionsOf(buffer, type = null) {
  const kind = type ?? guessType(buffer);
  if (kind === "wal") {
    const wal = readWal(buffer);
    return { width: wal.width, height: wal.height };
  }
  if (kind === "pcx") {
    const pcx = readPcx(buffer);
    return { width: pcx.width, height: pcx.height };
  }
  if (kind === "sp2") {
    const sprite = readSp2(buffer);
    return { width: sprite.width, height: sprite.height };
  }
  throw new TextureError("cannot read dimensions of a " + (kind ?? "unknown") + " image", "BAD_IMAGE");
}

function guessType(buffer) {
  if (buffer.length >= 4 && buffer.toString("latin1", 0, 4) === "IDS2") return "sp2";
  if (buffer.length >= 4 && buffer.toString("latin1", 0, 4) === "PACK") return "pak";
  if (buffer.length >= 8 && buffer.readUInt32BE(0) === 0x89504e47) return "png";
  if (buffer.length >= PCX_HEADER_BYTES && buffer[0] === 0x0a && buffer[1] === 5 && buffer[3] === 8) return "pcx";
  if (buffer.length >= WAL_HEADER_BYTES) return "wal";
  return null;
}

export function formatBytes(value) {
  if (value < 1024) return value + " B";
  if (value < 1024 * 1024) return (value / 1024).toFixed(1) + " KB";
  return (value / (1024 * 1024)).toFixed(1) + " MB";
}
