/**
 * 生成扩展图标 media/icon.png（128×128），两种模式：
 *
 * 1) 默认（内置矢量绘制）：浅蓝渐变圆角方块 + 深蓝「GPU」几何字标，零外部依赖
 *      node dev/make-icon.js
 *
 * 2) 用图片生成模型产出的图（ICON_FROM_RAW）：先用 ffmpeg 抹掉水印、裁掉外框、等比缩到 128 并导出 RGBA，
 *    再由本脚本套圆角遮罩后编码 PNG
 *      ffmpeg -i dev/icon-ai.jpg -vf "delogo=x=1538:y=1728:w=322:h=124,crop=1600:1600:160:160,\
 *        scale=128:128:flags=lanczos,format=rgba" -f rawvideo -pix_fmt rgba /tmp/icon.raw
 *      ICON_FROM_RAW=/tmp/icon.raw node dev/make-icon.js
 *    （gen1 源图：dev/icon-ai.jpg；浅蓝底 + 深蓝 GPU 字标）
 *
 * 可选环境变量：ICON_SIZE 输出尺寸、ICON_OUT 输出路径。
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const SIZE = Number(process.env.ICON_SIZE || 128);
const SS = 4;
const N = SIZE * SS;

const DEG = Math.PI / 180;

// ---------- 距离场 ----------
function roundedRectSDF(px, py, x0, y0, x1, y1, r) {
  const cx = (x0 + x1) / 2;
  const cy = (y0 + y1) / 2;
  const hx = (x1 - x0) / 2 - r;
  const hy = (y1 - y0) / 2 - r;
  const dx = Math.abs(px - cx) - hx;
  const dy = Math.abs(py - cy) - hy;
  const ax = Math.max(dx, 0);
  const ay = Math.max(dy, 0);
  return Math.sqrt(ax * ax + ay * ay) + Math.min(Math.max(dx, dy), 0) - r;
}

function segmentDistance(px, py, ax, ay, bx, by) {
  const vx = bx - ax;
  const vy = by - ay;
  const wx = px - ax;
  const wy = py - ay;
  const len2 = vx * vx + vy * vy;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, (wx * vx + wy * vy) / len2));
  return Math.hypot(px - (ax + t * vx), py - (ay + t * vy));
}

/** 圆弧（a0 → a1 逆时针扫过，角度单位度，屏幕坐标系 y 向下）到点的最短距离 */
function arcDistance(px, py, cx, cy, r, a0, a1) {
  const angle = Math.atan2(py - cy, px - cx) / DEG;
  const sweep = ((a1 - a0) % 360 + 360) % 360;
  const delta = ((angle - a0) % 360 + 360) % 360;
  if (delta <= sweep) {
    return Math.abs(Math.hypot(px - cx, py - cy) - r);
  }
  const rad0 = a0 * DEG;
  const rad1 = a1 * DEG;
  return Math.min(
    Math.hypot(px - (cx + r * Math.cos(rad0)), py - (cy + r * Math.sin(rad0))),
    Math.hypot(px - (cx + r * Math.cos(rad1)), py - (cy + r * Math.sin(rad1)))
  );
}

// ---------- 配色 ----------
const BLUE_TOP = [150, 210, 238]; // #96D2EE 浅蓝
const BLUE_BOTTOM = [96, 168, 210]; // #60A8D2
const INK = [17, 68, 94]; // #11445E 深蓝字

// ---------- 「GPU」几何字标（设计坐标 0..128） ----------
const STROKE = 4.8; // 半宽 → 线宽 9.6
const LETTERS = [
  // G：右侧开口的圆 + 中部横杠（开口 50°，横杠把开口连成 G）
  [
    { type: 'arc', cx: 33, cy: 64, r: 17, a0: 32, a1: 328 },
    { type: 'seg', a: [50, 64], b: [39, 64] }
  ],
  // P：竖干 + 右上半圆（圆心落在竖干上，弧从上方 270° 经右侧 0° 扫到下方 90°）
  [
    { type: 'seg', a: [54, 45], b: [54, 83] },
    { type: 'arc', cx: 54, cy: 58.5, r: 12.5, a0: 270, a1: 450 }
  ],
  // U：左右竖段 + 底部半圆（弧从右侧 0° 经底部 90° 扫到左侧 180°）
  [
    { type: 'seg', a: [82, 45], b: [82, 64.5] },
    { type: 'arc', cx: 98, cy: 64.5, r: 16, a0: 0, a1: 180 },
    { type: 'seg', a: [114, 64.5], b: [114, 45] }
  ]
];

function letterDistance(x, y) {
  let best = Infinity;
  for (const letter of LETTERS) {
    for (const shape of letter) {
      best =
        shape.type === 'arc'
          ? Math.min(best, arcDistance(x, y, shape.cx, shape.cy, shape.r, shape.a0, shape.a1))
          : Math.min(best, segmentDistance(x, y, shape.a[0], shape.a[1], shape.b[0], shape.b[1]));
    }
  }
  return best;
}

