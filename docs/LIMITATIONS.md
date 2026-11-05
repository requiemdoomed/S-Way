# Limitations

S-Way is an evidence-assistance and screening tool, not a forensic authority. Read these before relying on any result.

## Scientific

- **Similarity ≠ copying, ≠ shared authorship, ≠ forgery.** Different people write alike; one person writes differently on different days; shared sources, quotations, assignment briefs and templates all create similarity.
- **No probabilities.** No module is calibrated on real casework, so S-Way reports qualitative labels and raw measurements only.
- **Thresholds** were fitted on public-domain books and synthetic images (see `MODEL_CARD.md`); real-world error rates are unknown.

## Per module

| Module | Main limitations |
|---|---|
| OCR | English only. Trained for print: handwriting OCR is usually poor (confidence 30–45 in tests). Correct text manually before relying on text/style results. Headers, footers, footnotes and text boxes are not extracted from DOCX. |
| Text similarity | Paraphrase detection is lexical; heavy rewording is missed. Very short texts (< 50 words) are flagged. Only documents supplied in the session are compared — **no internet search**. |
| Writing style | Needs ≥ 300 words per document (≥ 1,000 for useful separation). Strongly affected by genre, topic, instructions, editing tools and co-authors. |
| Handwriting | Feature comparison, not identification. Sensitive to pen, paper, posture, speed, scan quality, deliberate disguise. Validated only on synthetic writers. Printed text measured as "handwriting" describes the typeface. Only the first 5 pages of a document are analysed visually. |
| Signature | Offline, static images only — no pressure, speed or stroke order. Skilled imitations look similar (synthetic tests: all labelled *High similarity*). Never declares authenticity or forgery. |
| Layout | Templates and software defaults produce identical layouts. Scanning changes margins/spacing. |
| Anomaly | Needs ≥ 750 words, ≥ 6 handwriting lines or ≥ 3 pages. Quotations, lists, tables and topic changes legitimately stand out. |
| Metadata | Dates depend on device clocks and conversion tools; never proof of tampering. |
| Copy-move screening | Finds unmodified copy-paste within one page (65 % of large pastes, 0 false alarms in tests). Misses rescaled/rotated pastes, content spliced from other images, edits smaller than ~2 text lines, and (in tests) pastes in thin handwriting. Repeated logos, stamps and form elements are legitimate duplicates. |
| Perspective correction | Needs the whole sheet visible against a clearly darker background; folded or curled pages are only partly corrected. |

## Technical

- Processing happens on the visitor's device: large scanned PDFs are slow on low-end phones; limits (15 MB/file, 50 pages, 30 OCR pages, 120 s per job) keep it bounded.
- JavaScript cannot guarantee secure erasure of memory (see `SECURITY.md`).
- GitHub Pages cannot send security headers; the meta CSP and frame guard compensate partially.
- Formats: PDF, PNG, JPEG, WEBP, DOCX, TXT only. HEIC, TIFF, legacy DOC, ODT, RTF and SVG are rejected.
- The PDF report is produced through the browser's print dialog ("Save as PDF").
