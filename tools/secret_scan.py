"""Minimal secret scanner (no network, no dependencies).

Usage: python3 tools/secret_scan.py      → exit code 1 if anything suspicious is found.
Use a dedicated scanner such as gitleaks in CI as well; this is a fast local guard.
"""
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SKIP_DIRS = {"vendor", "node_modules", ".git", "fixtures", "data"}
SKIP_EXT = {".png", ".jpg", ".webp", ".pdf", ".docx", ".woff2", ".wasm", ".gz", ".ipynb"}
PATTERNS = {
    "AWS access key": re.compile(r"AKIA[0-9A-Z]{16}"),
    "private key": re.compile(r"-----BEGIN (RSA |EC |OPENSSH |)PRIVATE KEY-----"),
    "GitHub token": re.compile(r"gh[pousr]_[A-Za-z0-9]{36,}"),
    "Slack token": re.compile(r"xox[abpors]-[A-Za-z0-9-]{10,}"),
    "Google API key": re.compile(r"AIza[0-9A-Za-z\-_]{35}"),
    "generic secret assignment": re.compile(r"(?i)\b(api[_-]?key|secret|passwd|password|token)\b\s*[:=]\s*['\"][^'\"\s]{12,}['\"]"),
}


def main() -> int:
    hits = []
    for p in ROOT.rglob("*"):
        if p.is_dir() or any(part in SKIP_DIRS for part in p.parts) or p.suffix in SKIP_EXT:
            continue
        if p.name == ".env":
            hits.append((p, "a real .env file must never be committed"))
            continue
        try:
            text = p.read_text(encoding="utf-8")
        except (UnicodeDecodeError, OSError):
            continue
        for name, rx in PATTERNS.items():
            if rx.search(text):
                hits.append((p.relative_to(ROOT), name))
    for path, what in hits:
        print(f"possible secret: {what} in {path}")
    print(f"secret scan: {len(hits)} finding(s)")
    return 1 if hits else 0


if __name__ == "__main__":
    sys.exit(main())
