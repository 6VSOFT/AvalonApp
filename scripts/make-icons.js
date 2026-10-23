'use strict';
// Renders the PNG app icons (needed by Android install and iOS home screen)
// without any image dependency: rasterises the same shapes as icon.svg.
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const BG = [11, 21, 48];
const GOLD = [212, 175, 55];

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

function render(size) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let py = 0; py < size; py++) {
    raw[py * (size * 4 + 1)] = 0;
    for (let px = 0; px < size; px++) {
      const x = ((px + 0.5) / size) * 512, y = ((py + 0.5) / size) * 512;
      const d = Math.hypot(x - 256, y - 256);
      const gold = Math.abs(d - 170) <= 11 || inPoly(x, y, CROWN) || (x >= 146 && x <= 366 && y >= 330 && y <= 356);
      const c = gold ? GOLD : BG;
      const o = py * (size * 4 + 1) + 1 + px * 4;
      raw[o] = c[0]; raw[o + 1] = c[1]; raw[o + 2] = c[2]; raw[o + 3] = 255;
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
