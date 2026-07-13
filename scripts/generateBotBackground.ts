import fs from "fs";
import path from "path";

const width = 640;
const height = 360;
const frameCount = 30;
const fps = 10;
const outPath = path.resolve("assets", "bot-background.y4m");

const glyphs: Record<string, string[]> = {
  A: [
    "01110",
    "10001",
    "10001",
    "11111",
    "10001",
    "10001",
    "10001",
  ],
  I: [
    "11111",
    "00100",
    "00100",
    "00100",
    "00100",
    "00100",
    "11111",
  ],
};

function setPixel(rgb: Uint8Array, x: number, y: number, r: number, g: number, b: number): void {
  if (x < 0 || x >= width || y < 0 || y >= height) return;
  const offset = (y * width + x) * 3;
  rgb[offset] = r;
  rgb[offset + 1] = g;
  rgb[offset + 2] = b;
}

function drawRect(
  rgb: Uint8Array,
  x: number,
  y: number,
  rectWidth: number,
  rectHeight: number,
  r: number,
  g: number,
  b: number,
): void {
  for (let py = y; py < y + rectHeight; py++) {
    for (let px = x; px < x + rectWidth; px++) {
      setPixel(rgb, px, py, r, g, b);
    }
  }
}

function drawGlyph(
  rgb: Uint8Array,
  char: string,
  x: number,
  y: number,
  scale: number,
  r: number,
  g: number,
  b: number,
): void {
  const rows = glyphs[char];
  if (!rows) return;

  rows.forEach((row, rowIndex) => {
    [...row].forEach((cell, columnIndex) => {
      if (cell === "1") {
        drawRect(rgb, x + columnIndex * scale, y + rowIndex * scale, scale, scale, r, g, b);
      }
    });
  });
}

function buildRgbFrame(): Uint8Array {
  const rgb = new Uint8Array(width * height * 3);
  const centerX = width / 2;
  const centerY = height / 2;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const dx = (x - centerX) / width;
      const dy = (y - centerY) / height;
      const glow = Math.max(0, 1 - Math.sqrt(dx * dx + dy * dy) * 2.2);
      const r = Math.round(22 + 28 * glow + 10 * (x / width));
      const g = Math.round(42 + 44 * glow + 20 * (y / height));
      const b = Math.round(58 + 34 * glow);
      setPixel(rgb, x, y, r, g, b);
    }
  }

  const radius = 70;
  for (let y = Math.floor(centerY - radius); y <= Math.ceil(centerY + radius); y++) {
    for (let x = Math.floor(centerX - radius); x <= Math.ceil(centerX + radius); x++) {
      const distance = Math.sqrt((x - centerX) ** 2 + (y - centerY) ** 2);
      if (distance <= radius) {
        const edge = distance > radius - 3 ? 0.55 : 1;
        setPixel(rgb, x, y, Math.round(64 * edge), Math.round(110 * edge), Math.round(126 * edge));
      }
    }
  }

  const scale = 17;
  const gap = scale;
  const textWidth = 5 * scale * 2 + gap;
  const startX = Math.round(centerX - textWidth / 2);
  const startY = Math.round(centerY - (7 * scale) / 2);
  drawGlyph(rgb, "A", startX, startY, scale, 238, 246, 248);
  drawGlyph(rgb, "I", startX + 5 * scale + gap, startY, scale, 238, 246, 248);

  return rgb;
}

function clamp(value: number): number {
  return Math.max(0, Math.min(255, Math.round(value)));
}

function rgbToYuv420(rgb: Uint8Array): Buffer {
  const yPlane = Buffer.alloc(width * height);
  const uPlane = Buffer.alloc((width * height) / 4);
  const vPlane = Buffer.alloc((width * height) / 4);

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const rgbOffset = (y * width + x) * 3;
      const r = rgb[rgbOffset];
      const g = rgb[rgbOffset + 1];
      const b = rgb[rgbOffset + 2];
      yPlane[y * width + x] = clamp(0.257 * r + 0.504 * g + 0.098 * b + 16);
    }
  }

  for (let y = 0; y < height; y += 2) {
    for (let x = 0; x < width; x += 2) {
      let rTotal = 0;
      let gTotal = 0;
      let bTotal = 0;

      for (let oy = 0; oy < 2; oy++) {
        for (let ox = 0; ox < 2; ox++) {
          const rgbOffset = ((y + oy) * width + x + ox) * 3;
          rTotal += rgb[rgbOffset];
          gTotal += rgb[rgbOffset + 1];
          bTotal += rgb[rgbOffset + 2];
        }
      }

      const r = rTotal / 4;
      const g = gTotal / 4;
      const b = bTotal / 4;
      const uvOffset = (y / 2) * (width / 2) + x / 2;
      uPlane[uvOffset] = clamp(-0.148 * r - 0.291 * g + 0.439 * b + 128);
      vPlane[uvOffset] = clamp(0.439 * r - 0.368 * g - 0.071 * b + 128);
    }
  }

  return Buffer.concat([yPlane, uPlane, vPlane]);
}

fs.mkdirSync(path.dirname(outPath), { recursive: true });

const frame = rgbToYuv420(buildRgbFrame());
const chunks = [Buffer.from(`YUV4MPEG2 W${width} H${height} F${fps}:1 Ip A1:1 C420jpeg\n`)];

for (let i = 0; i < frameCount; i++) {
  chunks.push(Buffer.from("FRAME\n"), frame);
}

fs.writeFileSync(outPath, Buffer.concat(chunks));
console.log(`Generated ${outPath}`);
