"""End-to-end browser tests for S-Way (Playwright + pytest).

Run:  python3 -m pytest tests/e2e -q
The suite serves the repository over a local HTTP server and drives Chromium.
Every request is checked: any request to another origin fails the test run.
"""
from __future__ import annotations

import functools
import http.server
import json
import re
import socketserver
import threading
from pathlib import Path

import pytest
from playwright.sync_api import sync_playwright, expect

ROOT = Path(__file__).resolve().parents[2]
FX = ROOT / "tests" / "fixtures"


class QuietHandler(http.server.SimpleHTTPRequestHandler):
    extensions_map = {**http.server.SimpleHTTPRequestHandler.extensions_map, ".mjs": "text/javascript", ".wasm": "application/wasm"}

    def log_message(self, *args):  # keep test output clean
        pass


@pytest.fixture(scope="session")
def server():
    handler = functools.partial(QuietHandler, directory=str(ROOT))
    socketserver.TCPServer.allow_reuse_address = True
    httpd = socketserver.ThreadingTCPServer(("127.0.0.1", 0), handler)
    port = httpd.server_address[1]
    t = threading.Thread(target=httpd.serve_forever, daemon=True)
    t.start()
    yield f"http://127.0.0.1:{port}"
    httpd.shutdown()


@pytest.fixture(scope="session")
def browser():
    with sync_playwright() as p:
        b = p.chromium.launch()
        yield b
        b.close()


@pytest.fixture()
def page(browser, server):
    ctx = browser.new_context(viewport={"width": 1360, "height": 900}, accept_downloads=True)
    pg = ctx.new_page()
    pg.errors = []
    pg.foreign = []
    pg.on("pageerror", lambda e: pg.errors.append(str(e)))
    pg.on("console", lambda m: pg.errors.append(m.text) if m.type == "error" else None)
    pg.on("request", lambda r: pg.foreign.append(r.url) if not (r.url.startswith(server) or r.url.startswith(("blob:", "data:"))) else None)
    pg.base = server
    yield pg
    assert not pg.foreign, f"requests left the site: {pg.foreign}"
    ctx.close()


def goto(page, route="overview"):
    page.goto(f"{page.base}/index.html#/{route}")
    page.wait_for_selector("#view h1")


def upload(page, files):
    goto(page, "analysis")
    payload = []
    for f in files:
        if isinstance(f, dict):
            payload.append(f)
        else:
            payload.append(str(FX / f))
    page.set_input_files("#file-input", payload)


def wait_js(page, expr, timeout=30000):
    """Poll a JS expression. (page.wait_for_function relies on eval, which S-Way's CSP blocks.)"""
    waited = 0
    while waited < timeout:
        if page.evaluate(expr):
            return
        page.wait_for_timeout(200)
        waited += 200
    raise AssertionError(f"timed out waiting for: {expr}")


def wait_settled(page, n):
    wait_js(page, f"document.querySelectorAll('.doc-card').length === {n} && ![...document.querySelectorAll('.doc-card .stamp')].some(s => s.textContent === 'Checking')")


# ------------------------------------------------------------------ privacy & browser security
def test_loads_clean_with_no_storage_cookies_or_foreign_requests(page):
    goto(page)
    page.wait_for_timeout(800)
    assert page.evaluate("document.cookie") == ""
    assert page.evaluate("localStorage.length") == 0
    assert page.evaluate("sessionStorage.length") == 0
    assert page.evaluate("indexedDB.databases().then(d => d.length)") == 0
    csp = page.get_attribute('meta[http-equiv="Content-Security-Policy"]', "content")
    for directive in ["default-src 'none'", "script-src 'self'", "object-src 'none'", "base-uri 'self'", "form-action 'none'", "connect-src 'self'"]:
        assert directive in csp
    assert "unsafe-inline" not in csp and "unsafe-eval" not in csp
    assert page.errors == [], page.errors


