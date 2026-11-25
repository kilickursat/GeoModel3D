#!/usr/bin/env python3
"""Check the benchmark: the manifest, the splits and every annotation, and say whether the benchmark may be called
complete.

    python3 -I bench/scripts/validate.py            # errors make the exit status 1
    python3 -I bench/scripts/validate.py --strict   # warnings too

Errors are things that are wrong (a schema violation, a page that does not exist, a related document in two splits).
Warnings are things to look at (a field that may hold personal data, a final depth above the last layer's base).
The completeness check at the end never fails the run: it reports what is still missing before the benchmark can be
called complete (licences confirmed, every annotation verified by a person, coverage of each split).
"""
import argparse, collections, json, pathlib, re, sys, unicodedata

BENCH = pathlib.Path(__file__).resolve().parent.parent
SPLITS = ("dev", "validation", "test")
errors, warnings = [], []


def err(where, msg):
    errors.append(f"{where}: {msg}")


def warn(where, msg):
    warnings.append(f"{where}: {msg}")


def fold_id(s):
    """Borehole IDs compared as a reader would: width, case, spaces, hyphens and a leading No. folded."""
    s = unicodedata.normalize("NFKC", s).lower()
    s = re.sub(r"^(no|№)\.?\s*", "", s)
    return re.sub(r"[\s\-_‐－.]", "", s)


PERSONAL = [
    (re.compile(r"[\w.+-]+@[\w-]+\.[\w.]+"), "an e-mail address"),
    (re.compile(r"(?<!\d)0\d{1,4}[-‐－(]\d{1,4}[-‐－)]\d{3,4}(?!\d)"), "a telephone number"),
    (re.compile(r"(氏名|技術者|責任者|代理人|鑑定者|(logged|checked|drilled) by\s*:|driller\s*:|engineer\s*:)", re.I), "a person's role, perhaps with a name"),
]


def strings(x):
    if isinstance(x, str):
        yield x
    elif isinstance(x, dict):
        for v in x.values():
            yield from strings(v)
    elif isinstance(x, list):
        for v in x:
            yield from strings(v)


def check_manifest(m):
    ids, groups = set(), collections.defaultdict(set)
    for r in m["reports"]:
        w = r.get("id", "?")
        for k in ("id", "title", "publisher", "country", "languages", "landing_url", "licence", "files", "layout_family",
                  "layout", "scan_quality", "related_group", "split"):
            if k not in r:
                err(w, f"manifest entry lacks {k}")
        if not re.fullmatch(r"[a-z0-9]+(?:-[a-z0-9]+)*", w):
            err(w, "report id must be lower-case words joined by hyphens")
        if w in ids:
            err(w, "report id used twice")
        ids.add(w)
        if r.get("split") not in SPLITS:
            err(w, f"split must be one of {SPLITS}")
        groups[r.get("related_group")].add(r.get("split"))
        lic = r.get("licence", {})
        for k in ("id", "name", "url", "evidence", "checked_on", "attribution"):
            if not lic.get(k):
                err(w, f"licence lacks {k}")
        for f in r.get("files", []):
            if not f.get("url", "").startswith("https://"):
                err(w, f"{f.get('name')}: source URL must be https")
            if not re.fullmatch(r"[0-9a-f]{64}", f.get("sha256", "")):
                err(w, f"{f.get('name')}: no SHA-256 recorded (run fetch.py --record)")
            if not isinstance(f.get("pages"), int):
                err(w, f"{f.get('name')}: page count not recorded")
    for g, splits in groups.items():
        if len(splits) > 1:
            err(f"related group {g}", f"reports in more than one split: {sorted(splits)}")
    for x in m.get("excluded", []):
        if not x.get("source") or not x.get("reason"):
            err("excluded", f"entry without source or reason: {x}")
    return {r["id"]: r for r in m["reports"]}


