// Generates PWA icons (192 & 512 px) with no image libraries — pure Node.
// Draws a rounded indigo square with a white checkmark, encodes as PNG.
import { deflateSync } from 'node:zlib';
import { writeFileSync, existsSync, mkdirSync } from 'node:fs';

const OUT_DIR = new URL('../public/icons/', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
if (!existsSync(OUT_DIR)) mkdirSync(OUT_DIR, { recursive: true });

const BG = [99, 102, 241]; // indigo-500
const FG = [255, 255, 255];

function distToSegment(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const len2 = dx * dx + dy * dy || 1;
  let t = ((px - ax) * dx + (py - ay) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  const cx = ax + t * dx, cy = ay + t * dy;
  return Math.hypot(px - cx, py - cy);
}

function drawIcon(size, maskable) {
  const data = Buffer.alloc(size * size * 4);
  // For maskable icons, keep the check well inside the safe zone (no rounded corners; fill edge-to-edge).
  const radius = maskable ? 0 : size * 0.22;
  const thick = size * 0.08;
  // checkmark points (normalized)
  const p = [
    [0.30, 0.52],
    [0.44, 0.68],
    [0.72, 0.34],
  ].map(([x, y]) => [x * size, y * size]);

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      // rounded-corner mask
      let inside = true;
      if (radius > 0) {
        const rx = Math.max(radius - x, x - (size - radius), 0);
        const ry = Math.max(radius - y, y - (size - radius), 0);
        if (rx > 0 && ry > 0 && Math.hypot(rx, ry) > radius) inside = false;
      }
      if (!inside) {
        data[i] = data[i + 1] = data[i + 2] = data[i + 3] = 0;
        continue;
      }
      // is this pixel on the checkmark stroke?
      const d = Math.min(
        distToSegment(x, y, p[0][0], p[0][1], p[1][0], p[1][1]),
        distToSegment(x, y, p[1][0], p[1][1], p[2][0], p[2][1])
      );
      const onCheck = d < thick;
      const c = onCheck ? FG : BG;
      data[i] = c[0];
      data[i + 1] = c[1];
      data[i + 2] = c[2];
      data[i + 3] = 255;
    }
  }
  return encodePNG(size, size, data);
}

// --- minimal PNG encoder ---
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const body = Buffer.concat([typeBuf, data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}
function encodePNG(width, height, rgba) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  // add filter byte (0) at the start of each scanline
  const raw = Buffer.alloc(height * (width * 4 + 1));
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0;
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  }
  const idat = deflateSync(raw, { level: 9 });
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
}

writeFileSync(OUT_DIR + 'icon-192.png', drawIcon(192, false));
writeFileSync(OUT_DIR + 'icon-512.png', drawIcon(512, false));
writeFileSync(OUT_DIR + 'icon-maskable-512.png', drawIcon(512, true));
console.log('Wrote public/icons/icon-192.png, icon-512.png, icon-maskable-512.png');
