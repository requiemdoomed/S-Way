# S-Way architecture

**S-Way (SmartWay): Intelligent Document Authenticity and Authorship Analysis System** — Swayam Shakya

## Design decision: no backend

The original specification described a FastAPI backend. At the author's direction S-Way was built as a **fully client-side web application** (HTML, CSS, JavaScript) plus a separate **Jupyter research environment**. This has one decisive privacy consequence: documents are never transmitted anywhere. Every control from the security specification was re-mapped to the place where the risk now lives — the visitor's browser and the static host (see `SECURITY.md`).

```
┌──────────────────────────── Browser tab ────────────────────────────┐
│ index.html (+ meta CSP, frame guard)                                  │
│                                                                       │
│  UI views (js/ui/*)  ── safe DOM builder (js/dom.js, textContent only)│
│        │                                                              │
│  Upload validation (js/security/*)                                    │
│   filename → allowlist → size → magic bytes → MIME → structure        │
│   (image header dims, PDF structure, ZIP/DOCX archive safety, TXT)    │
│        │ accepted bytes kept in memory only                           │
│  Orchestrator (js/core/orchestrator.js)                               │
│   rate limiter · bounded JobQueue · timeouts · cancellation · cleanup │
│        │                                                              │
│  ├─ Extraction (main thread)                                          │
│  │   PDF.js worker (no scripting, no font loading)                    │
│  │   Tesseract WASM worker (OCR, local language data, no caching)     │
│  │   DOCX via defensive ZIP reader + DOMParser (no DTD/entities)      │
│  └─ Analysis Web Worker (js/core/analysis-worker.js)                  │
│      preprocess · text · style · handwriting · signature · source ·   │
│      layout · anomaly            (terminated on timeout/cancel)       │
│        │                                                              │
│  Evidence fusion (js/core/fusion.js) → report (in memory)             │
│  Exports: print-to-PDF, JSON, CSV (formula-safe), PNG overlays        │
└───────────────────────────────────────────────────────────────────────┘
          ▲ static files only (GET), all from the same origin
┌─────────┴──────────┐        ┌──────────────── offline ───────────────┐
│ Static host         │        │ Jupyter notebooks (notebooks/*.ipynb)   │
│ GitHub Pages / any  │        │ call the SAME JS engines via            │
│ static server       │        │ tools/sway-cli.mjs → models/calibration │
└────────────────────┘        └─────────────────────────────────────────┘
```

## Repository layout

| Path | Purpose |
|---|---|
| `index.html` | App shell, CSP meta tag, navigation, decorative typewriter template |
| `css/` | `theme.css` tokens (daylight/lamplight), `layout.css`, `components.css`, `views.css`, `print.css`, `fonts.css` |
| `js/config.js` | Every limit, timeout, rate limit, format and module definition |
| `js/dom.js` | Safe element builder — the only way UI code creates DOM |
| `js/security/` | `validation.js`, `zip-reader.js`, `image-header.js`, `sanitize.js`, `rate-limiter.js`, `resource-limits.js`, `blob-registry.js` |
| `js/engines/` | Modules 1–9: `preprocess` (incl. perspective correction), `extract` (OCR/text), `text-similarity`, `stylometry`, `handwriting` (incl. edge-hinge), `signature`, `source-matching`, `layout`, `anomaly` + `tamper` (copy-move); shared `imaging`, `text-utils` |
| `js/core/` | `orchestrator`, `analysis-worker`, `fusion`, `state`, `calibration`, `export`, `report-store` (opt-in) |
| `js/ui/` | One file per view (incl. `research.js`, the notebook viewer) + `common`, `charts`, `render-helpers`, `frame-guard`, `bus` |
| `assets/samples/` | Bundled sample documents (public-domain text, synthetic images) for the "Try a sample set" feature |
| `vendor/` | PDF.js, Tesseract.js + core + English data, Chart.js, fonts — served locally |
| `models/` | `calibration.json` (thresholds) and `model_manifest.json` (SHA-256 registry) |
| `notebooks/` | Executed research notebooks 00–06, `index.json` (viewer index), `sway_research.py`, public-domain corpus in `data/gutenberg/` |
| `tools/` | Dev server, fixture generator, notebook builder, research CLI, PNG decoder, secret scan |
| `tests/` | `unit/` (Node test runner), `e2e/` (Playwright + pytest), `fixtures/` |
| `deployment/` | `_headers`, `nginx.conf`, `Dockerfile`, guide |

