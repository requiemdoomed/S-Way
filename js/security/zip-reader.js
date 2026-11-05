/**
 * Minimal, defensive ZIP reader used for DOCX packages.
 *
 * Why a custom reader: it lets S-Way inspect the archive's central directory and
 * enforce every limit (entry count, sizes, compression ratio, traversal, symlinks,
 * overlapping entries, encryption) BEFORE a single byte is decompressed, and then
 * decompress only the specific XML parts it needs with a hard output cap.
 * Nothing is ever written to disk; archives inside archives are never opened.
 */
import { ARCHIVE_LIMITS } from '../config.js';

export class ArchiveError extends Error {
  constructor(message, code = 'unsafe_archive') {
    super(message);
    this.name = 'ArchiveError';
    this.code = code; // 'unsafe_archive' | 'malformed'
  }
}

const SIG_EOCD = 0x06054b50;
const SIG_CEN = 0x02014b50;
const SIG_LOC = 0x04034b50;
const NESTED_ARCHIVE = /\.(zip|jar|docx|docm|xlsx|xlsm|pptx|pptm|7z|rar|gz|tar|cab|bin)$/i;

const u16 = (b, o) => b[o] | (b[o + 1] << 8);
const u32 = (b, o) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;

/** Validate a ZIP entry path. Returns a reason string if unsafe. */
export function unsafeEntryPath(name) {
  if (!name) return 'empty entry name';
  if (name.includes('\u0000')) return 'null byte in entry name';
  if (name.includes('\\')) return 'backslash in entry name';
  if (name.startsWith('/')) return 'absolute entry path';
  if (/^[a-zA-Z]:/.test(name)) return 'drive-letter entry path';
  if (name.split('/').some((s) => s === '..')) return 'path traversal in entry name';
  return null;
}

/**
 * Parse and validate the central directory.
 * @param {Uint8Array} b
 * @param {object} [limits]
 * @returns {{entries: Array, totalUncompressed: number, nested: string[]}}
 */
