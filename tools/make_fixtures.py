"""Generate controlled test fixtures for S-Way's unit, security and browser tests.

All fixtures are synthetic and harmless: "malicious" files only *look* dangerous
(e.g. an MZ header followed by zeros) so validation logic can be exercised safely.

Usage:  python3 tools/make_fixtures.py
"""
from __future__ import annotations

import io
import math
import random
import struct
import zipfile
import zlib
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

OUT = Path(__file__).resolve().parent.parent / "tests" / "fixtures"
OUT.mkdir(parents=True, exist_ok=True)
random.seed(7)

ESSAY_A = """The Industrial Revolution transformed the way people lived and worked. Before the arrival of factories, most families produced goods at home or in small workshops. Steam power changed this pattern completely, because machines could now run continuously and in one place.

Historians often argue that the revolution began in Britain because the country had abundant coal, a growing population and access to colonial markets. These conditions encouraged investment in new technology. Cotton mills were among the first industries to adopt mechanised production.

The social consequences were profound. Workers moved from villages to crowded cities, where housing was poor and disease spread quickly. Children frequently worked long hours in dangerous conditions. Reformers eventually campaigned for laws that limited working hours and improved safety.

In the long run, industrialisation raised living standards for many people. However, the benefits were unevenly distributed, and the environmental costs are still felt today. Understanding this period helps us think carefully about the technological changes of our own time."""

# B copies some passages exactly, paraphrases others and adds new material.
ESSAY_B = """The Industrial Revolution transformed the way people lived and worked. Before factories appeared, the majority of households made goods in their homes or in little workshops. The introduction of steam power altered this arrangement entirely, since machines were able to operate without stopping in a single location.

Many scholars believe the revolution started in Britain because the country had abundant coal, a growing population and access to colonial markets. Such circumstances promoted investment in novel machinery.

The social consequences were profound. Workers moved from villages to crowded cities, where housing was poor and disease spread quickly. Railways later connected these cities and allowed goods to travel much faster than before.

Looking back, we can see that the period created both opportunity and suffering, and its lessons remain relevant whenever a new technology reshapes society."""

ESSAY_C = """Volcanoes form where molten rock reaches the surface of the Earth. Most of them are found along the edges of tectonic plates, especially around the Pacific Ocean. When pressure builds beneath the crust, magma rises through cracks and erupts as lava, ash and gas.

Scientists monitor volcanoes with seismometers, satellite images and gas sensors. Small earthquakes and changes in the shape of the ground can warn that an eruption is coming. Even so, predicting the exact timing remains difficult.

Eruptions can be destructive, but volcanic soil is also extremely fertile. Farmers in many regions grow coffee, fruit and vegetables on the slopes of active volcanoes. Living near a volcano therefore involves a careful balance between risk and reward."""


def font(size: int, mono: bool = False):
    name = "/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf" if mono else "/usr/share/fonts/truetype/dejavu/DejaVuSerif.ttf"
    try:
        return ImageFont.truetype(name, size)
    except OSError:
        return ImageFont.load_default()


def wrap(text: str, width: int) -> list[str]:
    lines = []
    for para in text.split("\n\n"):
        words, line = para.split(), ""
        for w in words:
            if len(line) + len(w) + 1 > width:
                lines.append(line)
                line = w
            else:
                line = f"{line} {w}".strip()
        lines.append(line)
        lines.append("")
    return lines


def printed_page(text: str, path: Path, skew: float = 0.0, noise: int = 0):
    img = Image.new("L", (1240, 1754), 250)
    d = ImageDraw.Draw(img)
    f = font(26)
    y = 120
    for line in wrap(text, 70):
        d.text((110, y), line, font=f, fill=25)
        y += 40
    if skew:
        img = img.rotate(skew, expand=False, fillcolor=250, resample=Image.BICUBIC)
    if noise:
        px = img.load()
        for _ in range(noise):
            x, yy = random.randrange(img.width), random.randrange(img.height)
            px[x, yy] = random.randrange(0, 255)
    img.save(path)