function designColor(x, y) {
  if (roundedRectSDF(x, y, 0, 0, 128, 128, 27) > 0) {
    return [0, 0, 0, 0];
  }
  const t = Math.max(0, Math.min(1, y / 128));
  const base = [
    BLUE_TOP[0] + (BLUE_BOTTOM[0] - BLUE_TOP[0]) * t,
    BLUE_TOP[1] + (BLUE_BOTTOM[1] - BLUE_TOP[1]) * t,
    BLUE_TOP[2] + (BLUE_BOTTOM[2] - BLUE_TOP[2]) * t
  ];
  if (letterDistance(x, y) <= STROKE) {
    return [INK[0], INK[1], INK[2], 255];
  }
  return [base[0], base[1], base[2], 255];
}

// ---------- 渲染 ----------
const SCALE = 128 / SIZE; // 设计坐标固定 0..128，按输出尺寸等比缩放
const big = new Float64Array(N * N * 4);
for (let py = 0; py < N; py++) {
  for (let px = 0; px < N; px++) {
    const [r, g, b, a] = designColor((px + 0.5) / SS * SCALE, (py + 0.5) / SS * SCALE);
    const idx = (py * N + px) * 4;
    const alpha = a / 255;
    big[idx] = r * alpha;
    big[idx + 1] = g * alpha;
    big[idx + 2] = b * alpha;
    big[idx + 3] = alpha;
  }
}

const vectorRgba = Buffer.alloc(SIZE * SIZE * 4);
for (let y = 0; y < SIZE; y++) {
  for (let x = 0; x < SIZE; x++) {
    let r = 0;
    let g = 0;
    let b = 0;
    let a = 0;
    for (let sy = 0; sy < SS; sy++) {
      for (let sx = 0; sx < SS; sx++) {
        const idx = ((y * SS + sy) * N + (x * SS + sx)) * 4;
        r += big[idx];
        g += big[idx + 1];
        b += big[idx + 2];
        a += big[idx + 3];
      }
    }
    const count = SS * SS;
    const alpha = a / count;
    const out = (y * SIZE + x) * 4;
    if (alpha <= 0.0001) {
      vectorRgba[out] = vectorRgba[out + 1] = vectorRgba[out + 2] = vectorRgba[out + 3] = 0;
    } else {
      vectorRgba[out] = Math.round(Math.min(255, r / a));
      vectorRgba[out + 1] = Math.round(Math.min(255, g / a));
      vectorRgba[out + 2] = Math.round(Math.min(255, b / a));
      vectorRgba[out + 3] = Math.round(alpha * 255);
    }
  }
}

// ---------- 手写 PNG ----------
function crc32(buf) {
  let table = crc32.table;
  if (!table) {
    table = crc32.table = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) {
        c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      }
      table[n] = c;
    }
  }
  let crc = -1;
  for (let i = 0; i < buf.length; i++) {
    crc = (crc >>> 8) ^ table[(crc ^ buf[i]) & 0xff];
  }
  return (crc ^ -1) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([length, body, crc]);
}

/** 把 RGBA 像素编码为 PNG（8 位 RGBA，filter 0） */
function encodePng(pixels, size) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8;
  header[9] = 6;

  const scanlines = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    scanlines[y * (size * 4 + 1)] = 0;
    pixels.copy(scanlines, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', zlib.deflateSync(scanlines, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

/** 给不透明像素套上圆角遮罩（1px 平滑过渡） */
function applyRoundedMask(pixels, size, radius) {
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const distance = roundedRectSDF(x + 0.5, y + 0.5, 0, 0, size, size, radius);
      const coverage = Math.max(0, Math.min(1, 0.5 - distance));
      const index = (y * size + x) * 4 + 3;
      pixels[index] = Math.round(pixels[index] * coverage);
    }
  }
  return pixels;
}

// ---------- 输出 ----------
const outPath = process.env.ICON_OUT || path.join(__dirname, '..', 'media', 'icon.png');
let rgba;

if (process.env.ICON_FROM_RAW) {
  // 用图片生成模型产出的图：ffmpeg 已裁掉外框、缩放为 SIZE×SIZE 的 RGBA 原始像素（-pix_fmt rgba）
  rgba = Buffer.from(fs.readFileSync(process.env.ICON_FROM_RAW));
  if (rgba.length !== SIZE * SIZE * 4) {
    throw new Error(`原始像素大小不符：期望 ${SIZE * SIZE * 4} 字节，实际 ${rgba.length}`);
  }
  applyRoundedMask(rgba, SIZE, 26);
} else {
  // 默认：内置矢量绘制（浅蓝圆角方块 + GPU 字标）
  rgba = vectorRgba;
}

const png = encodePng(rgba, SIZE);
fs.writeFileSync(outPath, png);
console.log(`icon 已生成：${outPath}（${SIZE}×${SIZE}，${(png.length / 1024).toFixed(1)} KB）`);