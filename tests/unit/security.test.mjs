// Security unit tests: upload validation, archive safety, filenames, rate limiting, queue.
// Run: node --test tests/unit
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { validateFile, checkBatch, detectSignature, STATUS } from '../../js/security/validation.js';
import { inspectFilename, secureId, cleanExtractedText } from '../../js/security/sanitize.js';
import { readZipDirectory, unsafeEntryPath, extractEntry, ArchiveError } from '../../js/security/zip-reader.js';
import { SlidingWindowLimiter, RateLimitError, RATE_LIMIT_MESSAGE } from '../../js/security/rate-limiter.js';
import { JobQueue, withTimeout, TimeoutError, QueueFullError, DuplicateJobError, CancelledError, CancelToken } from '../../js/security/resource-limits.js';

const FX = (name) => fileURLToPath(new URL(`../fixtures/${name}`, import.meta.url));
const load = (name, type = '') => ({ name, type, bytes: new Uint8Array(readFileSync(FX(name))) });
const MIME = {
  pdf: 'application/pdf', png: 'image/png', jpg: 'image/jpeg', webp: 'image/webp', txt: 'text/plain',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
};
const loadTyped = (name) => load(name, MIME[name.split('.').pop()] || '');

// ---------- accepted files ----------
for (const name of ['essay_a.txt', 'essay_b.docx', 'essay_a.pdf', 'scan_a.png', 'scan_a.jpg', 'scan_a.webp', 'too_many_pages.pdf']) {
  test(`accepts valid ${name}`, async () => {
    const r = await validateFile(loadTyped(name));
    assert.equal(r.status, STATUS.ACCEPTED, r.message);
  });
}

test('image dimensions are read from the header', async () => {
  const r = await validateFile(loadTyped('scan_a.webp'));
  assert.deepEqual([r.details.width, r.details.height], [1240, 1754]);
  const j = await validateFile(loadTyped('scan_a.jpg'));
  assert.deepEqual([j.details.width, j.details.height], [1240, 1754]);
});

// ---------- rejected files ----------
const cases = [
  ['fake_pdf.pdf', 'application/pdf', STATUS.SIGNATURE, 'executable disguised as PDF'],
  ['renamed_exe.txt', 'text/plain', STATUS.SIGNATURE, 'renamed executable'],
  ['png_named.jpg', 'image/jpeg', STATUS.SIGNATURE, 'PNG renamed to JPG'],
  ['corrupt.pdf', 'application/pdf', STATUS.MALFORMED, 'corrupted PDF'],
  ['truncated.png', 'image/png', STATUS.MALFORMED, 'truncated PNG'],
  ['script.html', 'text/html', STATUS.UNSUPPORTED, 'HTML'],
  ['html_as.txt', 'text/plain', STATUS.SIGNATURE, 'HTML renamed to TXT'],
  ['image.svg', 'image/svg+xml', STATUS.UNSUPPORTED, 'SVG'],
  ['archive.zip', 'application/zip', STATUS.UNSUPPORTED, 'standalone ZIP'],
  ['empty.txt', 'text/plain', STATUS.MALFORMED, 'empty file'],
  ['binary.txt', 'text/plain', STATUS.SIGNATURE, 'binary data as TXT'],
  ['huge_dimensions.png', 'image/png', STATUS.RESOURCE, 'decompression-bomb dimensions'],
  ['zip_bomb.docx', MIME.docx, STATUS.ARCHIVE, 'ZIP bomb'],
  ['ratio_bomb.docx', MIME.docx, STATUS.ARCHIVE, 'compression-ratio bomb'],
  ['traversal.docx', MIME.docx, STATUS.ARCHIVE, 'archive path traversal'],
  ['too_many_entries.docx', MIME.docx, STATUS.ARCHIVE, 'excessive archive entries'],
  ['macro.docx', MIME.docx, STATUS.ARCHIVE, 'macro-enabled document'],
  ['symlink.docx', MIME.docx, STATUS.ARCHIVE, 'symlink entry'],
  ['not_word.docx', MIME.docx, STATUS.MALFORMED, 'zip that is not a Word document'],
];
for (const [name, type, status, label] of cases) {
  test(`rejects ${label} (${name})`, async () => {
    const r = await validateFile(load(name, type));
    assert.equal(r.status, status, r.message);
    assert.equal(r.accepted, false);
    assert.ok(r.message.length > 5);
  });
}

