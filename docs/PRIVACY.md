# S-Way privacy notice

**Short version:** your documents never leave your browser tab. S-Way has no server that receives files, no accounts, no cookies, no analytics, and nothing is stored after you close the tab unless you explicitly turn on report saving.

| Question | Answer |
|---|---|
| **What is processed?** | The files you choose; their extracted text, page images and the measurements S-Way computes; the roles and corrections you enter. |
| **Why?** | Only to produce the comparison report you request. |
| **Does it leave the browser?** | No. Validation, PDF reading, OCR, image analysis, comparisons and report generation all run in your browser using code and data served by the S-Way site. The Content-Security-Policy forbids contacting any other origin, and the code contains no upload request. |
| **Does it reach a Python server?** | No. S-Way has no backend. The Jupyter notebooks are an offline research tool used by the developer to evaluate methods and set thresholds; they never receive user documents. |
| **External providers?** | None. Fonts, the OCR engine and its English language data, the PDF engine and the chart library are bundled with the site. |
| **Cookies?** | None are set. S-Way does not need cookies for security or privacy, and shows no cookie banner because there is nothing to consent to. |
| **Browser storage?** | Nothing by default — not localStorage, sessionStorage or IndexedDB. OCR language data is not cached. Theme and settings live in memory and reset on reload. |
| **Optional saving** | If you enable *Save reports on this device* in Settings, finished reports (findings, measurements and short text excerpts — never the uploaded files) are stored in this browser's IndexedDB. This storage is **not encrypted**; anyone with access to the browser profile can read it. Delete everything with *Delete all saved reports* (Settings) or the checkbox under *Clear current session* (Privacy Center). |
| **How is temporary data deleted?** | When you remove a document, clear the session, leave the tab idle for 30 minutes, or close/reload the tab: byte buffers are overwritten and released, page previews (object URLs) are revoked, workers are terminated, reports are dropped. |
| **What does the host see?** | Like any website, the hosting provider (e.g. GitHub Pages) sees that your browser requested S-Way's files (IP address, time, user agent) under its own policy. It never sees your documents. |

## Retention behaviour (actual)

- Uploaded bytes: in memory from selection until removal/clear/idle/tab close. Rejected files are dropped immediately after validation.
- Extracted text, page images, measurements and reports: same lifetime as above. Up to 5 reports per tab are kept so you can switch between them.
- Downloads you make (PDF/JSON/CSV/PNG) are saved by your browser; S-Way cannot delete those.

## Limitations

- JavaScript cannot securely erase memory. After clearing, data may remain until the browser's garbage collector reuses it, and the operating system may have paged memory to disk.
- Browser extensions and a compromised device can see everything you view in any tab.
- S-Way does not provide anonymity or end-to-end encryption — it avoids transmitting your documents at all, which is a different and simpler guarantee.

## Sensitive content

Documents may contain names, student numbers, addresses or signatures. S-Way does not extract or index personal data specifically, never logs document content, and does not display PDF/DOCX author names (DOCX creator fields are shown only as "present").

Contact: the project author, Swayam Shakya.
