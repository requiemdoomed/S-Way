# Testing

All results below were produced by actually running the suites for release 1.1.0 on 4 November 2026 (Node 22, Python 3.13, Chromium 153 via Playwright 1.63, Linux).

## How to run

```bash
python3 tools/make_fixtures.py          # regenerate controlled test files (harmless "attack" files included)
npm test                                 # 84 unit tests  (node --test tests/unit/*.test.mjs)
python3 -m pytest tests/e2e -q           # 29 browser tests (Playwright, Chromium)
python3 tools/build_notebooks.py         # re-executes the 7 research notebooks (~6 min)
python3 tools/secret_scan.py
bandit -q -r tools notebooks/sway_research.py -c pyproject.toml
ruff check tools notebooks/sway_research.py tests/e2e
pip-audit -r requirements.txt
(cd vendor-src && npm audit)
```

Re-vendoring the browser libraries: `cd vendor-src && npm ci`, then copy the files listed in `docs/ARCHITECTURE.md` into `vendor/` (PDF.js `build/pdf.min.mjs`, `pdf.worker.min.mjs`, `standard_fonts/`, `cmaps/`, `wasm/` without QuickJS; Tesseract.js `dist/tesseract.min.js`, `dist/worker.min.js`; tesseract.js-core 7 `*-lstm.wasm.js`; `@tesseract.js-data/eng/4.0.0_best_int/eng.traineddata.gz`; Chart.js `dist/chart.umd.min.js`; the two Fontsource woff2 sets).

## Results summary

| Suite | Tests | Passed | Failed |
|---|---:|---:|---:|
| `tests/unit/security.test.mjs` — upload validation, archives, filenames, rate limiting, queue/timeouts | 45 | 45 | 0 |
| `tests/unit/engines.test.mjs` — text, style, imaging, preprocessing, handwriting, signature, layout, anomaly, source, fusion | 23 | 23 | 0 |
| `tests/unit/privacy.test.mjs` — CSV injection, export stripping, calibration digest, limits, static code rules | 9 | 9 | 0 |
| `tests/unit/vision.test.mjs` — homography, perspective correction, copy-move detection & false alarms, edge-hinge/white-run features | 7 | 7 | 0 |
| `tests/e2e/test_app.py` — browser security, uploads, XSS, workflows, OCR, labs, clearing, rate limit, cancel, 11 routes, mobile, theme, sample sets, photo rectification + tamper flag, notebook viewer | 29 | 29 | 0 |
| **Total automated** | **113** | **113** | **0** |

## What is covered

### Functional
Valid PDF/DOCX/TXT/PNG/JPEG/WEBP uploads; multiple documents; empty, corrupted, oversized, multi-page and over-limit documents; documents with no readable text (signature images); OCR on a scanned page (asserts "Industrial Revolution" is read); text correction with the original preserved and restorable; complete analysis → report; JSON and CSV export contents; session clearing; cancellation of a running OCR job; all ten routes render without console errors.

### Security (browser)
- No cookies, localStorage, sessionStorage or IndexedDB after load; CSP present with no `unsafe-inline`/`unsafe-eval`.
- CSP actually blocks an injected inline script and a `fetch` to another origin.
- **Every** request in **every** browser test is checked; any request leaving the origin fails the test.
- Clickjacking: the app replaces itself with a warning when framed.
- Malicious uploads rejected in the real UI: executable disguised as PDF, ZIP bomb DOCX, archive traversal, decompression-bomb PNG dimensions, HTML, macro DOCX, corrupted PDF, 55-page PDF.
- XSS through a filename (`<img src=x onerror=…>.txt`) and through document text (`<script>` and `<img onerror>` inside a TXT) is rendered as inert text.
- Rate limiting shows the specified message after 11 uploads in 10 minutes.
- After *Clear current session*: no documents, no blob images remain.
- Reports contain no accusatory verdicts ("forged", "cheated", "signature is authentic" …).

### Security (unit)
Spoofed MIME, renamed executables (PE/ELF), PNG renamed JPG, HTML renamed TXT, binary TXT, SVG, standalone ZIP, truncated PNG, corrupt PDF, ZIP bomb, ratio bomb, traversal entry, > 1000 entries, macros, symlink entry, non-Word ZIP, oversized file, > 2 M characters, batch count and total size, traversal/null-byte/bidi/absolute filenames, CRC and lying-size decompression caps, sliding-window limiter with Retry-After, separate budgets, timeouts with abort hooks, cancellation, bounded queue with duplicate refusal and guaranteed cleanup; CSV formula injection; static rules forbidding HTML sinks, `eval`, cookies, storage writes and external URLs.

### Computer vision (v1.1)
Homography exactness; corner detection on a simulated phone photo (each corner within 25 px of ground truth); rectified page yields the same number of text lines as the flat scan; flat scans and white-background images are left alone; copy-move pasted region found with correct source/copy positions and correlation > 0.95; **no false alarms** on scans, handwriting or signatures; edge-hinge histograms normalised and separating synthetic writers. In the browser: OCR confidence ≥ 85 % on the tilted phone photo, duplicated region flagged with a figure in the report.

### Machine-learning evaluation
See `MODEL_CARD.md` and the executed notebooks (`notebooks/01`–`05`): precision/recall/F1, confusion matrices, false-positive/false-negative analysis, AUC/EER, writer-disjoint splits, robustness to degradations, OCR CER/WER.

## Performance (measured, headless Chromium, 8-core Linux VM)

| Scenario | Result |
|---|---|
| Initial page load (HTML transfer 7 KB) | DOMContentLoaded 172 ms; app interactive ≈ 0.23 s |
| 3 text documents (TXT, DOCX, 2-page PDF), all modules | 1.5 s end-to-end |
| 3 scanned images with OCR, all modules | 7.3 s (OCR ≈ 1.6 s per page; copy-move ≈ 0.3 s per page) |
| Phone photo + tampered page + scan, all modules | 7.1 s (incl. perspective correction before OCR) |
| 3 handwriting pages + 2 signatures, all modules | 6.0 s |
| 10 mixed documents (the maximum), all modules | 7.6 s |

The UI stays responsive throughout: analysis runs in a Web Worker and OCR/PDF parsing in their own workers. Lower-end phones will be several times slower; the 120 s job ceiling and per-step timeouts bound the worst case.

## Not automated / not executed

- No JavaScript unit-test runner beyond Node's built-in `node:test` was added (no npm dependencies needed).
- Cross-browser runs (Firefox, Safari) were not executed — only Chromium was available.
- Container-level limits (Dockerfile) were not built or tested in this environment (no Docker daemon).
- Deployed-site tests (HTTPS, live headers) cannot run until the site is deployed; see the checklist in `deployment/deployment-guide.md`.
