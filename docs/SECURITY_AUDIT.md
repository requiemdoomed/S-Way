# Security audit — S-Way 1.1.0

**Date:** 4 November 2026 · **Scope:** the client-side application, its static-hosting configuration, research tooling · **Method:** automated tests (113), static analysis, dependency audits, manual review · **Author of the system:** Swayam Shakya

## Release status

**Release candidate — functionally and security-verified locally. NOT yet verified as deployed.** Items marked *pending deployment* below can only be checked against the live production URL. Do not call the public deployment approved until those are ticked.

## Acceptance criteria (specification §13)

| Criterion | Status | Evidence |
|---|---|---|
| Anonymous users cannot access another user's active analysis | ✅ | No server or shared state exists; data lives only in each tab's memory |
| No mandatory accounts or passwords | ✅ | No auth code exists |
| Rate limits work | ✅ | unit: sliding window, Retry-After, separate budgets; e2e: message after 11 uploads |
| Concurrent-job limits work | ✅ | unit: queue refuses 3rd job / duplicates |
| Processing queues are bounded | ✅ | unit: QueueFullError; max 1 running + 2 pending |
| Upload size limits work | ✅ | unit: 15 MB, batch 10 files / 40 MB, 2 M chars |
| File signatures are verified | ✅ | unit + e2e: disguised executable, PNG-as-JPG, HTML-as-TXT |
| MIME spoofing is rejected | ✅ | unit: `application/x-msdownload` on a real PDF |
| Path traversal is prevented | ✅ | unit: filenames and archive entries; dev server: `../` and `%2e%2e` → 404 |
| Malformed files are rejected safely | ✅ | unit + e2e: corrupt PDF, truncated PNG, non-Word ZIP, empty/binary TXT |
| Archive expansion is restricted | ✅ | unit + e2e: ZIP bomb, ratio bomb, > 1000 entries, lying sizes, symlink |
| PDF page and rendering limits work | ✅ | e2e: 55-page PDF rejected; render scale/side caps in code |
| Image dimension limits work | ✅ | unit + e2e: 50,000² PNG rejected from header without decoding |
| OCR and ML operations have timeouts | ✅ | unit: timeout/abort hooks; e2e: cancel terminates OCR job |
| Temporary workspaces are isolated | ✅ | per-tab memory; per-document random IDs; no shared storage |
| Temporary files cleaned after success and failure | ✅ | no files are written; OCR worker terminated after every job (`finally`), queue cleanup counters, e2e session clear |
| Reports are not publicly accessible | ✅ | reports never get URLs; in-memory downloads only |
| Access tokens expire | ✅ (N/A) | no access tokens exist; object URLs are revoked after download/clear |
| No document content stored in cookies | ✅ | e2e: `document.cookie === ""`; unit: no cookie writes in code |
| No tracking cookies by default | ✅ | as above; no analytics code |
| No permanent document database required | ✅ | opt-in IndexedDB stores reports only, never files |
| No document content appears in logs | ✅ | no logging; two generic console messages; e2e asserts clean console |
| CORS is restricted | ✅ (N/A) | no API; CSP `connect-src 'self'`; e2e: zero cross-origin requests |
| HTTPS is enabled in production | ⏳ pending deployment | GitHub Pages "Enforce HTTPS" / proxy TLS |
| Security headers are configured | ✅ local / ⏳ live | dev server verified with curl; `_headers`/nginx provided; meta CSP everywhere |
| Dependencies are audited | ✅ | npm audit 0; pip-audit (see below) |
| No secrets are committed | ✅ | secret scan 0 findings; no secrets exist |
| Security tests executed and recorded | ✅ | `docs/TESTING.md` |
| Remaining risks documented | ✅ | below and `SECURITY.md` |

## Tool results