The specification's Python-oriented paths (`backend/security/*.py`, `backend/tests/*.py`) map to: `js/security/*.js`, `tests/unit/security.test.mjs`, `tests/unit/privacy.test.mjs`, `tests/e2e/test_app.py`.

## Data flow of one analysis

1. **Select** files (drop zone or picker). The batch is rate-limited and checked against file-count and combined-size limits.
2. **Validate** each file (`validateFile`). Oversized files are not even read. PDFs are opened once to enforce the page limit and render a thumbnail; images are decoded only after their header dimensions pass.
3. **Configure** roles (reference, examined, known/unknown sample, source, submission) and content type (digital, printed, handwritten, signature, auto). Modules that do not apply are disabled with a reason.
4. **Run**. A job enters the bounded queue (1 running, 2 pending, duplicates refused) with a 120 s budget:
   - *Scan*: text extraction / OCR page by page (OCR budget 30 pages), visual pages rendered at ≤1800 px (first 5 pages per document).
   - *Preprocess* visual pages in the worker (working copies; operations recorded): perspective correction if a photographed sheet is found, then denoise, contrast, Sauvola thresholding, deskew, line segmentation; copy-move screening runs on the cleaned page.
   - Photographed images are rectified *before* OCR as well.
   - *Modules* run one by one in the worker, each with its own timeout; a failure or timeout marks only that module.
   - *Fusion* produces the evidence matrix, reliability notes, conflicts and summary.
5. **Report** is shown and kept in memory (last 5 reports in this tab). Optional local saving is opt-in.
6. **Cleanup**: OCR worker terminated after every job; "Clear current session", 30-minute idle timeout and tab close wipe all buffers and revoke object URLs.

## Module outputs (schemas)

Each engine returns a plain JSON-serialisable object; key fields:

- **text** `{module, pair, status, words, metrics{exactDocument, tokenJaccard, tfidfCosine, ngram3Jaccard, ngram5ContainmentAinB/BinA, charTrigramCosine, sharedPassageCoverageA/B, sentenceMatchRateA, paraphraseRateA, sentenceLengthSimilarity, paragraphLengthSimilarity, headingSequenceSimilarity, matchedOrderAgreement}, counts, exactParagraphs[], passages[{words,a{start,end},b{start,end}}], sentenceMatches[{category,a,b,charScore,wordScore}], uniqueA/B[], review[], warnings[]}`
- **style** `{pair, status, words, chunks, agreement, disagreement, cosineStandardized, standardizedDistance, features[{name,label,a,b,z,verdict}], groups[], strongestMatches[], strongestDifferences[]}` + optional `cluster`
- **handwriting** features `{lines, letters, lineHeightPx, features{14}, histograms{orientation[12], texture[10]}, perLine[], handwritingCues[]}`; comparison `{features[], orientationSimilarity, textureSimilarity, agreement, meanZ, reliable}`
- **signature** `{alignment, metrics{ssim, tolerantOverlap, chamferDistancePx, shapeMomentDistance, profile correlations, strokeDirectionSimilarity, aspect ratios, stroke counts, inkOnlyInA/B}, diffMap, missingOrExtra[]}`
- **source** `{scope, results[{examinedId, words, combinedCoverage, sources[{sourceName, sharedPassageCoverage, paraphraseRate, orderAgreement, matches[{method, score, examined{start,end,page,paragraph}, source{…}}]}]}]}`
- **layout** `{features[11 visual measures], agreement, alignment}` + digital `{fontStyleOverlap, stylesA/B, pageNumbers, pageSize}`
- **anomaly** per document `{checks[], flags[{kind: style|handwriting|layout|metadata|duplicate, segment, features[{feature, robustZ}], isolationScore, excerpt|region|source|issue}]}`
- **tamper** `{regions[{source{x,y,w,h}, copy{x,y,w,h}, blocks, density, correlation, shift{dx,dy}}], analysed{width,height,scale}, blocks}`
- **fusion** `{rows[{module, pair, label, basis, reliability, reliabilityNotes}], status{module→state}, conflicts[], summary[], alternatives}`

Unit tests in `tests/unit/engines.test.mjs` exercise every schema.
