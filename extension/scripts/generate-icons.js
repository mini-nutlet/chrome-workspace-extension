// Generate Chrome extension icons as PNG without external dependencies.
// Outputs: icon16.png, icon48.png, icon128.png with a purple "W" on white.
import { writeFileSync } from "fs";
import { deflateSync } from "zlib";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const outDir = join(__dirname, "..", "public", "icons");

// Accent purple from our CSS
const BG = [0x5b, 0x5f, 0xc7];   // #5b5fc7
const FG = [0xff, 0xff, 0xff];   // white

function makeIcon(size) {
  // RGBA pixel buffer
  const pixels = Buffer.alloc(size * size * 4, 0);
  const r = size * 0.18;  // corner radius

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      // Rounded rectangle test
      const inRect = isInRoundedRect(x, y, size, size, r);
      if (inRect) {
        pixels[i]     = BG[0];
        pixels[i + 1] = BG[1];
        pixels[i + 2] = BG[2];
        pixels[i + 3] = 255;
      } else {
        // transparent
        pixels[i] = 0; pixels[i+1] = 0; pixels[i+2] = 0; pixels[i+3] = 0;
      }
    }
  }

  // Draw "W" letter - simple bitmap approach
  drawW(pixels, size);

  // Encode as PNG
  return encodePNG(pixels, size, size);
}

function isInRoundedRect(x, y, w, h, r) {
  // Check if point is inside a centered rounded rect
  const margin = 0;
  const x0 = margin, y0 = margin, x1 = w - margin, y1 = h - margin;
  if (x < x0 || x >= x1 || y < y0 || y >= y1) return false;
  // Corner checks
  const corners = [
    [x0 + r, y0 + r],
    [x1 - r - 1, y0 + r],
    [x0 + r, y1 - r - 1],
    [x1 - r - 1, y1 - r - 1],
  ];
  for (const [cx, cy] of corners) {
    const dx = x - cx, dy = y - cy;
    if (((x < x0 + r || x >= x1 - r) && (y < y0 + r || y >= y1 - r)) && dx * dx + dy * dy > r * r) {
      return false;
    }
  }
  return true;
}

function drawW(pixels, size) {
  // Scale the W to ~60% of the icon, centered
  const scale = size / 128;
  const strokeW = Math.max(1, Math.round(10 * scale));
  const topY = Math.round(28 * scale);
  const botY = Math.round(96 * scale);
  const leftX = Math.round(24 * scale);
  const rightX = Math.round(104 * scale);
  const midX = Math.round(64 * scale);

  // W as 4 strokes: left-down, left-up, right-down, right-up
  const lines = [
    // Left downward stroke
    [leftX, topY, leftX + (midX - leftX) * 0.4, botY],
    // Left upward stroke (V left)
    [leftX + (midX - leftX) * 0.4, botY, midX - (midX - leftX) * 0.1, topY + (botY - topY) * 0.35],
    // Right downward stroke
    [midX + (rightX - midX) * 0.1, topY + (botY - topY) * 0.35, midX + (rightX - midX) * 0.6, botY],
    // Right upward stroke
    [midX + (rightX - midX) * 0.6, botY, rightX, topY],
  ];

  for (const [x0, y0, x1, y1] of lines) {
    drawThickLine(pixels, size, x0, y0, x1, y1, strokeW, FG);
  }
}

function drawThickLine(pixels, size, x0, y0, x1, y1, thickness, color) {
  const half = thickness / 2;
  // Sample along the line at sub-pixel steps
  const len = Math.sqrt((x1 - x0) ** 2 + (y1 - y0) ** 2);
  const steps = Math.ceil(len * 2);
  for (let s = 0; s <= steps; s++) {
    const t = s / steps;
    const cx = x0 + (x1 - x0) * t;
    const cy = y0 + (y1 - y0) * t;
    // Fill a circle at each step
    for (let dy = -half; dy <= half; dy++) {
      for (let dx = -half; dx <= half; dx++) {
        if (dx * dx + dy * dy > half * half) continue;
        const px = Math.round(cx + dx);
        const py = Math.round(cy + dy);
        if (px < 0 || px >= size || py < 0 || py >= size) continue;
        const i = (py * size + px) * 4;
        pixels[i] = color[0]; pixels[i+1] = color[1]; pixels[i+2] = color[2]; pixels[i+3] = 255;
      }
    }
  }
}

// Minimal PNG encoder (RGBA → PNG)
function encodePNG(pixels, width, height) {
  // Add filter byte (0 = None) at start of each row
  const rawData = Buffer.alloc(height * (width * 4 + 1));
  for (let y = 0; y < height; y++) {
    rawData[y * (width * 4 + 1)] = 0; // filter: None
    pixels.copy(rawData, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  }

  const compressed = deflateSync(rawData);

  // Build PNG file
  const chunks = [];

  // Signature
  chunks.push(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));

  // IHDR
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // color type: RGBA
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace
  chunks.push(makeChunk("IHDR", ihdr));

  // IDAT
  chunks.push(makeChunk("IDAT", compressed));

  // IEND
  chunks.push(makeChunk("IEND", Buffer.alloc(0)));

  return Buffer.concat(chunks);
}

function makeChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeB = Buffer.from(type, "ascii");
  const crcData = Buffer.concat([typeB, data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(crcData), 0);
  return Buffer.concat([len, typeB, data, crc]);
}

// CRC32 implementation
function crc32(buf) {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    crc ^= buf[i];
    for (let j = 0; j < 8; j++) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

// Generate all sizes
for (const size of [16, 48, 128]) {
  const png = makeIcon(size);
  const path = join(outDir, `icon${size}.png`);
  writeFileSync(path, png);
  console.log(`→ icon${size}.png (${png.length} bytes)`);
}
