// Minimal PNG → grayscale decoder for Node (tests and the research CLI only; the
// browser uses its own decoder). Supports 8-bit, non-interlaced gray/RGB/RGBA/gray-alpha.
import { readFileSync } from 'node:fs';
import { inflateSync } from 'node:zlib';

export function decodePngGray(pathOrBuf) {
  const buf = typeof pathOrBuf === 'string' ? readFileSync(pathOrBuf) : pathOrBuf;
  let o = 8;
  let width = 0; let height = 0; let colorType = 0; let bitDepth = 0; let interlace = 0;
  const idat = [];
  while (o < buf.length) {
    const len = buf.readUInt32BE(o);
    const type = buf.toString('ascii', o + 4, o + 8);
    const data = buf.subarray(o + 8, o + 8 + len);
    if (type === 'IHDR') { width = data.readUInt32BE(0); height = data.readUInt32BE(4); bitDepth = data[8]; colorType = data[9]; interlace = data[12]; }
    if (type === 'IDAT') idat.push(data);
    if (type === 'IEND') break;
    o += 12 + len;
  }
  if (bitDepth !== 8 || interlace) throw new Error('Unsupported PNG (need 8-bit, non-interlaced)');
  const channels = { 0: 1, 2: 3, 4: 2, 6: 4 }[colorType];
  if (!channels) throw new Error('Unsupported PNG colour type');
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const px = new Uint8Array(height * stride);
  let prev = new Uint8Array(stride);
  for (let y = 0; y < height; y++) {
    const f = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const cur = new Uint8Array(stride);
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? cur[x - channels] : 0;
      const b = prev[x];
      const c = x >= channels ? prev[x - channels] : 0;
      let v = line[x];
      if (f === 1) v += a;
      else if (f === 2) v += b;
      else if (f === 3) v += (a + b) >> 1;
      else if (f === 4) { const p = a + b - c; const pa = Math.abs(p - a); const pb = Math.abs(p - b); const pc = Math.abs(p - c); v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c; }
      cur[x] = v & 255;
    }
    px.set(cur, y * stride);
    prev = cur;
  }
  const data = new Uint8ClampedArray(width * height);
  for (let i = 0; i < width * height; i++) {
    const j = i * channels;
    data[i] = channels <= 2 ? px[j] : 0.299 * px[j] + 0.587 * px[j + 1] + 0.114 * px[j + 2];
  }
  return { width, height, data };
}
