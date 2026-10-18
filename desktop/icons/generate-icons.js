/**
 * desktop/icons/generate-icons.js — minimal PNG icon generator.
 *
 * Writes 4 single-color 16×16 PNGs for the tray states (running/paused/stopped/unknown).
 * Avoids pulling in a heavy image library; emits raw PNG bytes with hand-rolled CRC + IDAT.
 *
 * Run once after `npm install` in this directory:
 *     node generate-icons.js
 */
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

const TRAY_SIZE = 16;       // tray icons live in the system-tray PNG slot
const APP_SIZE  = 256;      // NSIS installer + app icon — Windows requires 256x256
const COLORS = {
  "tray-running.png":  [0x10, 0xb9, 0x81],   // emerald
  "tray-paused.png":   [0xf5, 0x9e, 0x0b],   // amber
  "tray-stopped.png":  [0xef, 0x44, 0x44],   // red
  "tray-unknown.png":  [0x6b, 0x70, 0x60],   // muted gray
};

function makePng(size, [r, g, b]) {
  // RGBA pixel data — solid fill, fully opaque. Tiny purpose-built renderer keeps the icon
  // generator dependency-free; pretty icons are a Phase B-polish concern.
  const pixels = Buffer.alloc(size * size * 4);
  for (let i = 0; i < size * size; i++) {
    pixels[i * 4]     = r;
    pixels[i * 4 + 1] = g;
    pixels[i * 4 + 2] = b;
    pixels[i * 4 + 3] = 0xff;
  }
  // Add a 1-byte filter type prefix per scanline (0 = none)
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    pixels.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  const idat = zlib.deflateSync(raw);

  function chunk(type, data) {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
    const typeBuf = Buffer.from(type, "ascii");
    const crc = require("zlib").crc32 ? Buffer.alloc(4) : null;
    // Node's built-in CRC32 isn't always available; fall back to manual implementation
    const crcVal = crc32(Buffer.concat([typeBuf, data]));
    const crcBuf = Buffer.alloc(4); crcBuf.writeUInt32BE(crcVal >>> 0, 0);
    return Buffer.concat([len, typeBuf, data, crcBuf]);
  }

  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;       // bit depth
  ihdr[9] = 6;       // color type RGBA
  ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    sig,
    chunk("IHDR", ihdr),
    chunk("IDAT", idat),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

// Standard CRC32 — same polynomial PNG uses
const crcTable = new Uint32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  crcTable[n] = c >>> 0;
}
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

for (const [name, color] of Object.entries(COLORS)) {
  const out = path.join(__dirname, name);
  fs.writeFileSync(out, makePng(TRAY_SIZE, color));
  console.log(`wrote ${out}`);
}

// Also produce a 256×256 .ico for electron-builder. NSIS rejects icons smaller than 256px,
// so the installer/app-icon slot needs the larger size. Single-image ICO with embedded PNG
// is supported on Windows Vista+ which is the only Windows electron-builder targets.
function makeIco(size, pngBuf) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);   // reserved
  header.writeUInt16LE(1, 2);   // type = ICO
  header.writeUInt16LE(1, 4);   // count
  const dir = Buffer.alloc(16);
  // Width/height bytes: 0 means 256 in ICO format.
  dir[0] = size === 256 ? 0 : size;
  dir[1] = size === 256 ? 0 : size;
  dir[2] = 0;                       // palette
  dir[3] = 0;                       // reserved
  dir.writeUInt16LE(1, 4);          // color planes
  dir.writeUInt16LE(32, 6);         // bpp
  dir.writeUInt32LE(pngBuf.length, 8);
  dir.writeUInt32LE(22, 12);        // offset = 6 + 16
  return Buffer.concat([header, dir, pngBuf]);
}
// Re-emit tray-running.ico at 256x256 for the installer + app icon. The 16x16 PNG already
// covers the tray-icon use case via Electron's Tray.setImage.
fs.writeFileSync(path.join(__dirname, "tray-running.ico"), makeIco(APP_SIZE, makePng(APP_SIZE, COLORS["tray-running.png"])));
console.log(`wrote tray-running.ico (${APP_SIZE}x${APP_SIZE})`);