def synthetic_handwriting(path: Path, *, slant: float, stroke: int, size: int, spacing: float, jitter: float, seed: int, lines: int = 8):
    """Draw pseudo-handwriting: per-'letter' random cursive loops with writer-specific parameters."""
    rng = random.Random(seed)
    W, H = 1400, 1000
    img = Image.new("L", (W, H), 245)
    d = ImageDraw.Draw(img)
    shear = math.tan(math.radians(slant))
    y0 = 90
    for _ in range(lines):
        x = 80 + rng.uniform(-10, 10)
        base = y0 + rng.uniform(-jitter, jitter)
        while x < W - 160:
            n_letters = rng.randint(2, 7)
            pts = []
            for _l in range(n_letters):
                h = size * rng.uniform(0.7, 1.0) * (1.8 if rng.random() < 0.18 else 1.0)
                wl = size * rng.uniform(0.45, 0.75)
                for t in range(9):
                    a = t / 8 * math.pi * 2
                    px = x + wl * (t / 8) + math.sin(a) * wl * 0.25
                    py = base - (h * (0.5 - 0.5 * math.cos(a))) + rng.uniform(-jitter, jitter) * 0.3
                    px += (base - py) * shear
                    pts.append((px, py))
                x += wl
            d.line(pts, fill=30, width=stroke, joint="curve")
            x += size * spacing * rng.uniform(0.8, 1.2)
        y0 += size * 2.6
    img.save(path)