def test_csp_blocks_inline_script_and_foreign_fetch(page):
    goto(page)
    page.evaluate("""() => { const s = document.createElement('script'); s.textContent = 'window.__inline = 1'; document.body.append(s); }""")
    assert page.evaluate("window.__inline") is None
    blocked = page.evaluate("fetch('https://example.com/').then(() => 'sent').catch(() => 'blocked')")
    assert blocked == "blocked"
    page.errors.clear()  # the CSP violation reports above are expected
    page.foreign.clear()


def test_refuses_to_render_inside_a_frame(browser, server):
    ctx = browser.new_context()
    pg = ctx.new_page()
    # A page that tries to embed S-Way (served at a path the real site does not have).
    pg.route(f"{server}/__framer.html", lambda r: r.fulfill(content_type="text/html", body=f'<iframe src="{server}/index.html" width=800 height=600></iframe>'))
    pg.goto(f"{server}/__framer.html")
    pg.wait_for_timeout(1000)
    frame = pg.frames[1]
    assert "cannot be displayed inside another website" in frame.inner_text("body")
    ctx.close()


def test_privacy_center_reports_live_status_and_verified_calibration(page):
    goto(page, "privacy")
    expect(page.locator(".switchboard")).to_contain_text("None set")
    expect(page.locator(".switchboard")).to_contain_text("0 outside requests")
    expect(page.locator(".switchboard")).to_contain_text("Verified (SHA-256)")


# ------------------------------------------------------------------ upload validation in the browser
def test_malicious_and_malformed_uploads_are_rejected(page):
    files = ["fake_pdf.pdf", "zip_bomb.docx", "traversal.docx", "huge_dimensions.png", "script.html", "macro.docx", "corrupt.pdf", "too_many_pages.pdf", "essay_a.txt"]
    upload(page, files)
    wait_settled(page, len(files))
    page.wait_for_timeout(500)
    cards = {c.query_selector(".doc-name").inner_text(): c.query_selector(".stamp").inner_text().lower() for c in page.query_selector_all(".doc-card")}
    assert "invalid file signature" in cards["fake_pdf.pdf"]
    assert "unsafe archive" in cards["zip_bomb.docx"]
    assert "unsafe archive" in cards["traversal.docx"]
    assert "resource limit" in cards["huge_dimensions.png"]
    assert "unsupported format" in cards["script.html"]
    assert "unsafe archive" in cards["macro.docx"]
    assert "malformed" in cards["corrupt.pdf"]
    assert "page limit" in cards["too_many_pages.pdf"]
    assert cards["essay_a.txt"] == "accepted"


def test_xss_through_filename_is_rendered_as_text(page):
    name = '<img src=x onerror="window.__xss=1">.txt'
    upload(page, [{"name": name, "mimeType": "text/plain", "buffer": b"Some harmless text for testing purposes only."}])
    wait_settled(page, 1)
    assert page.evaluate("window.__xss") is None
    assert page.locator(".doc-name").inner_text() == name
    assert page.locator(".doc-card img[src='x']").count() == 0


def test_xss_through_extracted_text_is_inert(page):
    # A .txt that *starts* with markup is rejected outright; here the payload sits mid-text.
    evil = (b"The Industrial Revolution transformed the way people lived and worked. " * 10
            + b"<script>window.__xss2=1</script><img src=x onerror=\"window.__xss2=1\"> "
            + b"The Industrial Revolution transformed the way people lived and worked. " * 10)
    upload(page, [{"name": "evil.txt", "mimeType": "text/plain", "buffer": evil},
                  {"name": "essay_a.txt", "mimeType": "text/plain", "buffer": (FX / "essay_a.txt").read_bytes()}])
    wait_settled(page, 2)
    page.get_by_role("button", name="Run analysis").click()
    page.wait_for_url("**#/reports", timeout=60000)
    goto(page, "compare")
    page.wait_for_selector(".text-pane")
    assert page.evaluate("window.__xss2") is None
    assert page.locator(".text-pane script").count() == 0
    assert "<script>" in page.locator(".text-pane").first.inner_text()


