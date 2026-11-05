"""Shared helpers for the S-Way research notebooks.

Key design choice: evaluations call the shipped JavaScript engines through
tools/sway-cli.mjs, so every number reported describes the code the browser runs.

Datasets used:
  * Project Gutenberg selection from the NLTK data repository (public domain texts).
  * Synthetic handwriting / signature images generated here (no personal data;
    real handwriting datasets such as IAM or CEDAR require registration/licences and
    were not available offline). Results on synthetic data DO NOT describe real-world
    accuracy; they verify that the pipeline behaves sensibly and give starting thresholds.
"""
from __future__ import annotations

import json
import math
import random
import re
import subprocess
import tempfile
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFilter

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "notebooks" / "data"
GUT = DATA / "gutenberg"
CLI = ROOT / "tools" / "sway-cli.mjs"
WORK = DATA / "generated"
WORK.mkdir(parents=True, exist_ok=True)


# --------------------------------------------------------------------------- JS bridge
def run_js(tasks: list[dict], batch: int = 200) -> list[dict]:
    """Run tasks through the shipped JavaScript engines (in batches)."""
    out: list[dict] = []
    for i in range(0, len(tasks), batch):
        with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False) as f:
            json.dump({"tasks": tasks[i:i + batch]}, f)
            path = f.name
        res = subprocess.run(["node", str(CLI), path], capture_output=True, text=True, check=True)
        out.extend(json.loads(res.stdout))
        Path(path).unlink(missing_ok=True)
    return out


# --------------------------------------------------------------------------- texts
def load_book(name: str) -> str:
    text = (GUT / name).read_text(encoding="latin-1")
    text = re.sub(r"\[.*?\]", " ", text[:2_000_000])
    return text


def author_of(name: str) -> str:
    return name.split("-")[0]


def sentences(text: str) -> list[str]:
    flat = re.sub(r"\s+", " ", text)
    parts = re.split(r"(?<=[.!?])\s+(?=[A-Z\"'])", flat)
    return [p.strip() for p in parts if 6 <= len(p.split()) <= 60]


def passage(sents: list[str], start: int, words: int) -> list[str]:
    out, n = [], 0
    for s in sents[start:]:
        out.append(s)
        n += len(s.split())
        if n >= words:
            break
    return out


SYNONYMS = {
    "said": "remarked", "great": "considerable", "little": "small", "very": "extremely", "old": "aged",
    "began": "started", "house": "home", "came": "arrived", "went": "proceeded", "saw": "noticed",
    "thought": "believed", "good": "fine", "quite": "rather", "often": "frequently",
    "always": "invariably", "never": "not once", "however": "nevertheless", "because": "since",
    "began to": "started to", "himself": "he himself", "answered": "replied",
    "asked": "inquired", "looked": "glanced", "small": "tiny", "felt": "sensed", "knew": "understood",
    "shall": "will", "upon": "on", "whilst": "while", "perhaps": "maybe", "indeed": "truly",
    "speak": "talk", "spoke": "talked", "happy": "glad", "sad": "unhappy", "quickly": "rapidly",
    "find": "discover", "found": "discovered", "made": "created", "make": "create", "help": "assist",
    "begin": "commence", "end": "finish", "seemed": "appeared", "seem": "appear", "large": "sizeable",
    "almost": "nearly", "enough": "sufficient", "whole": "entire", "show": "display", "told": "informed",
}


def paraphrase(sentence: str, rng: random.Random, strength: float = 0.6) -> str:
    """Rule-based paraphrase: synonym substitution, clause swap and function-word edits."""
    words = sentence.split()
    out = []
    for w in words:
        core = re.sub(r"[^\w']", "", w).lower()
        if core in SYNONYMS and rng.random() < strength:
            rep = SYNONYMS[core]
            if w[0].isupper():
                rep = rep[0].upper() + rep[1:]
            w = w.replace(re.sub(r"[^\w']", "", w), rep)
        elif core in {"the", "a"} and rng.random() < strength * 0.3:
            continue
        out.append(w)
    s = " ".join(out)
    if "," in s and rng.random() < strength:
        a, b = s.split(",", 1)
        b = b.strip().rstrip(".!?")
        if len(b.split()) > 3:
            s = f"{b[0].upper()}{b[1:]}, {a[0].lower()}{a[1:]}."
    return s


# --------------------------------------------------------------------------- synthetic handwriting
def writer_params(rng: random.Random) -> dict:
    return {
        "slant": rng.uniform(-15, 30), "stroke": rng.choice([2, 3, 4, 5, 6, 7]), "size": rng.uniform(26, 50),
        "spacing": rng.uniform(0.6, 1.8), "jitter": rng.uniform(1.5, 10), "loop": rng.uniform(0.15, 0.35),
        "tall": rng.uniform(0.05, 0.3), "line_gap": rng.uniform(2.2, 3.2),
    }