export function readZipDirectory(b, limits = ARCHIVE_LIMITS) {
  if (b.length < 22) throw new ArchiveError('The archive is truncated.', 'malformed');

  let eocd = -1;
  for (let i = b.length - 22; i >= Math.max(0, b.length - 22 - 65535); i--) {
    if (u32(b, i) === SIG_EOCD) { eocd = i; break; }
  }
  if (eocd < 0) throw new ArchiveError('The archive has no end-of-directory record.', 'malformed');

  const diskNo = u16(b, eocd + 4);
  const cdDisk = u16(b, eocd + 6);
  const countDisk = u16(b, eocd + 8);
  const count = u16(b, eocd + 10);
  const cdSize = u32(b, eocd + 12);
  const cdOffset = u32(b, eocd + 16);

  if (diskNo !== 0 || cdDisk !== 0 || countDisk !== count) throw new ArchiveError('Multi-part archives are not supported.');
  if (count === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) throw new ArchiveError('ZIP64 archives are not supported.');
  if (count > limits.maxEntries) throw new ArchiveError(`The archive has ${count} entries (limit ${limits.maxEntries}).`);
  if (cdOffset + cdSize > eocd) throw new ArchiveError('The archive directory points outside the file.', 'malformed');

  const decoder = new TextDecoder('utf-8', { fatal: false });
  const entries = [];
  const names = new Set();
  const nested = [];
  let total = 0;
  let p = cdOffset;

  for (let i = 0; i < count; i++) {
    if (p + 46 > b.length || u32(b, p) !== SIG_CEN) throw new ArchiveError('The archive directory is corrupt.', 'malformed');
    const madeBy = u16(b, p + 4);
    const flags = u16(b, p + 8);
    const method = u16(b, p + 10);
    const crc = u32(b, p + 16);
    const compSize = u32(b, p + 20);
    const size = u32(b, p + 24);
    const nameLen = u16(b, p + 28);
    const extraLen = u16(b, p + 30);
    const commentLen = u16(b, p + 32);
    const extAttr = u32(b, p + 38);
    const localOffset = u32(b, p + 42);
    const name = decoder.decode(b.subarray(p + 46, p + 46 + nameLen));
    p += 46 + nameLen + extraLen + commentLen;

    const pathProblem = unsafeEntryPath(name);
    if (pathProblem) throw new ArchiveError(`Unsafe archive entry: ${pathProblem}.`);
    if (names.has(name)) throw new ArchiveError('The archive contains duplicate entry names.');
    names.add(name);
    if (flags & 0x1) throw new ArchiveError('Encrypted archive entries are not supported.');
    if (method !== 0 && method !== 8) throw new ArchiveError('The archive uses an unsupported compression method.');
    const hostOs = madeBy >>> 8;
    if (hostOs === 3 && ((extAttr >>> 16) & 0o170000) === 0o120000) throw new ArchiveError('The archive contains a symbolic link.');
    if (size === 0xffffffff || compSize === 0xffffffff) throw new ArchiveError('ZIP64 entries are not supported.');
    if (size > limits.maxEntryUncompressed) throw new ArchiveError('An archive entry expands beyond the per-entry size limit.');
    if (method === 8 && size >= limits.ratioCheckMinBytes && size / Math.max(compSize, 1) > limits.maxCompressionRatio) {
      throw new ArchiveError('An archive entry has a suspicious compression ratio (possible decompression bomb).');
    }
    if (method === 0 && size !== compSize) throw new ArchiveError('A stored archive entry has inconsistent sizes.', 'malformed');
    total += size;
    if (total > limits.maxTotalUncompressed) throw new ArchiveError('The archive expands beyond the total size limit.');
    if (NESTED_ARCHIVE.test(name)) nested.push(name);
    entries.push({ name, method, crc, compSize, size, localOffset, isDir: name.endsWith('/') });
  }

  // Locate data and reject overlapping entries (a known zip-bomb construction).
  const ranges = [];
  for (const e of entries) {
    const lo = e.localOffset;
    if (lo + 30 > cdOffset || u32(b, lo) !== SIG_LOC) throw new ArchiveError('An archive entry header is corrupt.', 'malformed');
    e.dataStart = lo + 30 + u16(b, lo + 26) + u16(b, lo + 28);
    if (e.dataStart + e.compSize > cdOffset) throw new ArchiveError('An archive entry extends outside the file.', 'malformed');
    ranges.push([lo, e.dataStart + e.compSize]);
  }
  ranges.sort((a, c) => a[0] - c[0]);
  for (let i = 1; i < ranges.length; i++) {
    if (ranges[i][0] < ranges[i - 1][1]) throw new ArchiveError('The archive contains overlapping entries (possible decompression bomb).');
  }
  if (total > 0 && b.length > 0 && total / b.length > limits.maxCompressionRatio && total > limits.ratioCheckMinBytes * 16) {
    throw new ArchiveError('The archive has a suspicious overall compression ratio.');
  }

  return { entries, totalUncompressed: total, nested };
}

let CRC_TABLE;
export function crc32(data) {
  if (!CRC_TABLE) {
    CRC_TABLE = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      CRC_TABLE[n] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (let i = 0; i < data.length; i++) crc = CRC_TABLE[(crc ^ data[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/**
 * Decompress one entry with a hard output cap. The cap is the smaller of the declared
 * size and maxBytes, so an archive that lies about its sizes is still stopped.
 * @returns {Promise<Uint8Array>}
 */
export async function extractEntry(b, entry, maxBytes = ARCHIVE_LIMITS.maxEntryUncompressed) {
  const cap = Math.min(entry.size, maxBytes);
  const raw = b.subarray(entry.dataStart, entry.dataStart + entry.compSize);
  let out;
  if (entry.method === 0) {
    out = raw.slice();
  } else {
    const ds = new DecompressionStream('deflate-raw');
    const writer = ds.writable.getWriter();
    writer.write(raw).catch(() => {});
    writer.close().catch(() => {});
    const reader = ds.readable.getReader();
    const chunks = [];
    let got = 0;
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        got += value.length;
        if (got > cap) {
          await reader.cancel().catch(() => {});
          throw new ArchiveError('An archive entry expanded beyond its declared size (possible decompression bomb).');
        }
        chunks.push(value);
      }
    } catch (err) {
      if (err instanceof ArchiveError) throw err;
      throw new ArchiveError('An archive entry could not be decompressed.', 'malformed');
    }
    out = new Uint8Array(got);
    let o = 0;
    for (const c of chunks) { out.set(c, o); o += c.length; }
  }
  if (out.length !== entry.size) throw new ArchiveError('An archive entry has an incorrect size.', 'malformed');
  if (crc32(out) !== entry.crc) throw new ArchiveError('An archive entry failed its integrity check.', 'malformed');
  return out;
}
