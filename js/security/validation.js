/**
 * Upload-validation service (security specification section 3).
 *
 * Every file passes this pipeline before any analysis engine sees it:
 *   1. filename inspection (traversal, null bytes, bidi tricks, extension)
 *   2. extension allowlist
 *   3. size limits (empty, per-file)
 *   4. content signature (magic bytes) — the source of truth
 *   5. extension ↔ signature agreement
 *   6. declared MIME ↔ signature agreement (supplementary only)
 *   7. format-specific structural checks (image header dimensions, PDF
 *      structure / encryption / active content, DOCX archive safety, TXT encoding)
 *
 * Batch-level limits (file count, combined size) are enforced by validateBatch().
 * The PDF page-count limit is enforced when PDF.js opens the document
 * (see engines/extract.js) because counting pages requires parsing.
 */
import { UPLOAD_LIMITS, FORMATS, NEUTRAL_MIMES } from '../config.js';
import { inspectFilename } from './sanitize.js';
import { readImageHeader } from './image-header.js';
import { readZipDirectory, extractEntry, ArchiveError } from './zip-reader.js';

export const STATUS = Object.freeze({
  ACCEPTED: 'accepted',
  UNSUPPORTED: 'rejected_unsupported_format',
  SIGNATURE: 'rejected_invalid_signature',
  SIZE: 'rejected_size_exceeded',
  MALFORMED: 'rejected_malformed_document',
  ARCHIVE: 'rejected_unsafe_archive',
  PAGES: 'rejected_page_limit_exceeded',
  RESOURCE: 'rejected_resource_limit_exceeded',
});

export const STATUS_LABEL = Object.freeze({
  [STATUS.ACCEPTED]: 'Accepted',
  [STATUS.UNSUPPORTED]: 'Rejected: unsupported format',
  [STATUS.SIGNATURE]: 'Rejected: invalid file signature',
  [STATUS.SIZE]: 'Rejected: size exceeded',
  [STATUS.MALFORMED]: 'Rejected: malformed document',
  [STATUS.ARCHIVE]: 'Rejected: unsafe archive',
  [STATUS.PAGES]: 'Rejected: page limit exceeded',
  [STATUS.RESOURCE]: 'Rejected: processing resource limit exceeded',
});

const EXT_TO_KIND = {};
for (const [kind, f] of Object.entries(FORMATS)) for (const e of f.exts) EXT_TO_KIND[e] = kind;

/** Known dangerous/unsupported types get a specific explanation. */
const KNOWN_REJECTS = {
  exe: 'Executable programs', dll: 'Program libraries', bat: 'Batch scripts', cmd: 'Command scripts',
  com: 'Executable programs', msi: 'Installers', ps1: 'PowerShell scripts', sh: 'Shell scripts',
  js: 'JavaScript files', mjs: 'JavaScript files', vbs: 'VBScript files', jar: 'Java archives',
  html: 'HTML pages', htm: 'HTML pages', xhtml: 'HTML pages', svg: 'SVG images (they can contain scripts)',
  zip: 'ZIP archives', rar: 'RAR archives', '7z': '7-Zip archives', gz: 'Compressed archives', tar: 'Archives',
  doc: 'Legacy Word documents', docm: 'Macro-enabled Word documents', dotm: 'Macro-enabled templates',
  xls: 'Spreadsheets', xlsx: 'Spreadsheets', xlsm: 'Spreadsheets', ppt: 'Presentations', pptx: 'Presentations',
  rtf: 'Rich-text documents', odt: 'OpenDocument files', gif: 'GIF images', bmp: 'BMP images', tif: 'TIFF images', tiff: 'TIFF images', heic: 'HEIC images',
};

const startsWith = (b, sig, offset = 0) => sig.every((v, i) => b[offset + i] === v);

