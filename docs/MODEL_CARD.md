# Model card — S-Way analysis methods and calibration

S-Way ships **no neural networks**. All analysis is explainable feature engineering plus thresholds. The only learned artifact is `models/calibration.json`, produced by `notebooks/05_export_calibration.ipynb` and integrity-checked by SHA-256 (`models/model_manifest.json`). Every number below comes from executed notebooks in `notebooks/` that call the shipped JavaScript engines.

## Intended use

Screening and evidence assistance for people reviewing documents (teachers, integrity officers, researchers). Outputs are descriptive similarity labels with the measurements behind them, for human review.

**Out of scope:** deciding who wrote something, whether misconduct or forgery occurred, or identity verification. No output is a probability of shared authorship.

## Components

| Module | Method | Learned parameters |
|---|---|---|
| OCR | Tesseract 5 LSTM (`eng` best_int), WebAssembly | pretrained by Tesseract project (Apache-2.0) |
| Text similarity | exact passages (≥ 8 words), word n-grams, TF-IDF, character-trigram sentence alignment, structure | fusion thresholds |
| Stylometry | 57 features, chunk-based Welch z-scores, standardised cosine/distance, average-linkage clustering | fusion thresholds |
| Handwriting | 14 geometric features + stroke-direction, LBP, **edge-hinge** (66 bins) and **white-run** histograms; combined distance = meanZ + w_h·(1−hinge sim) + w_r·(1−run sim) | variability scales, weights w_h = 1.415, w_r = 0.543, fusion thresholds |
| Signature | normalisation, rotation/shift alignment, tolerant overlap, chamfer distance, SSIM, Hu moments | fusion thresholds |
| Layout | 11 page-geometry measures; font/size distributions | fixed scales |
| Anomaly | robust z (median/MAD) + Isolation Forest (100 trees, fixed seed) | none |
| Perspective correction (v1.1) | paper-mask corner detection + homography warp | none |
| Copy-move screening (v1.1) | block matching (16-cell descriptors), shift voting, direct shift verification (density), NCC confirmation, line-height filter | operating point tuned on a separate development set |

## Evaluation data

- **Text & style:** 18 public-domain texts (Project Gutenberg selection distributed by NLTK). Text benchmark: 250 pairs — 90 negatives (different books; same book, different passage) and 160 synthetic submissions with 10–80 % inserted material, verbatim or rule-paraphrased. Style benchmark: 270 pairs of 300 / 1,000 / 2,500-word chunks, same author (Austen, Chesterton; different books) vs different authors.
- **Handwriting & signatures:** **synthetic** images (30 parameterised writers × 4 samples; 20 signers × 4 genuine + 2 skilled forgeries). Real datasets (IAM, CVL, CEDAR, GPDS) need licence agreements that could not be accepted for this offline build.
- **OCR:** 60 rendered printed pages (10 passages × 6 conditions).

- **Vision (v1.1):** 16 simulated phone photos of rendered Gutenberg pages; 26 base pages (printed, noisy scans, synthetic handwriting) × 6 tampering variants for copy-move.

Splits: handwriting writers (36 × 4 samples) and signature signers are split into **disjoint** groups for fitting vs testing; style attribution uses GroupKFold by book.

## Results

