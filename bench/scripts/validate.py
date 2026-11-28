#!/usr/bin/env python3
"""Validate an explicitly supplied benchmark annotation and its source references."""
import argparse, collections, json, pathlib, re, sys, unicodedata

BENCH = pathlib.Path(__file__).resolve().parent.parent
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


def check_annotation(path, validator):
    w = path.stem
    a = json.loads(path.read_text())
    for e in validator.iter_errors(a):
        err(w, f"schema: {'/'.join(map(str, e.absolute_path))}: {e.message[:200]}")
    if errors and errors[-1].startswith(f"{w}: schema"):
        return a
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
    ap.add_argument("annotation", type=pathlib.Path)
    ap.add_argument("--strict", action="store_true")
    args = ap.parse_args()
    try:
        import jsonschema
    except ImportError:
        print("needs the jsonschema package (pip install jsonschema)")
        return 2
    schema = json.loads((BENCH / "schema" / "annotation.schema.json").read_text())
    validator = jsonschema.Draft202012Validator(schema)
    check_annotation(args.annotation, validator)
    for e in errors:
        print("ERROR  ", e)
    for x in warnings:
        print("warning", x)
    print(f"{len(errors)} errors, {len(warnings)} warnings")
    return 1 if errors or (args.strict and warnings) else 0


if __name__ == "__main__":
    sys.exit(main())