/** Identify a file purely from its bytes. */
export function detectSignature(b) {
  if (!b || b.length === 0) return 'empty';
  if (startsWith(b, [0x25, 0x50, 0x44, 0x46, 0x2d])) return 'pdf'; // %PDF-
  if (startsWith(b, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'png';
  if (startsWith(b, [0xff, 0xd8, 0xff])) return 'jpeg';
  if (startsWith(b, [0x52, 0x49, 0x46, 0x46]) && startsWith(b, [0x57, 0x45, 0x42, 0x50], 8)) return 'webp';
  if (startsWith(b, [0x50, 0x4b, 0x03, 0x04]) || startsWith(b, [0x50, 0x4b, 0x05, 0x06])) return 'zip';
  if (startsWith(b, [0x4d, 0x5a])) return 'executable'; // MZ (Windows PE)
  if (startsWith(b, [0x7f, 0x45, 0x4c, 0x46])) return 'executable'; // ELF
  if (startsWith(b, [0xcf, 0xfa, 0xed, 0xfe]) || startsWith(b, [0xfe, 0xed, 0xfa, 0xcf]) || startsWith(b, [0xca, 0xfe, 0xba, 0xbe])) return 'executable'; // Mach-O
  if (startsWith(b, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])) return 'ole'; // legacy Office / encrypted OOXML
  if (startsWith(b, [0x1f, 0x8b])) return 'gzip';
  if (startsWith(b, [0x52, 0x61, 0x72, 0x21])) return 'rar';
  if (startsWith(b, [0x37, 0x7a, 0xbc, 0xaf])) return '7z';
  if (startsWith(b, [0x47, 0x49, 0x46, 0x38])) return 'gif';
  if (startsWith(b, [0x42, 0x4d])) return 'bmp';
  // Text-like: check the first bytes for markup that must never be treated as a document.
  const head = new TextDecoder('utf-8', { fatal: false }).decode(b.subarray(0, 512)).replace(/^﻿/, '').trimStart().toLowerCase();
  if (/^(<!doctype html|<html|<script|<svg|<\?xml[^>]*>\s*<svg)/.test(head)) return 'markup';
  if (head.startsWith('#!')) return 'script';
  return 'txt';
}

const SIGNATURE_DESCRIPTION = {
  executable: 'an executable program', ole: 'a legacy or encrypted Office file', gzip: 'a compressed archive',
  rar: 'a RAR archive', '7z': 'a 7-Zip archive', gif: 'a GIF image', bmp: 'a BMP image', markup: 'HTML/SVG markup',
  script: 'a script', zip: 'a ZIP archive', pdf: 'a PDF', png: 'a PNG image', jpeg: 'a JPEG image', webp: 'a WEBP image', txt: 'plain text',
};

function reject(status, message, extra = {}) {
  return { status, accepted: false, message, warnings: [], ...extra };
}

/**
 * Validate one file's bytes.
 * @param {{name: string, size: number, type: string, bytes: Uint8Array}} file
 */
export async function validateFile(file, limits = UPLOAD_LIMITS) {
  const fn = inspectFilename(file.name);
  if (!fn.ok) return reject(STATUS.UNSUPPORTED, fn.reason, { displayName: 'Unnamed file' });
  const { displayName, ext } = fn;
  const base = { displayName, ext };

  const kind = EXT_TO_KIND[ext];
  if (!kind) {
    const what = KNOWN_REJECTS[ext];
    return reject(STATUS.UNSUPPORTED, what ? `${what} are not supported. Use PDF, PNG, JPEG, WEBP, DOCX or TXT.` : `".${ext}" files are not supported. Use PDF, PNG, JPEG, WEBP, DOCX or TXT.`, base);
  }

  const bytes = file.bytes;
  const size = bytes ? bytes.length : 0;
  if (size === 0) return reject(STATUS.MALFORMED, 'The file is empty.', base);
  if (size > limits.maxFileBytes) {
    return reject(STATUS.SIZE, `The file is ${(size / 1048576).toFixed(1)} MB; the limit is ${limits.maxFileBytes / 1048576} MB.`, base);
  }

  const detected = detectSignature(bytes);
  const expected = kind === 'docx' ? 'zip' : kind;
  if (detected !== expected) {
    const found = SIGNATURE_DESCRIPTION[detected] || 'an unrecognised format';
    return reject(STATUS.SIGNATURE, `The file is named ".${ext}" but its contents are ${found}.`, base);
  }

  const declared = String(file.type || '').toLowerCase().split(';')[0].trim();
  if (!NEUTRAL_MIMES.includes(declared) && !FORMATS[kind].mimes.includes(declared)) {
    return reject(STATUS.SIGNATURE, `The browser reports this file as "${declared}", which does not match its ${FORMATS[kind].label} contents.`, base);
  }

  const result = { status: STATUS.ACCEPTED, accepted: true, message: 'Accepted', warnings: [], kind, size, displayName, ext, details: {} };
  if (!declared) result.warnings.push('The browser did not report a file type; the type was determined from the contents.');

  if (kind === 'png' || kind === 'jpeg' || kind === 'webp') return checkImage(kind, bytes, result, limits);
  if (kind === 'pdf') return checkPdf(bytes, result);
  if (kind === 'docx') return checkDocx(bytes, result, limits);
  return checkTxt(bytes, result, limits);
}

function checkImage(kind, bytes, result, limits) {
  const hdr = readImageHeader(kind, bytes);
  if (!hdr.ok) return reject(STATUS.MALFORMED, hdr.reason, { displayName: result.displayName, ext: result.ext });
  const { width, height } = hdr;
  if (width > limits.maxImageWidth || height > limits.maxImageHeight || width * height > limits.maxImagePixels) {
    return reject(STATUS.RESOURCE, `The image is ${width} × ${height} pixels; the limit is ${limits.maxImageWidth} × ${limits.maxImageHeight} (${limits.maxImagePixels / 1e6} megapixels).`, { displayName: result.displayName, ext: result.ext });
  }
  result.details = { width, height };
  result.warnings.push(...hdr.warnings);
  if (Math.min(width, height) < 200) result.warnings.push('The image resolution is very low; visual analysis may be unreliable.');
  return result;
}

const latin1 = (b) => {
  let s = '';
  for (let i = 0; i < b.length; i += 8192) s += String.fromCharCode(...b.subarray(i, i + 8192));
  return s;
};

function checkPdf(bytes, result) {
  const tail = latin1(bytes.subarray(Math.max(0, bytes.length - 2048)));
  if (!tail.includes('%%EOF')) {
    return reject(STATUS.MALFORMED, 'The PDF is incomplete or corrupted (no end-of-file marker).', { displayName: result.displayName, ext: result.ext });
  }
  const body = latin1(bytes);
  if (/\/Encrypt\s*\d+\s+\d+\s+R|\/Encrypt\s*<</.test(body)) {
    return reject(STATUS.MALFORMED, 'Password-protected or encrypted PDFs are not supported.', { displayName: result.displayName, ext: result.ext });
  }
  const active = [];
  if (/\/(JavaScript|JS)\b/.test(body)) active.push('JavaScript');
  if (/\/OpenAction\b|\/AA\b/.test(body)) active.push('automatic actions');
  if (/\/Launch\b/.test(body)) active.push('launch actions');
  if (/\/EmbeddedFiles?\b/.test(body)) active.push('embedded attachments');
  if (/\/RichMedia\b|\/XFA\b/.test(body)) active.push('rich media / forms');
  if (active.length) {
    result.warnings.push(`The PDF contains ${active.join(', ')}. These are ignored: S-Way never executes or opens embedded content.`);
    result.details.activeContent = active;
  }
  const version = /^%PDF-(\d\.\d)/.exec(latin1(bytes.subarray(0, 16)));
  result.details.pdfVersion = version ? version[1] : 'unknown';
  return result;
}

async function checkDocx(bytes, result, limits) {
  const back = { displayName: result.displayName, ext: result.ext };
  let dir;
  try {
    dir = readZipDirectory(bytes, {
      maxEntries: 1000,
      maxTotalUncompressed: limits.maxDocxExpandedBytes,
      maxEntryUncompressed: Math.min(50 * 1048576, limits.maxDocxExpandedBytes),
      maxCompressionRatio: 100,
      ratioCheckMinBytes: 64 * 1024,
    });
  } catch (err) {
    if (err instanceof ArchiveError) return reject(err.code === 'malformed' ? STATUS.MALFORMED : STATUS.ARCHIVE, err.message, back);
    return reject(STATUS.MALFORMED, 'The DOCX file could not be read.', back);
  }
  const names = new Set(dir.entries.map((e) => e.name));
  if (!names.has('[Content_Types].xml') || !names.has('word/document.xml')) {
    return reject(STATUS.MALFORMED, 'The file is a ZIP archive but not a valid Word document (missing required parts).', back);
  }
  if ([...names].some((n) => /vbaProject\.bin$|vbaData\.xml$/i.test(n))) {
    return reject(STATUS.ARCHIVE, 'The document contains macros. Macro-enabled documents are not accepted.', back);
  }
  try {
    const ctEntry = dir.entries.find((e) => e.name === '[Content_Types].xml');
    if (ctEntry.size > 1048576) return reject(STATUS.ARCHIVE, 'The document package manifest is unreasonably large.', back);
    const ct = new TextDecoder().decode(await extractEntry(bytes, ctEntry, 1048576));
    if (/macroEnabled/i.test(ct)) return reject(STATUS.ARCHIVE, 'The document is macro-enabled. Macro-enabled documents are not accepted.', back);
    if (!/wordprocessingml\.document\.main\+xml|wordprocessingml\.template\.main\+xml/.test(ct)) {
      return reject(STATUS.MALFORMED, 'The package is not a Word document.', back);
    }
  } catch (err) {
    return reject(err instanceof ArchiveError && err.code !== 'malformed' ? STATUS.ARCHIVE : STATUS.MALFORMED, err.message || 'The DOCX manifest is corrupt.', back);
  }
  if ([...names].some((n) => n.startsWith('word/embeddings/'))) result.warnings.push('Embedded objects were found and are ignored.');
  if (dir.nested.length) result.warnings.push('Nested archives were found inside the document and are ignored (never opened).');
  result.details = { entries: dir.entries.length, expandedBytes: dir.totalUncompressed };
  return result;
}

function checkTxt(bytes, result, limits) {
  const back = { displayName: result.displayName, ext: result.ext };
  let text;
  try {
    if (bytes[0] === 0xff && bytes[1] === 0xfe) text = new TextDecoder('utf-16le', { fatal: true }).decode(bytes.subarray(2));
    else if (bytes[0] === 0xfe && bytes[1] === 0xff) text = new TextDecoder('utf-16be', { fatal: true }).decode(bytes.subarray(2));
    else {
      if (bytes.includes(0)) return reject(STATUS.SIGNATURE, 'The file contains binary data and is not plain text.', back);
      text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    }
  } catch {
    return reject(STATUS.MALFORMED, 'The text file is not valid UTF-8 or UTF-16 text.', back);
  }
  text = text.replace(/^﻿/, '');
  let control = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if ((c < 32 && c !== 9 && c !== 10 && c !== 13) || c === 127) control++;
  }
  if (text.length && control / text.length > 0.01) return reject(STATUS.SIGNATURE, 'The file contains too many control characters to be plain text.', back);
  if (text.length > limits.maxExtractedChars) {
    return reject(STATUS.RESOURCE, `The text has ${text.length.toLocaleString()} characters; the limit is ${limits.maxExtractedChars.toLocaleString()}.`, back);
  }
  if (!text.trim()) result.warnings.push('The text file contains no readable text.');
  result.details = { characters: text.length };
  return result;
}

/**
 * Batch limits: number of files and combined size, counting files already accepted.
 * @param {number[]} existingSizes sizes of already-accepted files
 * @param {number[]} newSizes sizes of incoming files
 */
export function checkBatch(existingSizes, newSizes, limits = UPLOAD_LIMITS) {
  const count = existingSizes.length + newSizes.length;
  if (count > limits.maxFilesPerAnalysis) {
    return { ok: false, status: STATUS.RESOURCE, message: `An analysis can include at most ${limits.maxFilesPerAnalysis} files.` };
  }
  const total = [...existingSizes, ...newSizes].reduce((a, c) => a + c, 0);
  if (total > limits.maxCombinedBytes) {
    return { ok: false, status: STATUS.SIZE, message: `The combined upload would be ${(total / 1048576).toFixed(1)} MB; the limit is ${limits.maxCombinedBytes / 1048576} MB.` };
  }
  return { ok: true };
}
