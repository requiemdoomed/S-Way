# Deploying S-Way

S-Way is a static site. Any HTTPS static host works; there is no backend, database, API URL or secret to configure.

## Option A — GitHub Pages (recommended, matches the specification)

1. Push the repository to GitHub (branch `main`).
2. *Settings → Pages → Build and deployment → Source: GitHub Actions.*
3. The workflow `.github/workflows/ci-and-pages.yml` runs all unit, browser, security and audit checks, then publishes only the application files (`index.html`, `assets/`, `css/`, `js/`, `vendor/`, `models/`). Tests, notebooks and tooling are **not** published.
4. Keep *Enforce HTTPS* ticked in the Pages settings.

GitHub Pages cannot set response headers. S-Way's `<meta>` CSP still applies (no inline scripts, no external origins), and the frame guard prevents clickjacking while JavaScript runs. For full header support use option B or C.

## Option B — Netlify or Cloudflare Pages

Publish the same application files and copy `deployment/_headers` to the site root. This adds `frame-ancestors 'none'`, HSTS, `X-Frame-Options`, `Permissions-Policy`, COOP/CORP. Only enable HSTS once HTTPS works on the final domain.

## Option C — your own server / container

```bash
docker build -f deployment/Dockerfile -t s-way .
docker run --rm -p 8080:8080 --read-only --tmpfs /tmp:size=8m \
  --cap-drop ALL --security-opt no-new-privileges \
  --memory 128m --cpus 0.5 --pids-limit 64 s-way
```

Put it behind a TLS-terminating proxy and enable the commented HSTS line in `deployment/nginx.conf`. The nginx config is read-only (GET/HEAD), lists no directories, keeps no access log and refuses request bodies — the server never receives documents.

## Local development

```bash
npm start            # http://127.0.0.1:8000 with production security headers
```

No install step is needed for the app itself (Node ≥ 20 only for the dev server and tests).

## Post-deployment checks

- Open the site, then *Privacy center*: cookies "None set", external processing "0 outside requests", model thresholds "Verified (SHA-256)", secure context "Yes".
- `curl -sI https://<your-site>/` — confirm headers (options B/C).
- Upload `tests/fixtures/essay_a.txt` and `essay_b.docx`, run an analysis, export JSON.
- Browser console must be clean.
