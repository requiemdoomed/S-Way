// Privacy & static-safety tests: exports, calibration integrity, and source-code rules.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { csvCell, exportableReport } from '../../js/core/export.js';
import { UPLOAD_LIMITS, RATE_LIMITS, TIMEOUTS, QUEUE_LIMITS } from '../../js/config.js';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const walk = (dir) => readdirSync(dir).flatMap((f) => {
  const p = join(dir, f);
  return statSync(p).isDirectory() ? walk(p) : [p];
});
const appJs = walk(join(ROOT, 'js')).filter((f) => f.endsWith('.js'));
const src = Object.fromEntries(appJs.map((f) => [f.replace(ROOT, ''), readFileSync(f, 'utf8')]));

test('CSV export neutralises spreadsheet formula injection', () => {
  assert.equal(csvCell('=HYPERLINK("http://x")'), `"'=HYPERLINK(""http://x"")"`);
  assert.equal(csvCell('+1'), "'+1");
  assert.equal(csvCell('@SUM(A1)'), "'@SUM(A1)");
  assert.equal(csvCell('-2'), "'-2");
  assert.equal(csvCell('a,b'), '"a,b"');
  assert.equal(csvCell(null), '');
});

test('exported reports drop image data, masks and difference maps', () => {
  const r = exportableReport({ a: 1, results: { signature: { pairs: [{ diffMap: new Uint8Array(4), imageA: { data: new Uint8ClampedArray(3) }, metrics: { ssim: 0.5 } }] } }, mask: new Uint8Array(2) });
  const s = JSON.stringify(r);
  assert.ok(!s.includes('diffMap') && !s.includes('imageA') && !s.includes('mask'));
  assert.equal(r.results.signature.pairs[0].metrics.ssim, 0.5);
});

test('calibration artifact matches the SHA-256 recorded in the model manifest', () => {
  const manifest = JSON.parse(readFileSync(join(ROOT, 'models/model_manifest.json'), 'utf8'));
  const entry = manifest.artifacts.find((a) => a.file === 'calibration.json');
  const digest = createHash('sha256').update(readFileSync(join(ROOT, 'models/calibration.json'))).digest('hex');
  assert.equal(digest, entry.sha256);
  assert.deepEqual(manifest.neural_models, []);
});

test('security limits match the specification defaults', () => {
  assert.equal(UPLOAD_LIMITS.maxFileBytes, 15 * 1048576);
  assert.equal(UPLOAD_LIMITS.maxFilesPerAnalysis, 10);
  assert.equal(UPLOAD_LIMITS.maxCombinedBytes, 40 * 1048576);
  assert.equal(UPLOAD_LIMITS.maxPdfPages, 50);
  assert.equal(UPLOAD_LIMITS.maxImageWidth, 10000);
  assert.equal(UPLOAD_LIMITS.maxExtractedChars, 2_000_000);
  assert.equal(UPLOAD_LIMITS.maxDocxExpandedBytes, 100 * 1048576);
  assert.equal(TIMEOUTS.jobMs, 120_000);
  assert.deepEqual([RATE_LIMITS.analysis.limit, RATE_LIMITS.upload.limit, RATE_LIMITS.ocr.limit, RATE_LIMITS.ml.limit, RATE_LIMITS.export.limit], [5, 10, 10, 5, 10]);
  assert.ok(QUEUE_LIMITS.maxConcurrentJobs <= 2);
});

test('application code never uses HTML-injection sinks or dynamic code evaluation', () => {
  for (const [file, code] of Object.entries(src)) {
    const stripped = code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    assert.ok(!/\.(innerHTML|outerHTML)\s*=|insertAdjacentHTML|document\.write\(/.test(stripped), `${file} uses an HTML sink`);
    assert.ok(!/\beval\(|new Function\(/.test(stripped), `${file} evaluates code`);
    assert.ok(!/setTimeout\(\s*['"`]/.test(stripped), `${file} passes a string to setTimeout`);
  }
});

test('application code sets no cookies and writes no web storage', () => {
  for (const [file, code] of Object.entries(src)) {
    assert.ok(!/document\.cookie\s*=(?!=)/.test(code), `${file} writes a cookie`);
    assert.ok(!/(localStorage|sessionStorage)\.setItem/.test(code), `${file} writes web storage`);
  }
});

test('application code contacts no external hosts', () => {
  for (const [file, code] of Object.entries(src)) {
    const urls = code.match(/https?:\/\/[^\s'"`)]+/g) || [];
    const external = urls.filter((u) => !u.startsWith('http://www.w3.org/') && !u.startsWith('http://schemas.openxmlformats.org/'));
    assert.deepEqual(external, [], `${file} references ${external.join(', ')}`);
    assert.ok(!/navigator\.sendBeacon|XMLHttpRequest|WebSocket\(/.test(code), `${file} uses a network API`);
  }
});

test('only same-origin relative fetches exist (calibration, notebooks, bundled samples)', () => {
  const fetches = Object.entries(src).flatMap(([f, c]) => (c.match(/fetch\(([^,)]+)/g) || []).map((m) => `${f}: ${m}`));
  assert.ok(fetches.length > 0);
  for (const f of fetches) assert.match(f, /fetch\(['`](models\/|notebooks\/|assets\/samples\/)/, f);
});

test('index.html has a strict CSP, no inline script and no external resources', () => {
  const html = readFileSync(join(ROOT, 'index.html'), 'utf8');
  assert.match(html, /Content-Security-Policy/);
  assert.ok(!/<script>(?!\s*<\/script>)/.test(html.replace(/<script [^>]*src=[^>]*><\/script>/g, '')), 'inline script found');
  assert.ok(!/\son[a-z]+=/i.test(html), 'inline event handler found');
  assert.ok(!/(src|href)="https?:\/\//.test(html), 'external resource found');
  assert.ok(!/style="/.test(html), 'inline style attribute (blocked by CSP) found');
});