| Task | Metric | Value |
|---|---|---|
| Text, *Moderate* label vs any insertion ≥ 10 % | precision / recall / FPR | 1.00 / 0.99 / 0.00 (2 misses: 10 % paraphrased) |
| Text, *High* label vs ≥ 30 % verbatim | recall / FPR on < 20 % and negatives | 1.00 / 0.016 |
| Style, same vs different author (AUC of low disagreement) | 300 / 1,000 / 2,500 words | 0.60 / 0.77 / 0.94 |
| Style, *High* label (≥ 1,000 words) | precision / recall | 0.93 / 0.63 |
| Style, *Moderate* label (≥ 1,000 words) | precision / recall | 0.70 / 0.87 (33 of 90 different-author pairs also labelled ≥ Moderate) |
| Style, supervised attribution on unseen books (research only) | accuracy per fold | 1.00, 1.00, 0.92 |
| Handwriting v1.0 (14 geometric features), synthetic unseen writers | AUC / EER | 0.984 / 7.4 % |
| **Handwriting v1.1 (+ edge-hinge & white-run, combined distance)** | AUC / EER | **0.995 / 3.6 %** |
| Edge-hinge alone | AUC | 0.990 |
| Handwriting v1.1, *High* label on test writers | same / different writer pairs labelled High | 100 % / 12 % |
| Handwriting robustness (blur, noise, 2.5° rotation, low-res, JPEG), v1.0 → v1.1 | AUC range | 0.966–0.988 → 0.967–0.995 |
| Signature (synthetic), genuine vs random forgery | AUC | 1.00 |
| Signature (synthetic), genuine vs skilled forgery | AUC | 0.947 — **all skilled forgeries were labelled "High similarity"** |
| OCR, printed pages | mean CER clean / noisy / blurred | 0.2 % / 1.3 % / 0.6 % |
| OCR on (synthetic) handwriting | mean confidence | 30–45 (vs ≈ 95 on print) |
| Perspective correction, 16 simulated phone photos | sheet found / mean corner error | 16 of 16 / 7.8 px (on 1500 × 1900) |
| OCR on phone photos: raw vs rectified | mean CER | **44 % → 0.1 %** |
| Copy-move, clean pages (false alarms) | flagged | **0 of 26** |
| Copy-move, pastes 160–260 px tall / 100–150 / 60–90 | correctly localised | 65 % / 54 % / 27 % |
| Copy-move, large paste + JPEG q70 / rescaled to 90 % | correctly localised | 62 % / 0 % |
| Copy-move by page type (large pastes) | printed / noisy scan / synthetic handwriting | 92 % / 100 % / 0 % |

## Interpretation and caveats

- **Text** thresholds were fitted on negatives that share almost no phrases. Real documents on the same topic or assignment share more vocabulary and stock phrases, so expect more *Moderate* labels in practice; the evidence (highlighted passages) must be read.
- **Paraphrase** detection is lexical; it caught rule-based rewording but will miss human paraphrase that changes most words.
- **Style** separates authors only with long texts, and the evaluation confounds author with era and genre. With texts under ~1,000 words, style evidence is weak — S-Way marks < 150 words as *Inconclusive* and < 300 words as *limited*.
- **Handwriting and signature** figures validate the pipeline on synthetic data only. They are **not** estimates of real-world accuracy. The skilled-forgery result shows why visual similarity cannot establish authenticity.
- **OCR confidence < 70** reliably indicated unusable text in these tests and triggers S-Way's "review the text" warning.
- **Copy-move** screening is tuned for near-zero false alarms (born-digital pages repeat words pixel-for-pixel, so duplicates must span > 1.6 text lines). It misses rescaled or rotated pastes, splices from other images, small edits, and — in these tests — pastes in thin synthetic handwriting. A clean result is never evidence of authenticity.
- **Development vs evaluation sets:** the copy-move parameters were chosen on two development sets (seeds 777 and 4242); the numbers above come from notebook 06's separate evaluation set.

## Ethical considerations

Similarity tools can be over-trusted and used punitively. S-Way therefore never outputs a single score or probability, prints its disclaimer on every report, lists alternative explanations for each module, flags conflicting evidence, and avoids accusatory language (an E2E test checks reports for terms such as "forged" or "cheated").

## Not implemented (and why)

- **Siamese neural writer/signature verification:** no licensed real dataset or GPU training was available, so no neural model is shipped. Notebook 03 instead learns a weighted combination of interpretable distances (geometric meanZ, edge-hinge, white-run) with a writer-disjoint protocol — the "learned similarity" the app uses.
- **Sentence-transformer semantic similarity:** would require bundling a ≥ 20 MB model and an inference runtime; deferred to keep the app small and fully offline. The report states the limitation.
- **TrOCR / EasyOCR for handwriting:** large models, unsuitable for in-browser use here; handwriting OCR relies on user correction instead.
