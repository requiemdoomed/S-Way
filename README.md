<div align="center">

# S-Way · SmartWay
### Intelligent Document Authenticity and Authorship Analysis System

**Beyond Similarity. Into Document Intelligence.**

Designed, built and documented by **Swayam Shakya**

Version 1.1.0 · MIT licence · Runs entirely in your browser — no server, no uploads, no tracking

</div>

![S-Way overview: a sheet of paper feeding out of a 1980s typewriter](docs/screenshots/overview.png)

> **Important.** S-Way does not establish identity, misconduct, forgery, or plagiarism as a final determination. Findings require appropriate human examination.

---

## Contents

1. [What S-Way is](#1-what-s-way-is)
2. [Highlights](#2-highlights)
3. [Screenshots](#3-screenshots)
4. [Quick start (run it in 30 seconds)](#4-quick-start)
5. [Publishing on GitHub and GitHub Pages](#5-publishing-on-github-and-github-pages)
6. [Using S-Way, step by step](#6-using-s-way-step-by-step)
7. [The seven lines of evidence](#7-the-seven-lines-of-evidence)
8. [The computer-vision pipeline](#8-the-computer-vision-pipeline)
9. [How results are combined and reported](#9-how-results-are-combined-and-reported)
10. [Research notebooks (Jupyter)](#10-research-notebooks-jupyter)
11. [Measured results](#11-measured-results)
12. [Security and privacy](#12-security-and-privacy)
13. [Project structure](#13-project-structure)
14. [Developer tools](#14-developer-tools)
15. [Testing and quality](#15-testing-and-quality)
16. [Limits and configuration](#16-limits-and-configuration)
17. [Known limitations](#17-known-limitations)
18. [Roadmap](#18-roadmap)
19. [Credits and licences](#19-credits-and-licences)
20. [Author](#20-author)

---

## 1. What S-Way is

Teachers, integrity officers and researchers regularly face questions such as *"did these two students share work?"*, *"was this page written by the same hand?"*, *"where did this paragraph come from?"* or *"has this scanned page been edited?"*. The usual answer is a single opaque similarity percentage — often produced by uploading private documents to a third-party service.

S-Way takes a different approach:

- **Separate, explainable evidence.** The question is split into seven independent lines of evidence (text, writing style, handwriting, signatures, sources, layout, internal consistency). Each is reported on its own with the measurements behind it. Nothing is averaged into one score, and no result is presented as a probability of authorship.
- **Honest about weak evidence.** Short texts, low OCR confidence, poor images, conflicting modules and innocent explanations are spelled out in every report.
- **Private by construction.** Everything — file validation, PDF reading, OCR, computer vision, statistics, reporting — runs inside the browser tab. There is no backend to receive documents. Closing the tab discards everything.
- **Research-backed.** Seven executed Jupyter notebooks evaluate the exact JavaScript code the app ships, set its thresholds, and are readable inside the app.

The interface is styled as **a 1980s typewriter left in an abandoned house**: cream and beige paper sheets, walnut panelling, faded damask wallpaper, brass pins, and rubber-stamped verdicts. A *Lamplight* (dark) theme shows the same room after dark.

## 2. Highlights

| | |
|---|---|
| 🔒 **Zero data leaves the device** | Strict Content-Security-Policy; no third-party origins; a test fails if any request leaves the site |
| 🛡️ **Hardened upload validation** | Magic-byte checks, ZIP-bomb / traversal / macro rejection, decompression-bomb image detection from headers |
| 🔍 **Seven evidence modules** | Text, stylometry (57 features), handwriting, signatures, sources, layout, anomaly & tamper screening |
| 📷 **Phone-photo correction** | Finds a photographed sheet's corners and flattens it before OCR (OCR error 44 % → 0.1 %) |
| ✂️ **Copy-move detection** | Finds regions pasted elsewhere on the same page, with 0 false alarms on held-out clean pages |
| ✍️ **Writer texture features** | Edge-hinge and spacing-rhythm histograms halve the synthetic writer error rate (7.4 % → 3.6 %) |
| 📓 **Notebooks in the app** | Read the executed research notebooks inside S-Way — no Jupyter needed |
| 🧪 **113 automated tests** | 84 unit + 29 browser tests, all passing; ruff, bandit, pip-audit, npm audit clean |
| 📱 **Responsive & accessible** | Works on phones; keyboard navigation; labels never rely on colour alone |

## 3. Screenshots

| | |
|---|---|
| ![Sample sets on the New analysis page](docs/screenshots/new-analysis-samples.png) **New analysis** — drop files on the sheet or load a sample set | ![Evidence matrix](docs/screenshots/report-matrix.png) **Evidence matrix** — every line of evidence stamped separately |
| ![Similarity matrix](docs/screenshots/similarity-matrix.png) **Similarity matrix** — every pair at a glance | ![Comparison](docs/screenshots/comparison.png) **Document comparison** — exact (solid), near-identical (dashed) and paraphrase (dotted) marks |
| ![Copy-move detection](docs/screenshots/tamper-detection.png) **Tamper screening** — a region copied and pasted on the same page | ![Pages side by side](docs/screenshots/pages-side-by-side.png) **Pages side by side** — the phone photo next to the scan |
| ![Handwriting lab](docs/screenshots/handwriting-lab.png) **Handwriting lab** — 14 features + edge-hinge texture | ![Signature lab](docs/screenshots/signature-lab-lamplight.png) **Signature lab** in the Lamplight theme |
| ![Research notebook viewer](docs/screenshots/research-notebook.png) **Research notebooks** read inside the app | ![Privacy center](docs/screenshots/privacy-center-lamplight.png) **Privacy center** — live storage and network checks |

<p align="center"><img src="docs/screenshots/mobile.png" alt="S-Way on a phone" width="260"></p>

## 4. Quick start

**Requirements:** a modern browser (Chrome, Edge, Firefox, Safari) and, for the local server, Node.js 20 or newer. No `npm install` is needed — every library is bundled in `vendor/`.

```bash
git clone https://github.com/<your-username>/S-Way.git
cd S-Way
npm start            # → open http://127.0.0.1:8000
```

`npm start` runs `tools/serve.mjs`, a small dependency-free server that also sends the production security headers. Any static server works (`python3 -m http.server 8000`).

> Opening `index.html` directly from disk (`file://`) does **not** work: browsers block module workers there. Use a local server or GitHub Pages.

**No documents to hand?** On *New analysis*, open **"Try a sample set"** and load essays, handwritten pages, signatures, or a phone photo with a tampered page.

## 5. Publishing on GitHub and GitHub Pages

The repository root *is* the website: `index.html` sits at the top level and loads everything else by relative path (`css/`, `js/`, `vendor/`, `assets/`, `models/`, `notebooks/`).

### Upload the project

The project has about 410 files. GitHub's web uploader accepts at most 100 files per upload, so use **git** (or GitHub Desktop):

```bash
cd S-Way                       # the unzipped folder that contains index.html
git init
git add .
git commit -m "S-Way 1.1.0 by Swayam Shakya"
git branch -M main
git remote add origin https://github.com/<your-username>/S-Way.git
git push -u origin main
```

No file comes close to GitHub's 100 MB limit (the largest is ≈ 4.3 MB).

### Turn on GitHub Pages — choose one

**A. GitHub Actions (recommended).** *Settings → Pages → Source: GitHub Actions.* The included workflow `.github/workflows/ci-and-pages.yml` runs all unit, browser, security and audit checks, then publishes only the application files plus the executed notebooks. Your site appears at `https://<your-username>.github.io/S-Way/`.

**B. Deploy from a branch (simplest).** *Settings → Pages → Source: Deploy from a branch → `main` / `(root)`.* The whole repository is served as is (`.nojekyll` is included so every folder is published).

Keep **Enforce HTTPS** ticked. GitHub Pages cannot send custom security headers, so S-Way relies on its `<meta>` Content-Security-Policy and JavaScript frame guard there; for full headers use Netlify/Cloudflare Pages with `deployment/_headers`, or the hardened nginx container — see [deployment/deployment-guide.md](deployment/deployment-guide.md).

**After deploying:** open *Privacy center* and check "Cookies: None set", "External processing: 0 outside requests", "Model thresholds: Verified (SHA-256)", "Secure context: Yes".

## 6. Using S-Way, step by step

1. **New analysis.** Drop up to 10 files (PDF, PNG, JPEG, WEBP, DOCX, TXT; 15 MB each, 40 MB total, 50 PDF pages) onto the sheet. Each file is checked by its *contents*; disguised or dangerous files are stamped **Rejected** with the reason.
2. **Describe each document (optional).** *Role*: reference, under examination, known/unknown writing sample, source material, assignment submission. *Content*: digital text, printed/scanned page, handwritten page, signature, or automatic. S-Way never assumes the first file is the authentic one.
3. **Choose checks** or tick *Complete analysis*. Checks that cannot apply (e.g. handwriting on a typed PDF) are disabled with the reason.
4. **Run.** Progress is typed out line by line; you can cancel at any time. Every job has hard time limits.
5. **Read the report**: executive summary, notes on the documents, module status, main findings, limitations, areas for review, evidence matrix, similarity matrix, conflicting evidence, detailed results, numbered evidence details (F-001 …) and alternative explanations.
6. **Inspect**: *Document comparison* (highlighted text side by side, page images, overlays, text correction), *Handwriting lab*, *Signature lab* (drag to select a signature), *Source investigation*.
7. **Export**: PDF (browser print → *Save as PDF*), JSON, CSV (formula-injection safe), overlay PNGs.
8. **Clear**: *Privacy center → Clear current session* wipes all documents, images, reports and workers.

**Correcting OCR.** Handwriting and poor scans produce imperfect text. *Document comparison → Review & correct text* lets you fix it; the original extraction is kept and can be restored, and reports say when corrected text was used.

## 7. The seven lines of evidence

| Module | What it measures | Methods |
|---|---|---|
| **Text similarity** | Copied, near-identical and reworded passages | Exact passages (≥ 8 words) with character offsets, word n-grams, 5-gram containment, TF-IDF cosine, character-trigram sentence alignment, sentence/paragraph length distributions, heading sequence, matched-order agreement |
| **Writing style** | How alike the writing *habits* are | 57 features (sentence rhythm, vocabulary diversity, punctuation, capitalisation, 30 function words, sentence openings …) compared by chunk-based Welch z-scores against each text's own variation; standardised cosine/distance; average-linkage clustering for 3+ documents |
| **Handwriting features** | Measurable characteristics of a hand | Line and word segmentation; slant (shear search), stroke width, word/letter gaps, line spacing, baseline wobble, letter proportions, ascenders, connectedness, ink density, margin regularity, contour complexity, writing size; stroke-direction (Sobel), LBP texture, **edge-hinge** and **white-run** histograms |
| **Signature comparison** | Visual likeness of two signatures | Otsu binarisation, tight crop, aspect-preserving normalisation, rotation/shift alignment search, tolerant overlap, chamfer distance, SSIM, Hu moments, profile correlations, difference map and region list |
| **Source investigation** | Which passages come from supplied sources | Text engine per examined/source pair; page and paragraph references; combined coverage |
| **Layout & formatting** | Page geometry and typography | Margins, line spacing/height, density, utilisation, edge alignment, indentation; PDF/DOCX font and size distributions, page numbering, page size; aligned page overlays |
| **Anomaly screening** | Parts of a document unlike the rest | Robust z-scores (median/MAD) + Isolation Forest over text segments, handwriting lines and pages; **copy-move duplicated regions**; PDF/DOCX metadata date checks |

## 8. The computer-vision pipeline

```
 image / PDF page
      │
      ▼
 header check (dimensions before decoding) ─► reject decompression bombs
      │
      ▼
 phone photo?  ── paper mask → largest component → 4 extreme corners
      │            └─► homography (8×8 solve) → perspective warp   (before OCR too)
      ▼
 working copy: resize ≤ 1800 px → 3×3 denoise → 1–99 % contrast stretch
      │
      ▼
 Sauvola adaptive threshold (integral images) → orientation check
      │
      ▼
 deskew (projection-profile energy, ±6°) → despeckle → text-line segmentation
      │
      ├─► handwriting features (geometry + direction, LBP, edge-hinge, white-run)
      ├─► layout measurements
      ├─► signature region suggestion
      └─► copy-move screening:
            integer binning + blur → 12×12 block descriptors (16 cell means)
            → lexicographic sort → near-identical far-apart pairs → shift votes
            → spatial clustering → direct shift verification (≥ 80 % of blocks)
            → pixel correlation ≥ 0.9 → must span > 1.6 text lines
```

Every operation applied to a page is recorded and listed in the report. Originals are never modified.

## 9. How results are combined and reported

The **evidence-fusion** engine (`js/core/fusion.js`):

1. records which modules ran, were skipped (and why) or failed;
2. turns each module's measurements into a qualitative label — *High / Moderate / Low / Inconclusive*, *Potential match / Limited overlap / No match*, or *N regions to review* — using thresholds from `models/calibration.json`;
3. lowers reliability for short texts, OCR confidence below 70 %, machine-read handwriting and poor images;
4. flags **conflicts** (e.g. high text similarity but low style similarity) with plain-language interpretations;
5. lists **alternative explanations** for every module.

It never averages modules and never outputs a probability. Reports avoid accusatory language (a browser test checks for words such as "forged" or "cheated").

## 10. Research notebooks (Jupyter)

Open **Research notebooks** in the app to read them, or run them yourself. They call the shipped JavaScript engines through `tools/sway-cli.mjs`, so every number describes the real implementation.

| Notebook | Contents |
|---|---|
| `00_dataset_exploration` | Corpus statistics and biases, function-word heat map, gallery of synthetic writers, signatures, phone photos, copy-move edits, fixture inventory |
| `01_text_similarity_benchmark` | 250-pair benchmark (verbatim and rule-paraphrased insertions of 10–80 %); threshold search; confusion matrix; error analysis |
| `02_stylometry_evaluation` | Same- vs different-author AUC at 300/1,000/2,500 words; label thresholds; supervised attribution with GroupKFold by book; clustering |
| `03_handwriting_signature_synthetic` | Writer-disjoint evaluation (36 writers); feature scales; edge-hinge ablation and learned weights; robustness to blur/noise/rotation/low-res/JPEG; genuine vs random vs skilled signature forgeries |
| `04_ocr_evaluation` | Character/word error rates under degradations; OCR confidence on handwriting |
| `06_preprocessing_and_tampering` | Phone-photo corner error and OCR before/after rectification; copy-move detection by paste size, hard cases, false alarms (held-out set) |
| `05_export_calibration` | Writes `models/calibration.json` and its SHA-256 in `models/model_manifest.json` |

```bash
pip install -r requirements.txt        # plus the Tesseract 5 binary for notebooks 04 and 06
python3 tools/build_notebooks.py       # build + execute everything (~6 minutes)
python3 tools/build_notebooks.py 03_ 05_   # selected notebooks only
jupyter notebook notebooks/            # interactive exploration
```

**Data.** Project Gutenberg texts (public domain, via the NLTK data repository) in `notebooks/data/gutenberg/`. All images are synthetic and generated by code — no personal data. Real handwriting/signature datasets (IAM, CVL, CEDAR, GPDS) require licence agreements and were not used.

## 11. Measured results

From the executed notebooks (details in [docs/MODEL_CARD.md](docs/MODEL_CARD.md)):

| Task | Result |
|---|---|
| Text — *Moderate* label vs ≥ 10 % inserted material | precision 1.00, recall 0.99, 0 false positives |
| Text — *High* label vs ≥ 30 % verbatim | recall 1.00, false-positive rate 1.6 % |
| Style — same vs different author (AUC) | 0.60 (300 words) → 0.77 (1,000) → 0.94 (2,500) |
| Handwriting, synthetic unseen writers — v1.0 → v1.1 | AUC 0.984 → **0.995**, EER 7.4 % → **3.6 %** |
| Signatures, synthetic — genuine vs random / skilled forgery (AUC) | 1.00 / 0.947 — every skilled forgery still looked "highly similar" |
| OCR on clean / noisy print (character error) | 0.2 % / 1.3 % |
| Phone photos — sheet found, corner error | 16 / 16, 7.8 px |
| Phone photos — OCR error raw → rectified | **44 % → 0.1 %** |
| Copy-move — false alarms on clean pages | **0 / 26** |
| Copy-move — large / medium / small pastes localised | 65 % / 54 % / 27 % (printed pages: 92 % of large pastes) |

Handwriting and signature numbers come from synthetic data and **do not** estimate real-world accuracy.

## 12. Security and privacy

| Area | Controls |
|---|---|
| **Network** | Meta CSP: `default-src 'none'`, `script-src 'self'`, `connect-src 'self'`, `object-src 'none'`, `form-action 'none'`, no `unsafe-inline`/`unsafe-eval`. Only same-site fetches (calibration, notebooks, samples) — enforced by tests |
| **Uploads** | Filename inspection (traversal, null bytes, bidi tricks), extension allowlist, magic bytes, MIME agreement, size/batch limits, image header dimensions, PDF structure/encryption/active-content detection, defensive ZIP reader (entry count, sizes, ratio, traversal, symlinks, overlaps, CRC, lying sizes), macro rejection, no XML DTD/entities, strict TXT decoding |
| **Processing** | Web Workers with per-step and per-job timeouts, real cancellation (worker termination), bounded queue, duplicate-job refusal, rate limits (with the specified "Too many analysis requests" message), page/pixel/character budgets; PDF.js with scripting and font loading disabled |
| **Browser** | No `innerHTML`/`eval` anywhere (enforced by tests), text inserted with `textContent`, frame guard, object-URL revocation, CSV formula-injection protection |
| **Privacy** | No cookies, no web storage, no analytics, no logs; OCR data not cached; idle auto-clear after 30 minutes; *Clear current session*; optional, opt-in, clearly-labelled unencrypted report saving |
| **Supply chain** | Pinned vendored libraries (`npm audit`: 0), `pip-audit`, `bandit`, `ruff`, secret scan, CI on every push |

Full details: [SECURITY.md](docs/SECURITY.md) · [PRIVACY.md](docs/PRIVACY.md) · [SECURITY_AUDIT.md](docs/SECURITY_AUDIT.md)

## 13. Project structure

```
S-Way/
├── index.html                 ← the app: loads css/, js/, vendor/ (GitHub Pages entry point)
├── README.md  CHANGELOG.md  LICENSE  package.json  requirements.txt  pyproject.toml  .env.example
├── assets/
│   ├── logo.svg
│   └── samples/               ← sample documents for "Try a sample set"
├── css/                       ← fonts, theme tokens (daylight/lamplight), layout, components, views, print
├── js/
│   ├── app.js  config.js  dom.js
│   ├── security/              ← validation, zip-reader, image-header, sanitize, rate-limiter, resource-limits, blob-registry
│   ├── engines/               ← preprocess, extract (OCR), imaging, text-utils, text-similarity, stylometry,
│   │                             handwriting, signature, source-matching, layout, anomaly, tamper
│   ├── core/                  ← orchestrator, analysis-worker, fusion, calibration, state, export, report-store
│   └── ui/                    ← one view per page + research (notebook viewer), common, charts, render-helpers, frame-guard
├── vendor/                    ← PDF.js, Tesseract.js (+ WASM core + English data), Chart.js, fonts — all local
├── models/                    ← calibration.json + model_manifest.json (SHA-256 registry)
├── notebooks/                 ← 00–06 executed notebooks, index.json, sway_research.py, data/gutenberg/
├── tools/                     ← serve, build_notebooks, sway-cli, make_fixtures, png-gray, secret_scan
├── tests/
│   ├── unit/                  ← security, engines, vision, privacy  (node --test)
│   ├── e2e/                   ← Playwright browser tests (pytest)
│   └── fixtures/              ← controlled test files incl. harmless "attack" files
├── docs/                      ← ARCHITECTURE, SECURITY, PRIVACY, SECURITY_AUDIT, MODEL_CARD, TESTING, LIMITATIONS, screenshots/
├── deployment/                ← _headers, nginx.conf, Dockerfile, deployment-guide.md
├── vendor-src/                ← pinned package manifest of the vendored libraries (for npm audit / re-vendoring)
└── .github/workflows/         ← CI + GitHub Pages deployment
```

## 14. Developer tools

| Command | Purpose |
|---|---|
| `npm start` | Local server with production security headers (`tools/serve.mjs`) |
| `npm test` | 84 unit tests |
| `npm run test:e2e` | 29 Playwright browser tests |
| `npm run fixtures` | Regenerate test fixtures (`tools/make_fixtures.py`) |
| `npm run notebooks` | Rebuild and execute all research notebooks; rewrite calibration |
| `npm run audit:secrets` | Local secret scan |
| `node tools/sway-cli.mjs request.json` | Run any shipped engine from the command line (used by the notebooks) |

## 15. Testing and quality

| Suite | Tests | Result |
|---|---:|---|
| Upload & resource security (unit) | 45 | ✅ |
| Analysis engines (unit) | 23 | ✅ |
| Computer vision (unit) | 7 | ✅ |
| Privacy & static code rules (unit) | 9 | ✅ |
| Browser end-to-end (Playwright) | 29 | ✅ |
| **Total** | **113** | **all passing** |

Plus `ruff` (clean), `bandit` (0 medium/high), `pip-audit` (no known vulnerabilities), `npm audit` (0), secret scan (0). Typical analysis times: 1.5 s for three text documents, ≈ 7 s for three scanned images with OCR. See [docs/TESTING.md](docs/TESTING.md).

## 16. Limits and configuration

All limits live in `js/config.js`:

| Limit | Value |
|---|---|
| File size / files per analysis / combined | 15 MB / 10 / 40 MB |
| PDF pages | 50 (first 5 rendered for visual analysis) |
| Image dimensions | 10,000 × 10,000 px and 40 megapixels |
| Extracted text | 2,000,000 characters |
| DOCX expansion | 100 MB, 1,000 entries, ratio ≤ 100 : 1 |
| Job time limit | 120 s (OCR 60 s per page, 30 OCR pages per analysis) |
| Rate limits (per 10 min) | analyses 5, uploads 10, OCR 10, visual/ML 5, exports 10 |
| Idle auto-clear | 30 minutes |

## 17. Known limitations

- OCR is English-only and trained on print; handwriting OCR is poor — use the text correction view.
- Paraphrase detection is lexical; heavy rewording is missed. No internet source search.
- Writing style needs long texts (≥ 1,000 words for useful separation) and is confounded by genre and topic.
- Handwriting and signature modules are feature-based and validated only on synthetic data; signatures are compared visually (no pressure, speed or stroke order).
- Copy-move screening misses rescaled/rotated pastes, splices from other images and very small edits; a clean result is not proof of authenticity.
- GitHub Pages cannot send security headers (mitigated by the meta CSP and frame guard).

Full list: [docs/LIMITATIONS.md](docs/LIMITATIONS.md).

## 18. Roadmap

- Writer- and signature-verification networks trained on licensed datasets (writer-disjoint protocol already in notebook 03)
- On-device sentence embeddings for semantic paraphrase detection
- Handwriting-capable OCR and more languages
- Splice detection (noise/compression inconsistency) alongside copy-move
- Optional, consented external source search
- Firefox and Safari runs in CI

See [CHANGELOG.md](CHANGELOG.md) for what changed in each release.

## 19. Credits and licences

S-Way is released under the **MIT licence** (© 2026 Swayam Shakya). Bundled third-party components keep their own licences:

| Component | Licence |
|---|---|
| PDF.js 6.5 (Mozilla) | Apache-2.0 |
| Tesseract.js 7, tesseract.js-core 7, English `best_int` data | Apache-2.0 |
| Chart.js 4.6 | MIT |
| Special Elite typeface (Astigma) | Apache-2.0 |
| Courier Prime typeface (Quote-Unquote Apps) | SIL Open Font License 1.1 |
| Project Gutenberg texts (research corpus) | Public domain |

Methods draw on published work, including Sauvola & Pietikäinen (adaptive binarisation), Fridrich, Soukal & Lukáš (copy-move detection), Bulacu & Schomaker (edge-hinge writer features), Burrows (function-word stylometry), Liu, Ting & Zhou (Isolation Forest) and Wang et al. (SSIM).

## 20. Author

**Swayam Shakya** — concept, design, implementation, research and documentation of S-Way (SmartWay).

<div align="center">

*S-Way does not establish identity, misconduct, forgery, or plagiarism as a final determination.*
*Findings require appropriate human examination.*

</div>
