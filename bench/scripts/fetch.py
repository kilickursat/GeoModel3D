#!/usr/bin/env python3
"""Download the benchmark's reports from their publishers and check them against the manifest.

The reports are not kept in the repository: each is fetched from the URL its publisher gives, one request at a time,
and checked against the SHA-256 the manifest records. A file whose checksum differs is reported and not used: the
publisher has changed it, and its ground truth may no longer hold.

    python3 -I bench/scripts/fetch.py                 # all reports
    python3 -I bench/scripts/fetch.py --only ID ...   # some
    python3 -I bench/scripts/fetch.py --check         # check files already fetched, download nothing
    python3 -I bench/scripts/fetch.py --record        # write missing checksums and page counts into the manifest

Files go to bench/.cache/reports/<report id>/ (git-ignored). Archives are kept in bench/.cache/download/; only the
member the manifest names is taken out of an archive, under the file name the manifest gives. A source that refuses a
request (403, a login page) is reported, never worked around.
"""
import argparse, hashlib, io, json, pathlib, sys, time, urllib.request, zipfile

BENCH = pathlib.Path(__file__).resolve().parent.parent
MANIFEST = BENCH / "manifest" / "sources.json"
CACHE = BENCH / ".cache"
PAUSE = 2.0  # seconds between requests to the same publisher


def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def download(url: str) -> bytes:
    if not url.startswith("https://"):
        raise ValueError(f"only https sources are fetched: {url}")
    store = CACHE / "download" / sha256(url.encode())[:16]
    blob = store / "content"
    if blob.exists():
        return blob.read_bytes()
    req = urllib.request.Request(url)  # the library's own client name: nothing about who fetches
    with urllib.request.urlopen(req, timeout=600) as r:
        data = r.read()
        kind = r.headers.get("Content-Type", "")
    if "text/html" in kind and not url.endswith((".html", ".htm")):
        raise ValueError(f"the source answered with a web page, not a file (a login or refusal page?): {url}")
    store.mkdir(parents=True, exist_ok=True)
    blob.write_bytes(data)
    (store / "url").write_text(url + "\n")
    time.sleep(PAUSE)
    return data


def member(archive: bytes, name: str) -> bytes:
    with zipfile.ZipFile(io.BytesIO(archive)) as z:
        for info in z.infolist():
            raw = info.filename
            try:
                decoded = raw.encode("cp437").decode("cp932")  # Japanese archives without the UTF-8 flag
            except (UnicodeEncodeError, UnicodeDecodeError):
                decoded = raw
            if name in (raw, decoded):
                return z.read(info)
    raise KeyError(f"{name} is not in the archive")


def derive(data: bytes, how: str) -> bytes:
    """Wrap image pages in a PDF without resampling them (only for sources published as images)."""
    if how != "images-to-pdf":
        raise ValueError(f"unknown derivation {how}")
    import pymupdf  # only needed for image sources
    src = pymupdf.open(stream=data)
    return src.convert_to_pdf()


def text_sha256(data: bytes) -> str:
    """The text of a PDF without the request date in its page footers (DOV reports)."""
    import re
    import pymupdf
    text = "".join(pg.get_text() for pg in pymupdf.open(stream=data, filetype="pdf"))
    return sha256(re.sub(r"\n\d\d/\d\d/\d\d\np\.\d+\n", "\n", text).encode())


def pages(data: bytes) -> int | None:
    try:
        import pymupdf
    except ImportError:
        return None
    return pymupdf.open(stream=data, filetype="pdf").page_count


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--only", nargs="*")
    ap.add_argument("--check", action="store_true")
    ap.add_argument("--record", action="store_true")
    a = ap.parse_args()
    manifest = json.loads(MANIFEST.read_text())
    bad = 0
    for rep in manifest["reports"]:
        if a.only and rep["id"] not in a.only:
            continue
        out = CACHE / "reports" / rep["id"]
        for f in rep["files"]:
            target = out / f["name"]
            try:
                if a.check:
                    if not target.exists():
                        print(f"MISSING  {rep['id']}/{f['name']}")
                        bad += 1
                        continue
                    data = target.read_bytes()
                else:
                    data = download(f["url"])
                    if f.get("member"):
                        data = member(data, f["member"])
                    if f.get("derived"):
                        if f.get("source_sha256") and sha256(data) != f["source_sha256"]:
                            raise ValueError("the source file has changed since the manifest was written")
                        if a.record:
                            f["source_sha256"] = sha256(data)
                        data = derive(data, f["derived"])
                    out.mkdir(parents=True, exist_ok=True)
                    target.write_bytes(data)
                got = sha256(data)
                if f.get("volatile") and f.get("sha256") != got and f.get("text_sha256"):
                    # A document generated on request differs by its date stamp: its text without it must not.
                    if text_sha256(data) == f["text_sha256"]:
                        print(f"ok       {rep['id']}/{f['name']} (regenerated; same text)")
                        continue
                if f.get("sha256") and f["sha256"] != got and not f.get("derived"):
                    print(f"CHANGED  {rep['id']}/{f['name']}: sha256 {got} differs from the manifest")
                    bad += 1
                    continue
                if a.record:
                    f["sha256"], f["bytes"] = got, len(data)
                    n = pages(data)
                    if n:
                        f["pages"] = n
                print(f"ok       {rep['id']}/{f['name']}")
            except Exception as e:  # report and go on: one publisher's outage should not stop the rest
                print(f"FAILED   {rep['id']}/{f['name']}: {e}")
                bad += 1
    if a.record:
        MANIFEST.write_text(json.dumps(manifest, ensure_ascii=False, indent=1) + "\n")
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
