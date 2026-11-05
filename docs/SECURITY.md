# S-Way security architecture

S-Way is a static, client-side application. There is no server API, no database, no accounts and no upload endpoint, so the classic server attack surface (API abuse, server-side parser exploits, stored documents, credential theft) does not exist. The remaining risks are: hostile files attacking the visitor's browser, resource exhaustion on the visitor's device, cross-site scripting through untrusted names/text, framing/clickjacking, supply-chain compromise of bundled libraries, data lingering in the browser, and misconfiguration of the static host. Each section of the security specification is mapped below to the control that implements it.

## 1. Defence in depth — where each layer lives

| Layer | Control | Code |
|---|---|---|
| Browser | CSP (meta + headers), frame guard, safe DOM, no storage, object-URL revocation | `index.html`, `js/ui/frame-guard.js`, `js/dom.js`, `js/security/blob-registry.js` |
| Upload validation | allowlist, magic bytes, MIME check, filename inspection, sizes, image header dimensions, PDF structure, ZIP/DOCX safety, TXT encoding | `js/security/validation.js`, `zip-reader.js`, `image-header.js`, `sanitize.js` |
| Processing isolation | heavy work in Web Workers (analysis, PDF.js, Tesseract); workers are terminated on timeout/cancel | `js/core/orchestrator.js`, `js/core/analysis-worker.js`, `js/engines/extract.js` |
| Resource protection | page/size/pixel/character limits, render scale cap, OCR page budget, per-step and per-job timeouts, bounded queue, rate limiting | `js/config.js`, `js/security/resource-limits.js`, `js/security/rate-limiter.js` |
| Lifecycle | in-memory only, zeroing + dropping buffers, idle auto-clear, clear-on-tab-close, Clear Session | `js/core/state.js`, `js/ui/privacy.js`, `js/app.js` |
| Host | security headers, HTTPS/HSTS, read-only nginx, no directory listing, non-root container | `deployment/` , `tools/serve.mjs` |
| Supply chain | vendored, pinned libraries; npm audit, pip-audit, bandit, ruff, secret scan | `vendor-src/`, `requirements.txt`, CI workflow |

## 2. Anonymous access and abuse prevention