def draw_handwriting(path: Path, p: dict, seed: int, *, session_jitter: float = 0.06, degrade: str | None = None):
    """Render a page of pseudo-cursive for writer parameters p. Each sample also varies a little
    (session_jitter) to mimic natural within-writer variation."""
    rng = random.Random(seed)
    q = {k: (v * (1 + rng.gauss(0, session_jitter)) if isinstance(v, float) else v) for k, v in p.items()}
    q["slant"] = p["slant"] + rng.gauss(0, 2.0)
    W, H = 1400, 1000
    img = Image.new("L", (W, H), 245)
    d = ImageDraw.Draw(img)
    shear = math.tan(math.radians(q["slant"]))
    y0 = 40 + q["size"] * 1.6
    while y0 < H - q["size"]:
        x = 70 + rng.uniform(-8, 8)
        base = y0 + rng.uniform(-q["jitter"], q["jitter"])
        while x < W - 160:
            pts = []
            for _ in range(rng.randint(2, 7)):
                hgt = q["size"] * rng.uniform(0.7, 1.0) * (1.8 if rng.random() < q["tall"] else 1.0)
                wl = q["size"] * rng.uniform(0.45, 0.75)
                for t in range(9):
                    a = t / 8 * math.pi * 2
                    px = x + wl * (t / 8) + math.sin(a) * wl * q["loop"]
                    py = base - hgt * (0.5 - 0.5 * math.cos(a)) + rng.uniform(-q["jitter"], q["jitter"]) * 0.3
                    pts.append((px + (base - py) * shear, py))
                x += wl
            d.line(pts, fill=30, width=q["stroke"], joint="curve")
            x += q["size"] * q["spacing"] * rng.uniform(0.8, 1.2)
        y0 += q["size"] * q["line_gap"]
    img = degrade_image(img, degrade, rng)
    img.save(path)


