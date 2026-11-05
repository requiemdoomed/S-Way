/**
 * Filename and identifier security.
 *
 * S-Way never uses an uploaded filename as a storage path (there is no storage).
 * The original name is only ever *displayed*, after sanitisation, via textContent.
 * Internally every document is referenced by an unpredictable random identifier.
 */
import { UPLOAD_LIMITS } from '../config.js';

/** Cryptographically secure random identifier (128 bits, hex). */
export function secureId(bytes = 16) {
  const buf = new Uint8Array(bytes);
  globalThis.crypto.getRandomValues(buf);
  return Array.from(buf, (b) => b.toString(16).padStart(2, '0')).join('');
}

// C0/C1 control characters, bidi overrides (used to disguise extensions such as
// "invoice‮fdp.exe"), zero-width characters and the byte-order mark.
// eslint-disable-next-line no-control-regex
const UNSAFE_CHARS = /[\u0000-\u001F\u007F-\u009F​-‏‪-‮⁦-⁩﻿]/g;

/**
 * Inspect an uploaded filename.
 * @returns {{ok: boolean, reason?: string, displayName?: string, ext?: string}}
 */
export function inspectFilename(raw) {
  if (typeof raw !== 'string' || raw.length === 0) return { ok: false, reason: 'The file has no name.' };
  if (raw.length > 1024) return { ok: false, reason: 'The file name is unreasonably long.' };
  if (raw.includes('\u0000')) return { ok: false, reason: 'The file name contains a null byte.' };
  if (/[‪-‮⁦-⁩]/.test(raw)) {
    return { ok: false, reason: 'The file name contains hidden direction-override characters often used to disguise file types.' };
  }

  const normalized = raw.normalize('NFC');
  // Reject traversal-style names outright rather than silently "fixing" them.
  const segments = normalized.split(/[\\/]+/);
  if (segments.some((s) => s === '..' || s === '.')) {
    return { ok: false, reason: 'The file name contains a path traversal sequence.' };
  }
  if (/^[a-zA-Z]:/.test(normalized) || normalized.startsWith('/') || normalized.startsWith('\\')) {
    return { ok: false, reason: 'The file name contains an absolute path.' };
  }

  // Keep only the final path component, strip unsafe characters.
  let base = segments[segments.length - 1].replace(UNSAFE_CHARS, '').trim();
  base = base.replace(/^\.+/, ''); // no hidden-file style leading dots
  if (!base) return { ok: false, reason: 'The file name is empty after removing unsafe characters.' };

  const dot = base.lastIndexOf('.');
  if (dot <= 0 || dot === base.length - 1) return { ok: false, reason: 'The file has no extension.' };
  const ext = base.slice(dot + 1).toLowerCase();
  if (!/^[a-z0-9]{1,8}$/.test(ext)) return { ok: false, reason: 'The file extension is not valid.' };

  let displayName = base;
  const max = UPLOAD_LIMITS.maxDisplayNameLength;
  if (displayName.length > max) {
    displayName = `${displayName.slice(0, max - ext.length - 2)}….${ext}`;
  }
  return { ok: true, displayName, ext };
}

/** Text taken from documents is untrusted; strip control characters before display/analysis. */
export function cleanExtractedText(text, maxChars) {
  let t = String(text ?? '');
  // eslint-disable-next-line no-control-regex
  t = t.replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F‪-‮⁦-⁩]/g, '');
  if (maxChars && t.length > maxChars) t = t.slice(0, maxChars);
  return t;
}
