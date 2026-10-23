'use strict';
// Renders the PNG app icons (needed by Android install and iOS home screen)
// without any image dependency: rasterises the same shapes as icon.svg.
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const BG = [243, 247, 252];
const NAVY = [18, 51, 103];
const BLUE = [23, 100, 220];
const WHITE = [255, 255, 255];

function crc32(buf) {
  let c, crc = 0xffffffff;
  for (let n = 0; n < buf.length; n++) {
    c = (crc ^ buf[n]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function inPoly(x, y, pts) {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, yi] = pts[i], [xj, yj] = pts[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
const CROWN = [[146, 316], [166, 196], [216, 246], [256, 166], [296, 246], [346, 196], [366, 316]];
const FRAME = [[256, 64], [422, 160], [422, 352], [256, 448], [90, 352], [90, 160]];
const FACE = [[256, 80], [408, 168], [408, 344], [256, 432], [104, 344], [104, 168]];

function colorAt(x, y) {
  let c = BG;
  if ((x >= 56 && x <= 456 && Math.abs(y - 256) <= 4) ||
      (y >= 40 && y <= 472 && Math.abs(x - 256) <= 4)) c = NAVY;
  if (inPoly(x, y, FRAME)) c = NAVY;
  if (inPoly(x, y, FACE)) c = BLUE;
  if (inPoly(x, y, CROWN) || (x >= 146 && x <= 366 && y >= 330 && y <= 356)) c = WHITE;
  if ([[56, 256], [456, 256], [256, 40], [256, 472]].some(([cx, cy]) => Math.hypot(x - cx, y - cy) <= 10)) c = BLUE;
  return c;
}

function render(size) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let py = 0; py < size; py++) {
    raw[py * (size * 4 + 1)] = 0;
    for (let px = 0; px < size; px++) {
      // Four subpixels keep the diagonal emblem edges crisp at both icon sizes.
      const c = [0, 0, 0];
      for (const dy of [.25, .75]) for (const dx of [.25, .75]) {
        const sample = colorAt(((px + dx) / size) * 512, ((py + dy) / size) * 512);
        for (let i = 0; i < 3; i++) c[i] += sample[i] / 4;
      }
      const o = py * (size * 4 + 1) + 1 + px * 4;
      raw[o] = Math.round(c[0]); raw[o + 1] = Math.round(c[1]); raw[o + 2] = Math.round(c[2]); raw[o + 3] = 255;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0)),
  ]);
}

const out = path.join(__dirname, '..', 'public', 'icons');
for (const s of [192, 512]) fs.writeFileSync(path.join(out, `icon-${s}.png`), render(s));
console.log('icons written');