# ------------------------------------------------------------------ analysis workflow
def test_full_text_analysis_report_and_exports(page):
    upload(page, ["essay_a.txt", "essay_b.docx", "essay_a.pdf"])
    wait_settled(page, 3)
    page.get_by_role("button", name="Run analysis").click()
    page.wait_for_url("**#/reports", timeout=90000)
    body = page.inner_text("#view")
    assert "Evidence report" in body and "Evidence matrix" in body
    assert "HIGH SIMILARITY" in body.upper()
    assert "S-Way does not establish identity, misconduct, forgery, or plagiarism as a final determination." in body
    assert not re.search(r"\b(forged|cheated|guilty|probability of (common )?authorship is)\b", body, re.I)
    with page.expect_download() as d:
        page.get_by_role("button", name="JSON data").click()
    data = json.loads(Path(d.value.path()).read_text())
    assert data["fusion"]["rows"] and "findings" in data and "diffMap" not in json.dumps(data)
    with page.expect_download() as d2:
        page.get_by_role("button", name="CSV feature table").click()
    assert Path(d2.value.path()).read_text(encoding="utf-8-sig").startswith("module,document_a")
    assert page.errors == [], page.errors


def test_ocr_reads_a_scanned_page(page):
    upload(page, ["scan_a.png"])
    wait_settled(page, 1)
    page.get_by_role("button", name="Extract text only").click()
    wait_js(page, "document.querySelector('.teletype')?.innerText.includes('Extraction complete')", 90000)
    goto(page, "compare")
    page.get_by_role("tab", name="Review & correct text").click()
    page.wait_for_selector("#edit-text")
    assert "Industrial Revolution" in page.input_value("#edit-text")
    expect(page.locator(".metric-list")).to_contain_text("Tesseract")


def test_handwriting_and_signature_modules_and_session_clear(page):
    upload(page, ["hand_writer1_a.png", "hand_writer1_b.png", "sig_person1_a.png", "sig_person1_b.png"])
    wait_settled(page, 4)
    for i, t in enumerate(["handwritten", "handwritten", "signature", "signature"]):
        page.locator("select[id^=type-]").nth(i).select_option(t)
        page.wait_for_timeout(150)
    page.get_by_role("button", name="Run analysis").click()
    page.wait_for_url("**#/reports", timeout=110000)
    body = page.inner_text("#view")
    assert "Handwriting-feature similarity" in body and "Signature visual similarity" in body
    assert not re.search(r"signature (is|was) (authentic|genuine|forged)|forgery detected|same writer confirmed", body, re.I)
    goto(page, "privacy")
    page.get_by_role("button", name="Clear current session").click()
    page.get_by_role("button", name="Clear session").click()
    expect(page.locator(".notice.ok")).to_contain_text("4 documents")
    assert page.inner_text("#session-chip") == "No documents"
    assert page.evaluate("document.querySelectorAll('img[src^=\"blob:\"]').length") == 0


def test_document_text_can_be_corrected_and_original_preserved(page):
    upload(page, ["essay_a.txt"])
    wait_settled(page, 1)
    page.get_by_role("button", name="Extract text only").click()
    wait_js(page, "document.querySelector('.teletype')?.innerText.includes('Extraction complete')", 30000)
    goto(page, "compare")
    page.get_by_role("tab", name="Review & correct text").click()
    page.fill("#edit-text", "Corrected text.")
    page.get_by_role("button", name="Save correction").click()
    expect(page.locator(".metric-list")).to_contain_text("Corrected by you")
    page.locator("details.explain summary").click()
    assert "Industrial Revolution" in page.locator("details.explain .text-pane").inner_text()
    page.get_by_role("button", name="Restore original").click()
    assert "Industrial Revolution" in page.input_value("#edit-text")


def test_rate_limit_message_after_repeated_uploads(page):
    goto(page, "analysis")
    for i in range(11):
        page.set_input_files("#file-input", [{"name": f"t{i}.txt", "mimeType": "text/plain", "buffer": b"hello world text"}])
        page.wait_for_timeout(120)
        if i < 10:
            page.locator(".doc-card").first.wait_for()
            page.get_by_role("button", name=re.compile("^Remove")).first.click()
    expect(page.locator(".toast")).to_contain_text("Too many analysis requests. Please wait before trying again.")