def synthetic_signature(path: Path, seed: int, variation: float, size=(600, 240)):
    rng = random.Random(seed)
    base = random.Random(1000 + seed // 100)  # writers share a base path when seed//100 equal
    img = Image.new("L", size, 250)
    d = ImageDraw.Draw(img)
    pts = []
    n = 60
    ctrl = [(base.uniform(0, 1), base.uniform(-1, 1)) for _ in range(9)]
    for i in range(n):
        t = i / (n - 1)
        k = t * (len(ctrl) - 1)
        j = min(int(k), len(ctrl) - 2)
        f = k - j
        cx = ctrl[j][0] * (1 - f) + ctrl[j + 1][0] * f
        cy = ctrl[j][1] * (1 - f) + ctrl[j + 1][1] * f
        x = 60 + t * (size[0] - 120) + math.sin(t * 18 + cx * 6) * 25 + rng.gauss(0, variation)
        y = size[1] / 2 + cy * 60 + math.cos(t * 11) * 20 + rng.gauss(0, variation)
        pts.append((x, y))
    d.line(pts, fill=20, width=4, joint="curve")
    d.line([(pts[5][0], pts[-1][1] + 30), (pts[-5][0], pts[-1][1] + 34)], fill=20, width=3)
    img.save(path)


def png_bomb_header(path: Path):
    """A tiny PNG that *declares* 50000x50000 pixels (decompression-bomb shape)."""
    def chunk(t, data):
        return struct.pack(">I", len(data)) + t + data + struct.pack(">I", zlib.crc32(t + data) & 0xFFFFFFFF)
    raw = zlib.compress(b"\x00" * 1000)
    data = b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", 50000, 50000, 8, 0, 0, 0, 0)) + chunk(b"IDAT", raw) + chunk(b"IEND", b"")
    path.write_bytes(data)


def make_docx(text: str, path: Path):
    from docx import Document
    doc = Document()
    doc.add_heading("Essay draft", level=1)
    for para in text.split("\n\n"):
        doc.add_paragraph(para)
    doc.save(path)


def make_pdf(text: str, path: Path, pages: int = 1, title="Sample"):
    from reportlab.lib.pagesizes import A4
    from reportlab.pdfgen import canvas
    c = canvas.Canvas(str(path), pagesize=A4)
    c.setTitle(title)
    c.setAuthor("Fixture Generator")
    for p in range(pages):
        y = 780
        c.setFont("Times-Roman", 12)
        for line in wrap(text, 85):
            c.drawString(72, y, line)
            y -= 16
            if y < 72:
                break
        c.drawString(290, 40, str(p + 1))
        c.showPage()
    c.save()


def zip_bytes(entries: dict[str, bytes], compress=zipfile.ZIP_DEFLATED) -> bytes:
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", compress) as z:
        for name, data in entries.items():
            z.writestr(name, data)
    return buf.getvalue()


CT = b'<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>'
DOC = b'<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Hello</w:t></w:r></w:p></w:body></w:document>'


def photographed(src: Path, path: Path, seed: int = 3):
    """Simulate a phone photo: the page sits in perspective on a darker, uneven desk."""
    rng = random.Random(seed)
    page = Image.open(src).convert("L")
    W, H = 1500, 1900
    desk = Image.new("L", (W, H), 70)
    d = ImageDraw.Draw(desk)
    for _ in range(400):
        x, y = rng.randrange(W), rng.randrange(H)
        d.ellipse((x, y, x + rng.randint(20, 90), y + rng.randint(4, 14)), fill=rng.randint(55, 90))
    pw, ph = page.size
    # Target corners of the sheet in the photo (tl, tr, br, bl).
    dst = [(170, 140), (1330, 210), (1390, 1760), (110, 1690)]
    src = [(0, 0), (pw, 0), (pw, ph), (0, ph)]
    coeffs = _perspective_coeffs(dst, src)
    warped = page.transform((W, H), Image.PERSPECTIVE, coeffs, Image.BICUBIC, fillcolor=0)
    mask = Image.new("L", page.size, 255).transform((W, H), Image.PERSPECTIVE, coeffs, Image.BICUBIC, fillcolor=0)
    desk.paste(warped, (0, 0), mask)
    desk.save(path)


def _perspective_coeffs(dst, src):
    import numpy as np
    A = []
    for (x, y), (u, v) in zip(dst, src, strict=True):
        A.append([x, y, 1, 0, 0, 0, -u * x, -u * y])
        A.append([0, 0, 0, x, y, 1, -v * x, -v * y])
    b = [c for pt in src for c in pt]
    return np.linalg.solve(np.array(A, float), np.array(b, float)).tolist()


def copy_move(src: Path, path: Path, box=(140, 160, 520, 300), to=(560, 1250)):
    """Copy a region of a page and paste it elsewhere on the same page (copy-move forgery)."""
    img = Image.open(src).convert("L")
    patch = img.crop(box)
    img.paste(patch, to)
    img.save(path)


def main():
    (OUT / "essay_a.txt").write_text(ESSAY_A, encoding="utf-8")
    (OUT / "essay_b.txt").write_text(ESSAY_B, encoding="utf-8")
    (OUT / "essay_c.txt").write_text(ESSAY_C, encoding="utf-8")
    make_docx(ESSAY_B, OUT / "essay_b.docx")
    make_pdf(ESSAY_A, OUT / "essay_a.pdf", pages=2, title="Essay A")
    make_pdf(ESSAY_C, OUT / "too_many_pages.pdf", pages=55)
    printed_page(ESSAY_A, OUT / "scan_a.png", skew=1.2, noise=3000)
    Image.open(OUT / "scan_a.png").convert("RGB").save(OUT / "scan_a.jpg", quality=88)
    Image.open(OUT / "scan_a.png").save(OUT / "scan_a.webp", quality=85)
    synthetic_handwriting(OUT / "hand_writer1_a.png", slant=18, stroke=4, size=34, spacing=0.9, jitter=4, seed=11)
    synthetic_handwriting(OUT / "hand_writer1_b.png", slant=17, stroke=4, size=35, spacing=0.95, jitter=4, seed=12)
    synthetic_handwriting(OUT / "hand_writer2_a.png", slant=-6, stroke=7, size=46, spacing=1.6, jitter=9, seed=21)
    synthetic_signature(OUT / "sig_person1_a.png", seed=101, variation=1.5)
    synthetic_signature(OUT / "sig_person1_b.png", seed=102, variation=1.5)
    synthetic_signature(OUT / "sig_person2_a.png", seed=201, variation=1.5)

    # ---- attack / malformed fixtures (all harmless) ----
    (OUT / "fake_pdf.pdf").write_bytes(b"MZ\x90\x00" + b"\x00" * 2000)  # executable disguised as PDF
    (OUT / "renamed_exe.txt").write_bytes(b"MZ\x90\x00\x03" + b"\x00" * 500)
    (OUT / "png_named.jpg").write_bytes((OUT / "scan_a.png").read_bytes())
    (OUT / "corrupt.pdf").write_bytes(b"%PDF-1.7\n1 0 obj << /Type /Catalog >> endobj\ntrailer garbage without end marker")
    (OUT / "truncated.png").write_bytes((OUT / "scan_a.png").read_bytes()[:4000])
    (OUT / "script.html").write_bytes(b"<!doctype html><script>alert(1)</script>")
    (OUT / "html_as.txt").write_bytes(b"<!doctype html><html><script>alert(1)</script></html>")
    (OUT / "image.svg").write_bytes(b'<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>')
    (OUT / "archive.zip").write_bytes(zip_bytes({"a.txt": b"hello"}))
    (OUT / "empty.txt").write_bytes(b"")
    (OUT / "binary.txt").write_bytes(bytes(range(256)) * 4)
    png_bomb_header(OUT / "huge_dimensions.png")
    (OUT / "zip_bomb.docx").write_bytes(zip_bytes({"[Content_Types].xml": CT, "word/document.xml": DOC, "word/bomb.xml": b"\x00" * (60 * 1024 * 1024)}))
    (OUT / "ratio_bomb.docx").write_bytes(zip_bytes({"[Content_Types].xml": CT, "word/document.xml": DOC, "word/media/pad.bin": b"A" * (8 * 1024 * 1024)}))
    (OUT / "traversal.docx").write_bytes(zip_bytes({"[Content_Types].xml": CT, "word/document.xml": DOC, "../../evil.sh": b"echo hi"}))
    (OUT / "too_many_entries.docx").write_bytes(zip_bytes({"[Content_Types].xml": CT, "word/document.xml": DOC, **{f"word/x{i}.xml": b"x" for i in range(1100)}}))
    (OUT / "macro.docx").write_bytes(zip_bytes({"[Content_Types].xml": CT, "word/document.xml": DOC, "word/vbaProject.bin": b"\x00" * 100}))
    (OUT / "not_word.docx").write_bytes(zip_bytes({"hello.txt": b"just a zip"}))
    xxe = b'<?xml version="1.0"?><!DOCTYPE d [<!ENTITY a "aaaaaaaaaa"><!ENTITY b "&a;&a;&a;&a;&a;&a;&a;&a;">]><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>&b;</w:t></w:r></w:p></w:body></w:document>'
    (OUT / "entity_expansion.docx").write_bytes(zip_bytes({"[Content_Types].xml": CT, "word/document.xml": xxe}))

    # Symlink entry (unix mode 0o120777).
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as z:
        z.writestr("[Content_Types].xml", CT)
        z.writestr("word/document.xml", DOC)
        info = zipfile.ZipInfo("word/link")
        info.create_system = 3
        info.external_attr = (0o120777 << 16)
        z.writestr(info, "/etc/passwd")
    (OUT / "symlink.docx").write_bytes(buf.getvalue())
    photographed(OUT / "scan_a.png", OUT / "photo_page.jpg")
    Image.open(OUT / "photo_page.jpg").save(OUT / "photo_page.png")  # PNG copy for Node tests
    copy_move(OUT / "scan_a.png", OUT / "tampered_copy_move.png")
    print("fixtures written to", OUT)


if __name__ == "__main__":
    main()