def check_annotation(path, rep, validator):
    w = path.stem
    a = json.loads(path.read_text())
    for e in validator.iter_errors(a):
        err(w, f"schema: {'/'.join(map(str, e.absolute_path))}: {e.message[:200]}")
    if errors and errors[-1].startswith(f"{w}: schema"):
        return a
    if a["report_id"] != w:
        err(w, "report_id differs from the file name")
    if rep is None:
        err(w, "no manifest entry")
        return a
    files = rep["files"]
    if [d["file"] for d in a["documents"]] != [f["name"] for f in files]:
        err(w, "documents differ from the manifest's files (names or order)")
    for d, f in zip(a["documents"], files):
        if d["sha256"] != f.get("sha256"):
            err(w, f"{d['file']}: SHA-256 differs from the manifest: the annotation is of another version")
        if d["pages"] != f.get("pages"):
            err(w, f"{d['file']}: page count differs from the manifest")
    npages = {i: d["pages"] for i, d in enumerate(a["documents"])}

    def page_ok(where, doc, page):
        if doc not in npages or not 1 <= page <= npages[doc]:
            err(w, f"{where}: page {doc}/{page} does not exist")
            return False
        return True

    seen = set()
    for p in a["pages"]:
        key = (p["doc"], p["page"])
        if key in seen:
            err(w, f"page {key} typed twice")
        seen.add(key)
        page_ok("pages", *key)
    if a["scope"]["pages"] == "all":
        want = {(d, n) for d, c in npages.items() for n in range(1, c + 1)}
        if want - seen:
            err(w, f"scope is all pages but {len(want - seen)} are not typed, e.g. {sorted(want - seen)[:5]}")
    else:
        for rg in a["scope"]["pages"]:
            for n in range(rg["from"], rg["to"] + 1):
                if (rg["doc"], n) not in seen:
                    err(w, f"page {rg['doc']}/{n} is in scope but not typed")
    log_pages = {(p["doc"], p["page"]) for p in a["pages"] if p["type"] in ("borehole_log", "core_log")}
    data_pages = log_pages | {(p["doc"], p["page"]) for p in a["pages"] if p["type"] in ("borehole_summary", "site_plan", "cross_section", "table_other")}

    folded = collections.Counter(fold_id(b["id"]) for b in a["boreholes"])
    for k, c in folded.items():
        if c > 1:
            warn(w, f"{c} boreholes share the ID {k!r} after folding: the scorer tells them apart by pages")
    fields = set(a["scope"]["fields"])
    for b in a["boreholes"]:
        bw = f"borehole {b['id']}"
        own = set()
        for s in b["pages"]:
            if page_ok(bw, s["doc"], s["page"]):
                own.add((s["doc"], s["page"]))
                if (s["doc"], s["page"]) in seen and (s["doc"], s["page"]) not in log_pages:
                    err(w, f"{bw}: page {s['doc']}/{s['page']} is not typed as a log or core sheet")

        def src(where, s):
            if s and page_ok(f"{bw} {where}", s["doc"], s["page"]) and (s["doc"], s["page"]) not in own | data_pages:
                warn(w, f"{bw} {where}: read from page {s['doc']}/{s['page']}, which is neither its log nor a summary, plan or section")

        for k in ("position", "ground_elevation", "final_depth"):
            if b[k]:
                src(k, b[k]["source"])
        final = b["final_depth"]["value"] if b["final_depth"] else None
        last = None
        for i, l in enumerate(b["layers"]):
            src(f"layer {i + 1}", l["source"])
            if l["base"] <= l["top"]:
                err(w, f"{bw} layer {i + 1}: base {l['base']} is not below top {l['top']}")
            if last is not None and l["top"] < last - 1e-9:
                err(w, f"{bw} layer {i + 1}: top {l['top']} overlaps the layer above (base {last})")
            last = l["base"]
        if final is not None and last is not None and abs(last - final) > 0.011:
            warn(w, f"{bw}: last layer base {last} differs from the final depth {final}")
        prev = -1
        for t in b["spt"]:
            src("spt", t["source"])
            if t["depth"] <= prev:
                err(w, f"{bw}: SPT depths not increasing at {t['depth']}")
            prev = t["depth"]
            if final is not None and t["depth"] > final + 0.011:
                err(w, f"{bw}: SPT at {t['depth']} below the final depth {final}")
        for r in b["rqd"]:
            src("rqd", r["source"])
            if r["base"] <= r["top"]:
                err(w, f"{bw}: RQD interval {r['top']}–{r['base']} is empty")
        gw = b["groundwater"]
        if (gw["status"] == "recorded") != bool(gw["readings"]):
            err(w, f"{bw}: groundwater status {gw['status']} does not match its readings")
        for g in gw["readings"]:
            src("groundwater", g["source"])
        for k, field in (("layers", "layers"), ("spt", "spt"), ("rqd", "rqd")):
            if b[k] and field not in fields:
                warn(w, f"{bw}: {k} given but {field} is not in scope.fields: it will not be scored")

    rd = a["readiness"]
    holes = a["boreholes"]
    placed = [b for b in holes if b["position"] and b["position"]["kind"] in ("latlon", "projected")]
    exp = rd["expected"]
    if exp == "spatial_model" and len(placed) < 2:
        err(w, "readiness spatial_model needs two or more boreholes positioned on a map")
    if exp == "column_only" and len(holes) != 1 and a["scope"]["boreholes"] == "all":
        err(w, "readiness column_only is for a report with a single borehole")
    if exp == "abstain" and "no_logs" in rd["reasons"] and holes:
        err(w, "readiness abstains for no_logs, but boreholes are annotated")
    if exp == "abstain" and "no_positions" in rd["reasons"] and placed:
        err(w, "readiness abstains for no_positions, but boreholes have positions")

    for s in strings(a):
        for rx, what in PERSONAL:
            if rx.search(s):
                warn(w, f"text that may hold {what}: {s[:80]!r}")
    return a


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--strict", action="store_true")
    args = ap.parse_args()
    try:
        import jsonschema
    except ImportError:
        print("needs the jsonschema package (pip install jsonschema)")
        return 2
    m = json.loads((BENCH / "manifest" / "sources.json").read_text())
    reps = check_manifest(m)
    schema = json.loads((BENCH / "schema" / "annotation.schema.json").read_text())
    validator = jsonschema.Draft202012Validator(schema)
    anns = {}
    for p in sorted((BENCH / "annotations").glob("*.json")):
        anns[p.stem] = check_annotation(p, reps.get(p.stem), validator)

    for e in errors:
        print("ERROR  ", e)
    for x in warnings:
        print("warning", x)
    print(f"\n{len(reps)} reports in the manifest, {len(anns)} annotated; {len(errors)} errors, {len(warnings)} warnings\n")

    # Completeness: what must be true before the benchmark is called complete.
    missing = []
    for rid, r in reps.items():
        if not r["licence"].get("version_stated", True):
            missing.append(f"{rid}: licence version to be confirmed with the publisher")
        if rid not in anns:
            missing.append(f"{rid}: not annotated")
        elif anns[rid].get("status") != "verified":
            missing.append(f"{rid}: annotation is a draft, not verified by a person")
    by = collections.defaultdict(list)
    for rid, r in reps.items():
        by[r["split"]].append(r)
    print("split       reports  JP  other  abstain  families unseen in dev")
    dev_fam = {r["layout_family"] for r in by["dev"]}
    for s in SPLITS:
        rs = by[s]
        jp = sum(r["country"] == "JP" for r in rs)
        ab = sum(1 for r in rs if r["id"] in anns and anns[r["id"]].get("readiness", {}).get("expected") == "abstain")
        unseen = len({r["layout_family"] for r in rs} - dev_fam) if s != "dev" else "-"
        print(f"{s:<11} {len(rs):>7} {jp:>3} {len(rs) - jp:>6} {ab:>8}  {unseen}")
        if not rs:
            missing.append(f"split {s} is empty")
        elif s != "dev" and ab == 0:
            missing.append(f"split {s} has no annotated abstention case")
    print()
    if missing:
        print(f"COMPLETE: no ({len(missing)} items open)")
        for x in missing:
            print("  -", x)
    else:
        print("COMPLETE: yes")
    return 1 if errors or (args.strict and warnings) else 0


if __name__ == "__main__":
    sys.exit(main())
