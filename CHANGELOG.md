# Changelog

All notable changes to S-Way (SmartWay) — by Swayam Shakya.

## 1.1.0 — 2026-11-04

### Computer vision
- **Perspective correction for phone photos**: the sheet's four corners are found against a darker background and the page is warped flat with a homography — in preprocessing *and before OCR*. Measured on 16 simulated photos: sheet found 16/16, mean corner error 7.8 px, OCR character error **44 % → 0.1 %**.
- **Duplicated-region (copy-move) screening**: block matching with integer-binned, blurred descriptors; shift voting; direct verification that ≥ 80 % of textured blocks reappear at the shift; normalised cross-correlation confirmation; a line-height rule so pixel-identical repeated words in born-digital pages never trigger it. Held-out evaluation: **0 / 26 false alarms**, 65 % of large pastes localised (92 % on printed pages), robust to JPEG q70. Results appear in the anomaly section with an annotated figure.
- **Writer-identification texture features**: edge-hinge distribution (66 bins) and white-run (spacing rhythm) histograms, combined with the geometric features through weights learned on training writers. Synthetic unseen-writer EER **7.4 % → 3.6 %** (AUC 0.984 → 0.995).

### Research notebooks
- New **00 · Dataset exploration** (corpus statistics, function-word heat map, gallery of all synthetic data types and fixtures).
- New **06 · Photographed pages and copy-move screening** (corner error, OCR before/after rectification, detection by paste size, hard cases, false alarms).
- **03** rewritten: 36 writers, ablation of geometric vs edge-hinge vs combined distances, learned weights, robustness v1.0 vs v1.1.
- Copy-move parameters tuned on two separate development sets; the notebook reports a held-out evaluation set.
- Notebook index (`notebooks/index.json`) generated automatically.

### App
- **Research notebooks viewer** (new navigation item): reads the executed notebooks inside S-Way, safely (no HTML rendering).
- **Sample sets** on New analysis: essays + source, handwritten pages, signatures, phone photo + tampered page — loaded from the site and validated like user files.
- **Similarity matrix** in reports with three or more documents.
- Examined documents are now also compared **with each other** (e.g. two submissions sharing material), not only with references.
- "Notes on the documents" section in the report (automatic corrections, OCR warnings, ignored PDF actions …).
- Handwriting lab shows edge-hinge, spacing-rhythm and combined distance.

### Quality
- 113 automated tests (84 unit, 29 browser), all passing; ruff, bandit, pip-audit, npm audit and secret scan clean.

## 1.0.0 — 2026-11-04
First release: client-side analysis with seven evidence modules, strict upload validation, evidence fusion, typewriter-themed interface, research notebooks 01–05, 102 tests.
