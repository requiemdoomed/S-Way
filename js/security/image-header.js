/**
 * Read image dimensions straight from the file header, BEFORE any decoding.
 *
 * This is the decompression-bomb guard for images: a 30 KB PNG can declare
 * 50,000 × 50,000 pixels and exhaust memory when decoded. We reject such files
 * from their header alone, so the browser never attempts the decode.
 */

const u16be = (b, o) => (b[o] << 8) | b[o + 1];
const u32be = (b, o) => ((b[o] << 24) >>> 0) + ((b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]);
const u16le = (b, o) => b[o] | (b[o + 1] << 8);
const u24le = (b, o) => b[o] | (b[o + 1] << 8) | (b[o + 2] << 16);
const ascii = (b, o, n) => String.fromCharCode(...b.subarray(o, o + n));

/** @returns {{ok:true,width:number,height:number,warnings:string[]}|{ok:false,reason:string}} */
export function readImageHeader(kind, bytes) {
  try {
    if (kind === 'png') return readPng(bytes);
    if (kind === 'jpeg') return readJpeg(bytes);
    if (kind === 'webp') return readWebp(bytes);
    return { ok: false, reason: 'Not an image format.' };
  } catch {
    return { ok: false, reason: 'The image header could not be read.' };
  }
}

function readPng(b) {
  if (b.length < 33) return { ok: false, reason: 'The PNG file is truncated.' };
  if (u32be(b, 8) !== 13 || ascii(b, 12, 4) !== 'IHDR') return { ok: false, reason: 'The PNG file has no valid IHDR header.' };
  const width = u32be(b, 16);
  const height = u32be(b, 20);
  const bitDepth = b[24];
  const colorType = b[25];
  if (![1, 2, 4, 8, 16].includes(bitDepth) || ![0, 2, 3, 4, 6].includes(colorType)) {
    return { ok: false, reason: 'The PNG header declares an invalid pixel format.' };
  }
  const tail = ascii(b, Math.max(0, b.length - 12), Math.min(12, b.length));
  if (!tail.includes('IEND')) return { ok: false, reason: 'The PNG file is truncated (no end marker).' };
  return finish(width, height, []);
}

function readJpeg(b) {
  let o = 2;
  const warnings = [];
  while (o + 9 < b.length) {
    if (b[o] !== 0xff) { o += 1; continue; }
    const marker = b[o + 1];
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0xff) { o += 2; continue; }
    if (marker === 0xd9 || marker === 0xda) break; // EOI / start of scan before a frame header
    const len = u16be(b, o + 2);
    if (len < 2) return { ok: false, reason: 'The JPEG file has a corrupt segment.' };
    const isSof = (marker >= 0xc0 && marker <= 0xcf) && ![0xc4, 0xc8, 0xcc].includes(marker);
    if (isSof) {
      const height = u16be(b, o + 5);
      const width = u16be(b, o + 7);
      let hasEoi = false;
      for (let i = b.length - 2; i >= Math.max(0, b.length - 65536); i--) {
        if (b[i] === 0xff && b[i + 1] === 0xd9) { hasEoi = true; break; }
      }
      if (!hasEoi) warnings.push('The JPEG file appears truncated; parts of the image may be missing.');
      return finish(width, height, warnings);
    }
    o += 2 + len;
  }
  return { ok: false, reason: 'The JPEG file has no frame header.' };
}

function readWebp(b) {
  if (b.length < 30) return { ok: false, reason: 'The WEBP file is truncated.' };
  const riffSize = b[4] | (b[5] << 8) | (b[6] << 16) | (b[7] << 24);
  if (riffSize + 8 > b.length + 1) return { ok: false, reason: 'The WEBP file is truncated.' };
  const chunk = ascii(b, 12, 4);
  const d = 20;
  if (chunk === 'VP8 ') {
    if (b[d + 3] !== 0x9d || b[d + 4] !== 0x01 || b[d + 5] !== 0x2a) return { ok: false, reason: 'The WEBP frame header is invalid.' };
    return finish(u16le(b, d + 6) & 0x3fff, u16le(b, d + 8) & 0x3fff, []);
  }
  if (chunk === 'VP8L') {
    if (b[d] !== 0x2f) return { ok: false, reason: 'The WEBP lossless header is invalid.' };
    const bits = b[d + 1] | (b[d + 2] << 8) | (b[d + 3] << 16) | (b[d + 4] << 24);
    return finish((bits & 0x3fff) + 1, ((bits >>> 14) & 0x3fff) + 1, []);
  }
  if (chunk === 'VP8X') {
    return finish(u24le(b, d + 4) + 1, u24le(b, d + 7) + 1, b[d] & 0x02 ? ['Animated WEBP: only the first frame is analysed.'] : []);
  }
  return { ok: false, reason: 'The WEBP file uses an unknown encoding.' };
}

function finish(width, height, warnings) {
  if (!width || !height) return { ok: false, reason: 'The image declares zero width or height.' };
  return { ok: true, width, height, warnings };
}