def degrade_image(img: Image.Image, kind: str | None, rng: random.Random) -> Image.Image:
    if not kind:
        return img
    if kind == "blur":
        return img.filter(ImageFilter.GaussianBlur(1.6))
    if kind == "noise":
        a = np.asarray(img).astype(np.float32) + np.random.default_rng(rng.randint(0, 1 << 30)).normal(0, 22, (img.height, img.width))
        return Image.fromarray(np.clip(a, 0, 255).astype(np.uint8))
    if kind == "rotate":
        return img.rotate(2.5, fillcolor=245, resample=Image.BICUBIC)
    if kind == "lowres":
        return img.resize((img.width // 2, img.height // 2), Image.BILINEAR).resize(img.size, Image.BILINEAR)
    if kind == "jpeg":
        import io
        buf = io.BytesIO()
        img.save(buf, "JPEG", quality=25)
        return Image.open(io.BytesIO(buf.getvalue())).convert("L")
    raise ValueError(kind)


# --------------------------------------------------------------------------- synthetic signatures
def signature_base(rng: random.Random) -> dict:
    return {"ctrl": [(rng.uniform(0, 1), rng.uniform(-1, 1)) for _ in range(rng.randint(6, 11))], "f1": rng.uniform(10, 22), "f2": rng.uniform(6, 14),
            "amp": rng.uniform(15, 35), "flourish": rng.random() < 0.6}


def draw_signature(path: Path, base: dict, seed: int, variation: float, distort: float = 0.0, size=(600, 240)):
    rng = random.Random(seed)
    img = Image.new("L", size, 250)
    d = ImageDraw.Draw(img)
    ctrl = [(c[0] + rng.gauss(0, distort), c[1] + rng.gauss(0, distort)) for c in base["ctrl"]]
    n = 70
    sx = 1 + rng.gauss(0, 0.04 + distort)
    pts = []
    for i in range(n):
        t = i / (n - 1)
        k = t * (len(ctrl) - 1)
        j = min(int(k), len(ctrl) - 2)
        f = k - j
        cx = ctrl[j][0] * (1 - f) + ctrl[j + 1][0] * f
        cy = ctrl[j][1] * (1 - f) + ctrl[j + 1][1] * f
        x = 60 + t * (size[0] - 120) * sx + math.sin(t * base["f1"] + cx * 6) * base["amp"] + rng.gauss(0, variation)
        y = size[1] / 2 + cy * 60 + math.cos(t * base["f2"]) * 20 + rng.gauss(0, variation)
        pts.append((x, y))
    d.line(pts, fill=20, width=rng.choice([3, 4]), joint="curve")
    if base["flourish"]:
        d.line([(pts[5][0], pts[-1][1] + 30), (pts[-5][0], pts[-1][1] + 34)], fill=20, width=3)
    img.save(path)


# --------------------------------------------------------------------------- metrics
def roc_auc(pos: list[float], neg: list[float]) -> float:
    """Probability that a random positive scores higher than a random negative (ties = 0.5)."""
    pos, neg = np.asarray(pos), np.asarray(neg)
    gt = (pos[:, None] > neg[None, :]).mean()
    eq = (pos[:, None] == neg[None, :]).mean()
    return float(gt + 0.5 * eq)


def eer(pos: list[float], neg: list[float]) -> tuple[float, float]:
    """Equal error rate and its threshold (higher score = more similar)."""
    pos, neg = np.asarray(pos), np.asarray(neg)
    best = None
    for t in np.unique(np.concatenate([pos, neg])):
        far = float(np.mean(neg >= t))
        frr = float(np.mean(pos < t))
        if best is None or abs(far - frr) < best[0]:
            best = (abs(far - frr), (far + frr) / 2, float(t))
    return best[1], best[2]


# --------------------------------------------------------------------------- vision helpers
def hist_sim(p, q) -> float:
    """Chi-square histogram similarity in [0, 1] — identical to histSimilarity() in imaging.js."""
    p, q = np.asarray(p, float), np.asarray(q, float)
    s = p + q
    m = s > 0
    return float(1 - 0.5 * np.sum((p[m] - q[m]) ** 2 / s[m]))


def perspective_coeffs(dst, src):
    """PIL PERSPECTIVE coefficients mapping output (dst) points to input (src) points."""
    A, b = [], []
    for (x, y), (u, v) in zip(dst, src, strict=True):
        A += [[x, y, 1, 0, 0, 0, -u * x, -u * y], [0, 0, 0, x, y, 1, -v * x, -v * y]]
        b += [u, v]
    return np.linalg.solve(np.array(A, float), np.array(b, float)).tolist()


def photograph_page(page: Image.Image, rng: random.Random, size=(1500, 1900), strength: float = 1.0):
    """Place a page on a dark, textured desk with a random camera perspective and uneven light.
    Returns (photo, true_corners)."""
    W, H = size
    desk = Image.new("L", size, rng.randint(45, 95))
    d = ImageDraw.Draw(desk)
    for _ in range(350):
        x, y = rng.randrange(W), rng.randrange(H)
        d.ellipse((x, y, x + rng.randint(20, 90), y + rng.randint(4, 14)), fill=rng.randint(40, 100))
    def j(a):
        return rng.uniform(-a, a) * strength
    dst = [(150 + j(90), 130 + j(90)), (W - 150 + j(90), 130 + j(90)), (W - 120 + j(90), H - 120 + j(90)), (120 + j(90), H - 120 + j(90))]
    pw, ph = page.size
    coeffs = perspective_coeffs(dst, [(0, 0), (pw, 0), (pw, ph), (0, ph)])
    warped = page.transform(size, Image.PERSPECTIVE, coeffs, Image.BICUBIC, fillcolor=0)
    mask = Image.new("L", page.size, 255).transform(size, Image.PERSPECTIVE, coeffs, Image.BICUBIC, fillcolor=0)
    desk.paste(warped, (0, 0), mask)
    # uneven lighting: a soft gradient
    g = np.linspace(rng.uniform(0.85, 1.0), rng.uniform(0.9, 1.05), W)[None, :] * np.ones((H, 1))
    photo = Image.fromarray(np.clip(np.asarray(desk, float) * g, 0, 255).astype(np.uint8))
    return photo, dst


def paste_region(img: Image.Image, rng: random.Random, *, scale: float = 1.0, min_size=110, max_size=300, min_h=None, max_h=None):
    """Copy-move forgery: copy a random textured region and paste it elsewhere. Returns (image, src_box, dst_box)."""
    a = np.asarray(img)
    for _ in range(200):
        w, h = rng.randint(min_size, max_size), rng.randint(min_h or min_size // 2, max_h or max_size // 2)
        x, y = rng.randint(0, img.width - w - 1), rng.randint(0, img.height - h - 1)
        if a[y:y + h, x:x + w].std() > 25:
            break
    patch = img.crop((x, y, x + w, y + h))
    if scale != 1.0:
        patch = patch.resize((max(8, int(w * scale)), max(8, int(h * scale))), Image.BICUBIC)
    for _ in range(200):
        tx, ty = rng.randint(0, img.width - patch.width - 1), rng.randint(0, img.height - patch.height - 1)
        if abs(tx - x) > w or abs(ty - y) > h:
            break
    out = img.copy()
    out.paste(patch, (tx, ty))
    return out, (x, y, w, h), (tx, ty, patch.width, patch.height)


def iou(a, b) -> float:
    ax, ay, aw, ah = a
    bx, by, bw, bh = b
    ix = max(0, min(ax + aw, bx + bw) - max(ax, bx))
    iy = max(0, min(ay + ah, by + bh) - max(ay, by))
    inter = ix * iy
    return inter / (aw * ah + bw * bh - inter) if inter else 0.0


def render_text_page(text: str, path: Path | None = None, size=(1240, 1754)) -> Image.Image:
    import textwrap
    from PIL import ImageFont
    font = ImageFont.truetype("/usr/share/fonts/truetype/dejavu/DejaVuSerif.ttf", 26)
    img = Image.new("L", size, 250)
    d = ImageDraw.Draw(img)
    y = 110
    for para in text.split("\n\n"):
        for line in textwrap.wrap(para, 70):
            d.text((100, y), line, font=font, fill=25)
            y += 40
        y += 22
        if y > size[1] - 120:
            break
    if path:
        img.save(path)
    return img
