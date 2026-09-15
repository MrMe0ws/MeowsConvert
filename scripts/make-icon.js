// Готовит иконки приложения из assets/icon-source.png (без внешних зависимостей):
//   assets/icon.png       — 512px, окно и панель задач в режиме разработки
//   assets/icon.ico       — все размеры для Windows (exe, ярлыки, Пуск, панель задач)
//   assets/tray.ico       — трей (крупный план, чтобы читалось в 16px)
//   assets/icon-small.png — 64px, значок в заголовке окна
//   build/icon.ico        — для electron-builder
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const root = path.join(__dirname, '..');
const SOURCE = path.join(root, 'assets', 'icon-source.png');

// Кадры в долях исходника: полный вид и крупный план для мелких размеров
const FULL_CROP = { x: 0.025, y: 0.025, size: 0.95 };
const CLOSE_CROP = { x: 0.11, y: 0.19, size: 0.8 };
const CORNER_RADIUS = 0.2;

// ---------- PNG: чтение ----------

function decodePng(buf) {
  let pos = 8;
  let width, height, colorType, bitDepth, interlace;
  const idat = [];
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString('ascii', pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + len);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
      interlace = data[12];
    } else if (type === 'IDAT') {
      idat.push(data);
    } else if (type === 'IEND') {
      break;
    }
    pos += 12 + len;
  }
  const channels = { 2: 3, 6: 4 }[colorType];
  if (bitDepth !== 8 || !channels || interlace) {
    throw new Error('Нужен 8-битный PNG (RGB или RGBA) без чересстрочности');
  }

  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const pixels = Buffer.alloc(height * stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const out = y * stride;
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? pixels[out + x - channels] : 0;
      const b = y > 0 ? pixels[out + x - stride] : 0;
      const c = x >= channels && y > 0 ? pixels[out + x - stride - channels] : 0;
      let v = line[x];
      if (filter === 1) v += a;
      else if (filter === 2) v += b;
      else if (filter === 3) v += (a + b) >> 1;
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      pixels[out + x] = v & 0xff;
    }
  }

  const rgba = Buffer.alloc(width * height * 4);
  for (let i = 0, j = 0; i < width * height; i++, j += channels) {
    rgba[i * 4] = pixels[j];
    rgba[i * 4 + 1] = pixels[j + 1];
    rgba[i * 4 + 2] = pixels[j + 2];
    rgba[i * 4 + 3] = channels === 4 ? pixels[j + 3] : 255;
  }
  return { width, height, rgba };
}

// ---------- Обработка ----------

// Уменьшение с усреднением по площади — без «лесенки» и муара
function cropResize(img, crop, size) {
  const sx0 = crop.x * img.width;
  const sy0 = crop.y * img.height;
  const scale = (crop.size * Math.min(img.width, img.height)) / size;
  const out = Buffer.alloc(size * size * 4);

  for (let dy = 0; dy < size; dy++) {
    const y0 = sy0 + dy * scale, y1 = y0 + scale;
    for (let dx = 0; dx < size; dx++) {
      const x0 = sx0 + dx * scale, x1 = x0 + scale;
      let r = 0, g = 0, b = 0, a = 0, total = 0;
      for (let sy = Math.floor(y0); sy < Math.ceil(y1); sy++) {
        const wy = Math.min(y1, sy + 1) - Math.max(y0, sy);
        if (sy < 0 || sy >= img.height || wy <= 0) continue;
        for (let sx = Math.floor(x0); sx < Math.ceil(x1); sx++) {
          const wx = Math.min(x1, sx + 1) - Math.max(x0, sx);
          if (sx < 0 || sx >= img.width || wx <= 0) continue;
          const w = wx * wy;
          const i = (sy * img.width + sx) * 4;
          const alpha = img.rgba[i + 3] * w;
          r += img.rgba[i] * alpha;
          g += img.rgba[i + 1] * alpha;
          b += img.rgba[i + 2] * alpha;
          a += alpha;
          total += w;
        }
      }
      const o = (dy * size + dx) * 4;
      if (a > 0) {
        out[o] = Math.round(r / a);
        out[o + 1] = Math.round(g / a);
        out[o + 2] = Math.round(b / a);
        out[o + 3] = Math.round(a / total);
      }
    }
  }
  return out;
}

// Скруглённые углы со сглаживанием
function roundCorners(rgba, size, radius) {
  const r = radius * size;
  const ss = 4;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const nearCorner = (x < r || x > size - r) && (y < r || y > size - r);
      if (!nearCorner) continue;
      let inside = 0;
      for (let sy = 0; sy < ss; sy++) {
        for (let sx = 0; sx < ss; sx++) {
          const px = x + (sx + 0.5) / ss;
          const py = y + (sy + 0.5) / ss;
          const qx = Math.max(Math.abs(px - size / 2) - (size / 2 - r), 0);
          const qy = Math.max(Math.abs(py - size / 2) - (size / 2 - r), 0);
          if (qx * qx + qy * qy <= r * r) inside++;
        }
      }
      const i = (y * size + x) * 4 + 3;
      rgba[i] = Math.round((rgba[i] * inside) / (ss * ss));
    }
  }
  return rgba;
}

function render(img, size, crop) {
  return roundCorners(cropResize(img, crop, size), size, CORNER_RADIUS);
}

// ---------- PNG / ICO: запись ----------

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

function encodePng(rgba, size) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function encodeIco(images) {
  const header = Buffer.alloc(6 + 16 * images.length);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(images.length, 4);
  let offset = header.length;
  images.forEach(({ size, png }, i) => {
    const e = 6 + 16 * i;
    header[e] = size >= 256 ? 0 : size;
    header[e + 1] = size >= 256 ? 0 : size;
    header.writeUInt16LE(1, e + 4);
    header.writeUInt16LE(32, e + 6);
    header.writeUInt32LE(png.length, e + 8);
    header.writeUInt32LE(offset, e + 12);
    offset += png.length;
  });
  return Buffer.concat([header, ...images.map((im) => im.png)]);
}

// ---------- Сборка ----------

const img = decodePng(fs.readFileSync(SOURCE));
const cropFor = (size) => (size <= 48 ? CLOSE_CROP : FULL_CROP);
const pngOf = (size, crop = cropFor(size)) => encodePng(render(img, size, crop), size);

const appIco = encodeIco([16, 20, 24, 32, 40, 48, 64, 96, 128, 256].map((size) => ({ size, png: pngOf(size) })));
const trayIco = encodeIco([16, 20, 24, 32, 40, 48].map((size) => ({ size, png: pngOf(size, CLOSE_CROP) })));

fs.mkdirSync(path.join(root, 'build'), { recursive: true });
fs.writeFileSync(path.join(root, 'assets', 'icon.png'), pngOf(512));
fs.writeFileSync(path.join(root, 'assets', 'icon-small.png'), pngOf(64, CLOSE_CROP));
fs.writeFileSync(path.join(root, 'assets', 'icon.ico'), appIco);
fs.writeFileSync(path.join(root, 'assets', 'tray.ico'), trayIco);
fs.writeFileSync(path.join(root, 'build', 'icon.ico'), appIco);
fs.rmSync(path.join(root, 'assets', 'tray.png'), { force: true });

console.log('Иконки созданы: assets/icon.png, icon-small.png, icon.ico, tray.ico, build/icon.ico');
