"""Check files that Git will publish, including files staged with git add -f."""
import os
from pathlib import Path
import subprocess
import sys


def retained_report(path):
    name = path.as_posix().lower()
    if name.startswith(("bench/annotations/", "bench/results/", "bench/reports/", "bench/runs/",
                        "bench/.cache/", ".cache/", "test-results/", "playwright-report/")):
        return True
    if path.suffix.lower() in {".pdf", ".doc", ".docx", ".djvu", ".tif", ".tiff", ".zip", ".7z", ".rar"}:
        return True
    if path.is_symlink():
        return False
    with path.open("rb") as stream:
        header = stream.read(1024)
    # PDF readers may accept a few leading bytes. ZIP covers renamed bundles and office files.
    return any(line.lstrip().startswith(b"%PDF-") for line in header.splitlines()) or header.startswith(
        (b"PK\x03\x04", b"PK\x05\x06", b"Rar!\x1a\x07", b"7z\xbc\xaf\x27\x1c"))


if __name__ == "__main__":
    tracked = subprocess.check_output(["git", "ls-files", "-z"])
    failed = False
    for raw in tracked.split(b"\0"):
        if not raw:
            continue
        path = Path(os.fsdecode(raw))
        if retained_report(path):
            print(f"Remove report or archive from the repository: {str(path)!r}", file=sys.stderr)
            failed = True
    sys.exit(1 if failed else 0)