- **No accounts.** No login, password, profile or cookie exists.
- **Identifiers.** Documents, reports and jobs use 128-bit (documents) / 64-bit (jobs, reports) identifiers from `crypto.getRandomValues` — never timestamps or counters. They are scoped to one tab's memory; there is no endpoint at which a guessed identifier could retrieve another person's data. (The specification's "use Python's `secrets` module" maps to the Web Crypto CSPRNG.)
- **Rate limiting** (`SlidingWindowLimiter`): separate sliding windows for analysis 5/10 min, upload 10/10 min, OCR 10/10 min, expensive visual/ML work 5/10 min, exports 10/10 min. Exceeding a limit raises a `RateLimitError` with `status = 429` and `retryAfterSec`, shown as *"Too many analysis requests. Please wait before trying again."* No limiter state is exposed beyond the remaining count in the Privacy Center.
  - **Honest scope:** with no server, these limits protect the visitor's own device and tab from runaway or scripted repeat work. They are not an abuse control for shared infrastructure — there is none to protect. If S-Way ever gains an API, server-side/edge limits are mandatory (§2.4 of the spec); this module would not suffice.
- **Concurrency & queue** (`JobQueue`): 1 running job, 2 pending, duplicate submissions refused by fingerprint, queue waiting time limited to 60 s, cancellation supported, cleanup always runs in `finally`. Worker health: a crashed worker rejects its pending calls and is recreated on next use. Retries are user-initiated only.
- **No IP addresses** are processed or stored anywhere.

## 3. Upload validation

Pipeline (every file, before any parser sees it):

1. **Filename**: NFC-normalised; rejected if empty, > 1024 chars, containing NUL, bidi-override characters (extension spoofing such as `invoice‮fdp.exe`), `..`/`.` path segments, absolute or drive paths, or no extension. Control and zero-width characters are stripped for display; names are truncated to 120 chars. The name is only ever displayed via `textContent` and never used as a path or key — documents are keyed by random IDs.
2. **Extension allowlist**: pdf, png, jpg/jpeg, webp, docx, txt. Executables, scripts, HTML, SVG, archives, legacy/macro Office formats and other images get specific rejection messages.
3. **Size**: empty files rejected; > 15 MB rejected (a file *declaring* more than 15 MB is not read at all); batch limits 10 files / 40 MB.
4. **Content signature** (authoritative): `%PDF-`, PNG 8-byte signature, JPEG SOI, RIFF…WEBP, ZIP local header for DOCX; detection of PE/ELF/Mach-O executables, OLE (legacy/encrypted Office), gzip, RAR, 7z, GIF, BMP, HTML/SVG markup and shebang scripts. The extension must match the signature.
5. **MIME** (supplementary): if the browser reports a type, it must match the detected format (`''` and `application/octet-stream` are neutral).
6. **Format checks**:
   - *Images*: width/height read from the header (PNG IHDR, JPEG SOF, WEBP VP8/VP8L/VP8X) **before decoding**; limit 10,000 × 10,000 and 40 MP — this stops decompression-bomb images. Truncated PNGs (no IEND) rejected; truncated JPEGs warned.
   - *PDF*: `%%EOF` required; encrypted PDFs rejected; JavaScript, automatic actions, launch actions, embedded files, rich media/XFA are detected and reported as ignored. Page count > 50 → *page limit exceeded* (checked with PDF.js at upload time).
   - *DOCX*: the custom ZIP reader parses the central directory first and rejects: > 1000 entries, > 100 MB total expansion, > 50 MB per entry, compression ratio > 100:1 (entries ≥ 64 KB), overall suspicious ratio, traversal/absolute/backslash/NUL entry names, symlinks, duplicate names, encryption, ZIP64, multi-disk, unknown compression, overlapping entries (Fifield-style bombs), lying sizes (decompression is capped at the declared size and verified by CRC-32). Missing `[Content_Types].xml`/`word/document.xml` → malformed; `vbaProject.bin` or macro-enabled content types → rejected. Nested archives are never opened (depth 1). XML containing `<!DOCTYPE` or `<!ENTITY` is refused before parsing (no XXE / billion-laughs).
   - *TXT*: strict UTF-8 or BOM-marked UTF-16; NUL bytes or > 1 % control characters → rejected; > 2,000,000 characters → resource limit.
7. **Statuses**: Accepted; Rejected: unsupported format / invalid file signature / size exceeded / malformed document / unsafe archive / page limit exceeded / processing resource limit exceeded. Nothing that fails is silently accepted; rejected bytes are dropped from memory immediately.

## 4. Resource limits

- **CPU**: all analysis in one worker, one job at a time, OCR in its own worker; per-step timeouts (parse 20 s, page render 15 s, OCR 60 s/page, extraction 30 s, preprocessing 30 s, module 45 s, signature 20 s) and a 120 s job ceiling. On timeout the worker is **terminated** (real cancellation), the job is marked timed out, cleanup runs, and a plain message is shown.
- **Memory**: header-checked pixel budget; PDFs processed page by page; render scale ≤ 2.5 and longest side ≤ 1800 px; only the first 5 pages per document kept as images; canvases released immediately (`width = 0`); OCR input ≤ 2400 px; OCR page budget 30 per analysis; extracted text ≤ 2 M chars.
- **PDF.js hardening**: `enableScripting: false`, `enableXfa: false`, `disableFontFace: true` (untrusted font programs never reach the browser font engine), no streaming/range/auto-fetch, `useSystemFonts: false`, image size cap, canvas area cap, annotations not rendered.
- **Models**: no model can be downloaded at runtime. The only artifact (`models/calibration.json`) is loaded from the same origin and must match the SHA-256 in `models/model_manifest.json`; otherwise defaults are used.
- **Container** (optional self-hosting): non-root nginx, read-only filesystem, tmpfs, dropped capabilities, `no-new-privileges`, memory/CPU/PID limits (`deployment/Dockerfile`).

## 5–6. Lifecycle and report access

There is no temporary *disk* storage and no server workspace. Each document exists as an in-memory `Uint8Array` inside the tab. Cleanup paths: removal of a document; job success/failure/cancel/timeout (OCR worker terminated, analysis worker terminated on abort); Clear Current Session; 30-minute idle timer; `pagehide`. Buffers are zeroed before references are dropped and all object URLs are revoked. Reports are never given URLs: they live in memory and are exported as in-memory downloads; the browser's print dialog produces the PDF.

**Secure-deletion limitation:** JavaScript cannot guarantee physical erasure. Garbage collection timing, OS paging/swap, crash dumps and the browser's own caches are outside S-Way's control. S-Way minimises retention instead.

## 7. Browser security

- **CSP (meta, works on GitHub Pages):** `default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' blob: data:; font-src 'self'; connect-src 'self'; worker-src 'self'; manifest-src 'self'; object-src 'none'; frame-src 'none'; media-src 'none'; base-uri 'self'; form-action 'none'`. No `unsafe-inline`, no `unsafe-eval`. Header variant (deployment) adds `frame-ancestors 'none'`, `upgrade-insecure-requests` and `'wasm-unsafe-eval'` (needed because header CSP also governs the OCR/PDF workers, which compile WebAssembly; it does not permit JavaScript `eval`).
- **No HTML sinks:** a unit test fails the build if any app file uses `innerHTML`, `outerHTML`, `insertAdjacentHTML`, `document.write`, `eval`, `new Function` or string `setTimeout`. The DOM builder refuses `on*` attributes and unsafe URL schemes.
- **Untrusted text** (filenames, OCR output, document text, PDF metadata) is rendered with `textContent`; highlights are built from offsets as text nodes inside `<mark>`. E2E tests inject `<img onerror>`/`<script>` through filenames and document text.
- **Framing:** JavaScript frame guard (replaces the page when framed) + `frame-ancestors 'none'`/`X-Frame-Options: DENY` where headers are available.
- **Storage:** no cookies, localStorage or sessionStorage writes (unit-tested); IndexedDB only for opt-in saved reports; Tesseract `cacheMethod: 'none'` so language data is not cached in IndexedDB.
- **Notebook viewer:** notebooks are fetched only from `notebooks/` by a strict filename pattern; Markdown is rendered by a DOM-based subset renderer (no HTML), HTML outputs are never rendered (plain-text fallback), and only base64 PNG figures are shown. External links in notebooks are shown as text.
- **Exports:** CSV cells beginning with `= + - @ TAB CR` are prefixed with `'` (formula injection); download filenames are sanitised.
- **Permissions:** no camera, microphone, location, clipboard or notifications are requested.

## 8. Network security

The app performs **no network requests** except fetching its own static files (including, on request, the bundled sample documents in `assets/samples/` and the executed notebooks for the Research viewer). `connect-src 'self'` enforces this; a unit test forbids external URLs, `XMLHttpRequest`, `WebSocket` and `sendBeacon` in app code; the E2E suite fails if any request leaves the origin; the Privacy Center lists every origin contacted. HTTPS is required in production (GitHub Pages enforces it); HSTS is sent only where the host is configured for HTTPS.

## 9. Third parties

No external service receives any data. Bundled libraries: PDF.js 6.5.438, Tesseract.js 7.0.0 + core 7.0.0 + `eng` best_int data, Chart.js 4.6.1, Special Elite and Courier Prime fonts — pinned in `vendor-src/package.json` and served locally (`npm audit`: 0 vulnerabilities). No API keys exist; `.env.example` documents that none are needed.

## 10. Logging

S-Way writes nothing to any log. Console output is limited to two generic messages (`View failed to render`, `UI update failed`) and never contains document content, names or identifiers. The optional dev server and nginx config disable access logs.

## 11. Supply chain

`npm audit` on the pinned vendor sources, `pip-audit` on research requirements (Pillow pinned ≥ 13.0.0 after advisories against 12.3.0), `bandit`, `ruff`, and `tools/secret_scan.py` run in CI (`.github/workflows/ci-and-pages.yml`). See `SECURITY_AUDIT.md` for results.

## Residual risks

1. **GitHub Pages cannot send headers**: no HSTS from S-Way itself (Pages handles HTTPS), no `frame-ancestors` (JS guard instead — ineffective if JavaScript is disabled, but then S-Way does nothing), no `Permissions-Policy`.
2. **Bundled parsers** (PDF.js, Tesseract, the browser's own image decoders) process hostile input. Mitigated by validation, isolation in workers, disabled scripting/fonts and timeouts, but a zero-day in a decoder is possible. Keep `vendor/` updated.
3. **Client-side rate limits** can be bypassed by a user against their own device — acceptable, since only their own device is affected.
4. **Memory remanence** as described under *Secure-deletion limitation*.
5. **Malicious browser extensions** can read any page's content; S-Way cannot defend against a compromised browser.
6. **Saved reports** (opt-in) are unencrypted in IndexedDB.
