/**
 * 生成扩展图标 media/icon.png（128×128）
 * 设计：墨蓝渐变圆角方块 + 白色「监控读数」图形（波形曲线 + 度量条），与面板视觉一致。
 * 依赖：仅 Node 内置 zlib（4 倍超采样后降采样，得到平滑边缘）。
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const SIZE = 128;
const SS = 4; // 超采样倍数
const N = SIZE * SS;

// ---------- 距离函数（超采样网格下计算，单位：0..128 的设计坐标） ----------
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
  const dx = px - (ax + t * vx);
  const dy = py - (ay + t * vy);
  return Math.sqrt(dx * dx + dy * dy);
}

function circleSDF(px, py, cx, cy, r) {
  return Math.hypot(px - cx, py - cy) - r;
}

// ---------- 图形定义（设计坐标 0..128） ----------
const GRAD_TOP = [46, 115, 156]; // #2E739C
const GRAD_BOTTOM = [24, 68, 94]; // #18445E

const WAVE = [
  [26, 58],
  [46, 42],
  [62, 52],
  [82, 30],
  [102, 42]
];
const WAVE_HALF = 3.6; // 线宽 7.2
const DOT = [102, 42, 5.2];

const TRACK = [26, 76, 102, 94, 9];
const FILL = [26, 76, 86, 94, 9];

function designColor(x, y) {
  // 背景：圆角方块（半径 27）
  const bg = roundedRectSDF(x, y, 0, 0, 128, 128, 27);
  if (bg > 0) {
    return [0, 0, 0, 0];
  }
  const t = Math.max(0, Math.min(1, y / 128));
  let color = [
    GRAD_TOP[0] + (GRAD_BOTTOM[0] - GRAD_TOP[0]) * t,
    GRAD_TOP[1] + (GRAD_BOTTOM[1] - GRAD_TOP[1]) * t,
    GRAD_TOP[2] + (GRAD_BOTTOM[2] - GRAD_TOP[2]) * t,
    255
  ];

  // 叠加白色图形（半透明轨道先算，实心部分覆盖）
  const trackSDF = roundedRectSDF(x, y, TRACK[0], TRACK[1], TRACK[2], TRACK[3], TRACK[4]);
  if (trackSDF <= 0) {
    color = [255, 255, 255, 255 * 0.3 + color[3] * 0];
    color[3] = 255;
    // 轨道：白 30% 与底色混合
    color = [color[0] * 0.3 + (GRAD_TOP[0] + (GRAD_BOTTOM[0] - GRAD_TOP[0]) * t) * 0.7,
             color[1] * 0.3 + (GRAD_TOP[1] + (GRAD_BOTTOM[1] - GRAD_TOP[1]) * t) * 0.7,
             color[2] * 0.3 + (GRAD_TOP[2] + (GRAD_BOTTOM[2] - GRAD_TOP[2]) * t) * 0.7,
             255];
  }
  const fillSDF = roundedRectSDF(x, y, FILL[0], FILL[1], FILL[2], FILL[3], FILL[4]);
  if (fillSDF <= 0) {
    color = [255, 255, 255, 255];
  }

  let waveDist = Infinity;
  for (let i = 0; i < WAVE.length - 1; i++) {
    waveDist = Math.min(waveDist, segmentDistance(x, y, WAVE[i][0], WAVE[i][1], WAVE[i + 1][0], WAVE[i + 1][1]));
  }
  if (waveDist <= WAVE_HALF || circleSDF(x, y, DOT[0], DOT[1], DOT[2]) <= 0) {
    color = [255, 255, 255, 255];
  }
  return color;
}

// ---------- 超采样渲染 + 降采样 ----------
const big = new Float64Array(N * N * 4);
for (let py = 0; py < N; py++) {
  for (let px = 0; px < N; px++) {
    const x = (px + 0.5) / SS;
    const y = (py + 0.5) / SS;
    const [r, g, b, a] = designColor(x, y);
    const idx = (py * N + px) * 4;
    const alpha = a / 255;
    big[idx] = r * alpha;
    big[idx + 1] = g * alpha;
    big[idx + 2] = b * alpha;
    big[idx + 3] = alpha;
  }
}

const rgba = Buffer.alloc(SIZE * SIZE * 4);
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
      rgba[out] = rgba[out + 1] = rgba[out + 2] = rgba[out + 3] = 0;
    } else {
      rgba[out] = Math.round(Math.min(255, r / a));
      rgba[out + 1] = Math.round(Math.min(255, g / a));
      rgba[out + 2] = Math.round(Math.min(255, b / a));
      rgba[out + 3] = Math.round(alpha * 255);
    }
  }
}

// ---------- 手写 PNG（RGBA8 + filter 0） ----------
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

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(SIZE, 0);
ihdr.writeUInt32BE(SIZE, 4);
ihdr[8] = 8; // bit depth
ihdr[9] = 6; // RGBA
ihdr[10] = 0;
ihdr[11] = 0;
ihdr[12] = 0;

const raw = Buffer.alloc(SIZE * (SIZE * 4 + 1));
for (let y = 0; y < SIZE; y++) {
  raw[y * (SIZE * 4 + 1)] = 0;
  rgba.copy(raw, y * (SIZE * 4 + 1) + 1, y * SIZE * 4, (y + 1) * SIZE * 4);
}

const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0))
]);

const outPath = path.join(__dirname, '..', 'media', 'icon.png');
fs.writeFileSync(outPath, png);
console.log(`icon 已生成：${outPath}（${SIZE}×${SIZE}，${(png.length / 1024).toFixed(1)} KB）`);