test('rejects spoofed MIME type that disagrees with content', async () => {
  const r = await validateFile(load('essay_a.pdf', 'application/x-msdownload'));
  assert.equal(r.status, STATUS.SIGNATURE);
});

test('rejects oversized file', async () => {
  const bytes = new Uint8Array(15 * 1024 * 1024 + 1).fill(0x61);
  const r = await validateFile({ name: 'big.txt', type: 'text/plain', bytes });
  assert.equal(r.status, STATUS.SIZE);
});

test('rejects text beyond the extracted-character limit', async () => {
  const bytes = new Uint8Array(2_000_100).fill(0x61);
  const r = await validateFile({ name: 'long.txt', type: 'text/plain', bytes });
  assert.equal(r.status, STATUS.RESOURCE);
});

test('batch limits: file count and combined size', () => {
  assert.equal(checkBatch(Array(9).fill(1), [1]).ok, true);
  assert.equal(checkBatch(Array(10).fill(1), [1]).ok, false);
  assert.equal(checkBatch([30 * 1048576], [11 * 1048576]).ok, false);
});

// ---------- filenames ----------
test('filename: traversal, null bytes, bidi tricks and absolute paths are rejected', () => {
  for (const bad of ['../../etc/passwd.txt', '..\\..\\boot.ini.txt', 'a\u0000.txt', 'invoice\u202Etxt.exe', '/etc/x.txt', 'C:\\x.txt', '', 'noext', 'trailing.']) {
    assert.equal(inspectFilename(bad).ok, false, `should reject ${JSON.stringify(bad)}`);
  }
});

test('filename: normal names pass, control characters stripped, long names truncated', () => {
  assert.equal(inspectFilename('Essay final (v2).pdf').displayName, 'Essay final (v2).pdf');
  assert.equal(inspectFilename('a\u200Bb.txt').displayName, 'ab.txt');
  const long = inspectFilename(`${'x'.repeat(300)}.pdf`);
  assert.ok(long.displayName.length <= 120 && long.displayName.endsWith('.pdf'));
  assert.equal(inspectFilename('<img src=x onerror=alert(1)>.txt').ok, true); // safe: only ever rendered as text
});

test('secure ids are random 128-bit hex', () => {
  const a = secureId();
  const b = secureId();
  assert.match(a, /^[0-9a-f]{32}$/);
  assert.notEqual(a, b);
});

test('extracted text has control and bidi characters removed', () => {
  assert.equal(cleanExtractedText('a\u0000b\u202Ec\r\nd'), 'abc\nd');
  assert.equal(cleanExtractedText('abcdef', 3), 'abc');
});

test('detectSignature identifies disguised formats', () => {
  assert.equal(detectSignature(new Uint8Array([0x4d, 0x5a, 0, 0])), 'executable');
  assert.equal(detectSignature(new Uint8Array([0x7f, 0x45, 0x4c, 0x46])), 'executable');
  assert.equal(detectSignature(new TextEncoder().encode('<svg onload=x>')), 'markup');
  assert.equal(detectSignature(new TextEncoder().encode('#!/bin/sh')), 'script');
});

// ---------- archives ----------
test('zip entry path checks', () => {
  assert.ok(unsafeEntryPath('../a'));
  assert.ok(unsafeEntryPath('a/../../b'));
  assert.ok(unsafeEntryPath('/abs'));
  assert.ok(unsafeEntryPath('C:/x'));
  assert.ok(unsafeEntryPath('a\\b'));
  assert.equal(unsafeEntryPath('word/document.xml'), null);
});