| Tool | Result |
|---|---|
| `node --test` (84) | 84 passed |
| `pytest tests/e2e` (29) | 29 passed |
| `npm audit` (vendor-src: pdfjs-dist 6.5.438, tesseract.js 7.0.0, tesseract.js-core 7.0.0, chart.js 4.6.1, fonts) | 0 vulnerabilities |
| `pip-audit` (research requirements) | Pillow 12.3.0 had 5 advisories (CVE-2026-112393, CVE-2026-96638, CVE-2026-96640, CVE-2026-96778, GHSA-78g4-xqwv-q3g8) → **pinned Pillow 13.0.0**. Pillow only processes the developer's synthetic research images, never user uploads. |
| `bandit` | 0 medium/high. 70 low: 58× B101 `assert` in tests, 9× B311 `random` for synthetic data generation, B404/B603/B607 for the research CLI calling `node` with fixed arguments — all accepted. |
| `ruff` (E, F, W, B, S) | clean (duplicate keys, `zip(strict=)` and a lambda assignment fixed) |
| `pip-audit` (requirements.txt, v1.1) | no known vulnerabilities |
| `tools/secret_scan.py` | 0 findings |
| Dev-server probe (`curl`) | CSP incl. `frame-ancestors 'none'`, nosniff, DENY, no-referrer, Permissions-Policy, COOP/CORP present; traversal 404; `/tests/` 404; directory listing 404; POST 405 |

## Issues found during the audit and fixed

1. PDF preview failed (`pdf.destroy` removed in PDF.js 6) — fixed to destroy the loading task.
2. Tesseract.js 7 required core 7's relaxed-SIMD build; OCR silently produced no text — re-vendored core 7; OCR warnings now shown on document cards.
3. Handwriting line screening ran on printed pages, flagging spurious anomalies — now only on handwritten pages.
4. Static caveats were counted as "reduced reliability" in the evidence matrix — moved into the basis text.
5. Mobile overflow on the overview and upload pages — fixed; e2e checks horizontal scroll at 375 px.
6. Text-threshold grid search favoured the lowest thresholds on ties — now prefers the most conservative.
7. Signature mask excluded pixels exactly at the Otsu threshold — fixed (`≤`).
8. Font licence for Special Elite was mislabelled OFL; it is Apache-2.0 — corrected.

**Release 1.1 review**

9. New same-origin fetches (bundled samples, notebooks) were caught by the static fetch-allowlist test and explicitly approved; everything else remains forbidden.
10. The notebook viewer renders untrusted-format JSON: HTML outputs are never rendered, Markdown is converted through the DOM builder, only base64 PNG images (`data:image/png`) are allowed, external links become plain text; an E2E test checks for absence of script/iframe/style in rendered notebooks.
11. The dev server, nginx config and Pages workflow publish only `notebooks/index.json` and `notebooks/NN_name.ipynb`; the research corpus and generated images stay unpublished.
12. Copy-move screening was tuned to avoid false accusations (0 false alarms on held-out clean pages); its wording in reports lists innocent explanations.

## Known issues / residual risks

| # | Risk | Severity | Mitigation / status |
|---|---|---|---|
| R1 | GitHub Pages cannot send headers (no `frame-ancestors`, HSTS, Permissions-Policy) | Low | meta CSP + JS frame guard; use `_headers` host for full headers |
| R2 | Zero-day in PDF.js, Tesseract or the browser's image decoders | Medium | validation, header dimension checks, disabled PDF scripting/fonts, worker isolation, timeouts; keep `vendor/` updated |
| R3 | Client-side rate limits can be bypassed by the user on their own device | Informational | only affects the user's own device |
| R4 | Memory remanence after clearing | Low | buffers zeroed and dropped; documented |
| R5 | Opt-in saved reports are unencrypted | Low | off by default; warning shown; delete-all provided |
| R6 | ML thresholds not validated on real casework | Medium (misuse risk) | qualitative labels only, disclaimers, alternative explanations, conflict notes |
| R7 | Only Chromium tested | Low | test Firefox/Safari before release |
| R8 | Dockerfile not built/tested | Low | optional deployment path |
| R9 | Copy-move screening misses rescaled/spliced edits; users may over-read a clean result | Medium (misuse risk) | limitation stated in report, model card, limitations and About page |

**Never claimed:** perfect security, anonymity, end-to-end encryption, or secure deletion.