def test_cancel_stops_a_running_job(page):
    upload(page, ["scan_a.png", "scan_a.jpg"])
    wait_settled(page, 2)
    page.get_by_role("button", name="Run analysis").click()
    page.get_by_role("button", name="Cancel").click()
    expect(page.locator(".notice.error")).to_contain_text("cancelled", timeout=20000)


# ------------------------------------------------------------------ layout & navigation
@pytest.mark.parametrize("route", ["overview", "analysis", "compare", "handwriting", "signature", "source", "reports", "research", "privacy", "settings", "about"])
def test_every_route_renders_without_errors(page, route):
    goto(page, route)
    page.wait_for_timeout(300)
    assert page.locator("#nav a[aria-current=page]").get_attribute("data-route") == route
    assert page.errors == [], page.errors


def test_mobile_layout_has_no_horizontal_scroll(browser, server):
    ctx = browser.new_context(viewport={"width": 375, "height": 800})
    pg = ctx.new_page()
    for route in ["overview", "analysis", "privacy"]:
        pg.goto(f"{server}/index.html#/{route}")
        pg.wait_for_selector("#view h1")
        assert pg.evaluate("document.documentElement.scrollWidth <= window.innerWidth + 1"), route
    ctx.close()


def test_theme_toggle_switches_to_lamplight(page):
    goto(page)
    page.click("#theme-toggle")
    assert page.evaluate("document.documentElement.dataset.theme") in ("dark", "light")
    bg = page.evaluate("getComputedStyle(document.body).backgroundColor")
    assert bg in ("rgb(26, 19, 14)", "rgb(201, 180, 142)")


# ------------------------------------------------------------------ v1.1 features
def test_sample_sets_load_through_validation_and_compare_peers(page):
    goto(page, "analysis")
    page.get_by_role("button", name="Load 3 files").first.click()
    wait_settled(page, 3)
    assert page.locator(".doc-card .stamp", has_text="Accepted").count() == 3
    assert page.locator("select[id^=role-]").first.input_value() == "source"
    page.get_by_role("button", name="Run analysis").click()
    page.wait_for_url("**#/reports", timeout=60000)
    body = page.inner_text("#view")
    assert "Similarity matrix" in body
    assert "not compared" not in page.inner_text("#rep-heat"), "submissions must also be compared with each other"


def test_photographed_page_is_rectified_before_ocr_and_tampering_is_flagged(page):
    goto(page, "analysis")
    page.get_by_role("button", name="Load 3 files").nth(3).click()
    wait_settled(page, 3)
    page.get_by_role("button", name="Run analysis").click()
    page.wait_for_url("**#/reports", timeout=120000)
    rows = page.locator("#rep-summary table tbody tr")
    photo = rows.filter(has_text="photo_page.jpg").inner_text()
    conf = int(re.search(r"OCR (\d+)%", photo).group(1))
    assert conf >= 85, photo
    body = page.inner_text("#view")
    assert "Duplicated region" in body and "appears twice" in body
    assert page.locator(".dup-figure canvas").count() == 1
    assert "perspective was corrected automatically" in body


def test_research_viewer_renders_executed_notebooks_safely(page):
    goto(page, "research")
    expect(page.locator(".pinboard .note")).to_have_count(7)
    page.locator(".pinboard .note", has_text="06").click()
    page.wait_for_selector(".notebook .nb-img", timeout=20000)
    assert page.locator(".notebook .nb-img").count() >= 2
    assert all(src.startswith("data:image/png;base64,") for src in page.eval_on_selector_all(".notebook img", "els => els.map(e => e.getAttribute('src'))"))
    assert page.locator(".notebook script, .notebook iframe, .notebook style").count() == 0
    assert "copy-move" in page.inner_text(".notebook").lower()
    assert page.errors == [], page.errors