test('valid docx entries extract with CRC verification and size cap', async () => {
  const b = new Uint8Array(readFileSync(FX('essay_b.docx')));
  const dir = readZipDirectory(b);
  const doc = dir.entries.find((e) => e.name === 'word/document.xml');
  const xml = new TextDecoder().decode(await extractEntry(b, doc));
  assert.match(xml, /Industrial Revolution/);
  await assert.rejects(extractEntry(b, doc, 100), ArchiveError);
});

test('archive with lying size header is stopped during decompression', async () => {
  const b = new Uint8Array(readFileSync(FX('essay_b.docx')));
  const dir = readZipDirectory(b);
  const doc = dir.entries.find((e) => e.name === 'word/document.xml');
  await assert.rejects(extractEntry(b, { ...doc, size: 50 }), /expanded beyond|incorrect size/);
});

// ---------- rate limiting ----------
test('sliding window limiter enforces limits and reports Retry-After', () => {
  let t = 0;
  const lim = new SlidingWindowLimiter({ analysis: { limit: 5, windowMs: 600_000 } }, () => t);
  for (let i = 0; i < 5; i++) lim.consume('analysis');
  assert.throws(() => lim.consume('analysis'), (e) => e instanceof RateLimitError && e.status === 429 && e.retryAfterSec === 600 && e.message === RATE_LIMIT_MESSAGE);
  t = 300_000;
  assert.equal(lim.peek('analysis').retryAfterSec, 300);
  t = 600_001;
  assert.doesNotThrow(() => lim.consume('analysis'));
});

test('separate operations have separate budgets', () => {
  const lim = new SlidingWindowLimiter({ ocr: { limit: 1, windowMs: 1000 }, export: { limit: 1, windowMs: 1000 } }, () => 0);
  lim.consume('ocr');
  assert.doesNotThrow(() => lim.consume('export'));
  assert.throws(() => lim.consume('ocr'), RateLimitError);
});

// ---------- queue, timeouts, cancellation ----------
test('timeouts fire and run the abort hook', async () => {
  let aborted = false;
  await assert.rejects(withTimeout(new Promise(() => {}), 30, 'OCR', { onAbort: () => { aborted = true; } }), TimeoutError);
  assert.ok(aborted);
});

test('cancellation rejects and runs the abort hook', async () => {
  const token = new CancelToken();
  let aborted = false;
  const p = withTimeout(new Promise(() => {}), 10_000, 'x', { token, onAbort: () => { aborted = true; } });
  token.cancel();
  await assert.rejects(p, CancelledError);
  assert.ok(aborted);
});

test('queue is bounded, refuses duplicates, and always cleans up', async () => {
  const q = new JobQueue({ maxConcurrent: 1, maxPending: 1, maxWaitMs: 10_000 });
  const cleaned = [];
  let release;
  const gate = new Promise((r) => { release = r; });
  const j1 = q.submit('a', () => gate, () => cleaned.push('a'));
  assert.throws(() => q.submit('a', async () => 1), DuplicateJobError);
  const j2 = q.submit('b', async () => { throw new Error('boom'); }, () => cleaned.push('b'));
  assert.throws(() => q.submit('c', async () => 1), QueueFullError);
  release(42);
  assert.equal(await j1.promise, 42);
  await assert.rejects(j2.promise, /boom/);
  assert.deepEqual(cleaned, ['a', 'b']);
  assert.equal(q.stats.cleanupOk, 2);
  assert.equal(q.size, 0);
});

test('queue cancellation cleans up running jobs', async () => {
  const q = new JobQueue();
  let cleaned = false;
  const job = q.submit('x', (token) => withTimeout(new Promise(() => {}), 10_000, 'x', { token }), () => { cleaned = true; });
  q.cancel(job.id);
  await assert.rejects(job.promise, CancelledError);
  assert.ok(cleaned);
});
