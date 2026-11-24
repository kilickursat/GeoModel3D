#!/usr/bin/env python3
"""Score a reader's predictions against the benchmark's ground truth, at four levels scored independently:

  1. document understanding  which pages are borehole logs (and, for readers that type pages, which type)
  2. borehole assembly       which boreholes there are, with their IDs and pages (splits, merges)
  3. field extraction        position, ground level, final depth, groundwater, layers, SPT, RQD of matched boreholes
  4. ground-model readiness  whether a 3-D model can be built, or the reader should abstain, and unsafe builds

with failure categories, processing time, and the human correction effort (edits needed to turn the reader's
output into the ground truth).

    python3 -I bench/scripts/score.py RUN_DIR [--split dev|validation|test|all] [--out DIR]

RUN_DIR holds predictions/<report id>.json in the benchmark's prediction format (bench/runner/read.ts writes it).
Reports without an annotation are skipped and listed. Scores on draft annotations are marked draft.
"""
import argparse, collections, json, math, pathlib, re, sys, unicodedata

BENCH = pathlib.Path(__file__).resolve().parent.parent
FT = 0.3048
# Tolerances in the log's own unit: values are compared as printed.
TOL = {"m": {"value": 0.015, "boundary": 0.05, "spt": 0.05}, "ft": {"value": 0.05, "boundary": 0.2, "spt": 0.2}}
POS_TOL_M = 5.0
COARSE = {"made_ground": "made_ground", "topsoil": "made_ground", "clay": "fines", "silt": "fines", "clay_or_silt": "fines",
          "sand": "sand", "gravel": "gravel", "cobbles_boulders": "gravel", "peat_organic": "organic", "rock": "rock",
          "volcanic_ash": "volcanic_ash", "coal": "coal", "no_recovery": "no_recovery", "other": "other"}


def fold_id(s):
    s = unicodedata.normalize("NFKC", s or "").lower()
    s = re.sub(r"^(no|№)\.?\s*", "", s)
    s = re.sub(r"[(（].*$", "", s)  # a station or note after the ID: "No.2(測点No.67 R5.0)"
    return re.sub(r"[\s\-_‐－.]", "", s)


def same_id(a, b):
    fa, fb = fold_id(a), fold_id(b)
    return bool(fa) and fa == fb


def haversine(a, b, c, d):
    r = 6371008.8
    p1, p2, dl = math.radians(a), math.radians(c), math.radians(d - b)
    h = math.sin((p2 - p1) / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * r * math.asin(math.sqrt(h))


class Tally:
    """Counts of one field over many values: correct, wrong (both given, different), missed, spurious."""

    def __init__(self):
        self.c = collections.Counter()

    def add(self, outcome, n=1):
        self.c[outcome] += n

    def merge(self, o):
        self.c.update(o.c)

    def summary(self):
        c = self.c
        gt = c["correct"] + c["wrong"] + c["missed"]
        pred = c["correct"] + c["wrong"] + c["spurious"]
        return {"gt": gt, "predicted": pred, "correct": c["correct"], "wrong": c["wrong"], "missed": c["missed"],
                "spurious": c["spurious"], "recall": round(c["correct"] / gt, 4) if gt else None,
                "precision": round(c["correct"] / pred, 4) if pred else None}


def scalar(t, g, p, tol, failures, name):
    """One value: g the truth (None if the report gives none), p the prediction."""
    if g is None and p is None:
        return 0
    if g is None:
        t.add("spurious"); failures[f"{name}_spurious"] += 1
        return 1
    if p is None:
        t.add("missed"); failures[f"{name}_missed"] += 1
        return 1
    if abs(g - p) <= tol:
        t.add("correct")
        return 0
    t.add("wrong"); failures[f"{name}_wrong"] += 1
    return 1


def match_boreholes(gts, preds):
    """Pairs of (truth, prediction): the same ID read from the same document, or most of the same pages."""
    pairs, used = [], set()
    cand = []
    for i, g in enumerate(gts):
        gp = {(s["doc"], s["page"]) for s in g["pages"]}
        for j, p in enumerate(preds):
            pp = {(p["doc"], n) for n in p["pages"]}
            inter = len(gp & pp)
            if not inter and not (same_id(g["id"], p["id"]) and any(s["doc"] == p["doc"] for s in g["pages"])):
                continue
            jac = inter / len(gp | pp) if gp | pp else 0
            idm = same_id(g["id"], p["id"]) or any(same_id(a, p["id"]) for a in g.get("aliases", []))
            if idm or jac >= 0.5:
                cand.append((2 * idm + jac, i, j))
    taken_g = set()
    for _, i, j in sorted(cand, reverse=True):
        if i in taken_g or j in used:
            continue
        pairs.append((i, j)); taken_g.add(i); used.add(j)
    return pairs


def layer_scores(g, p, unit, failures):
    """Boundaries (tops and bases of the truth's layers) found within tolerance, and the share of the logged depth
    whose principal material (coarse group) the prediction gives right."""
    tol = max(TOL[unit]["boundary"], g.get("depth_resolution", 0))
    gb = sorted({round(l["top"], 3) for l in g["layers"]} | {round(l["base"], 3) for l in g["layers"]})
    pl = [l for l in p["layers"] if l["top"] is not None and l["base"] is not None]
    pb = sorted({round(l["top"], 3) for l in pl} | {round(l["base"], 3) for l in pl})
    used, hit = set(), 0
    for b in gb:
        k = next((k for k, x in enumerate(pb) if k not in used and abs(x - b) <= tol), None)
        if k is not None:
            used.add(k); hit += 1
    t = Tally()
    t.add("correct", hit)
    t.add("missed", len(gb) - hit)
    t.add("spurious", len(pb) - len(used))
    failures["boundary_missed"] += len(gb) - hit
    failures["boundary_spurious"] += len(pb) - len(used)
    # Depth-weighted lithology at 1 cm (or 0.05 ft) steps over the truth's logged depth.
    step = 0.01 if unit == "m" else 0.05
    total = right = 0
    relabel = 0
    for l in g["layers"]:
        gc = COARSE[l["principal"]]
        votes = collections.Counter()
        z = l["top"] + step / 2
        while z < l["base"]:
            q = next((x for x in pl if x["top"] <= z < x["base"]), None)
            pc = COARSE.get(q["principal"], "other") if q else None
            total += 1
            if pc == gc or (gc == "fines" and q and q["principal"] == "clay_or_silt"):
                right += 1
            votes[pc] += 1
            z += step
        if votes and votes.most_common(1)[0][0] != gc:
            relabel += 1
    failures["lithology_relabel"] += relabel
    return t, (right, total), relabel


def spt_scores(g, p, unit, failures):
    tol = max(TOL[unit]["spt"], g.get("depth_resolution", 0))
    t = Tally()
    used = set()
    for s in g["spt"]:
        k = next((k for k, q in enumerate(p["spt"]) if k not in used and abs(q["depth"] - s["depth"]) <= tol), None)
        if k is None:
            t.add("missed"); failures["spt_missed"] += 1
            continue
        used.add(k)
        q = p["spt"][k]
        ok = q.get("n") == s["n"] and bool(q.get("refusal")) == bool(s.get("refusal"))
        t.add("correct" if ok else "wrong")
        if not ok:
            failures["spt_wrong"] += 1
    t.add("spurious", len(p["spt"]) - len(used))
    failures["spt_spurious"] += len(p["spt"]) - len(used)
    return t


def rqd_scores(g, p, unit, failures):
    tol = max(TOL[unit]["boundary"], g.get("depth_resolution", 0))
    t = Tally()
    used = set()
    for r in g["rqd"]:
        k = next((k for k, q in enumerate(p["rqd"]) if k not in used and q["top"] is not None and q["base"] is not None
                  and abs(q["top"] - r["top"]) <= tol and abs(q["base"] - r["base"]) <= tol), None)
        if k is None:
            t.add("missed"); failures["rqd_missed"] += 1
            continue
        used.add(k)
        ok = abs(p["rqd"][k]["rqd"] - r["rqd"]) <= 1
        t.add("correct" if ok else "wrong")
        if not ok:
            failures["rqd_wrong"] += 1
    t.add("spurious", len(p["rqd"]) - len(used))
    return t


def gt_values(b, fields):
    """How many values a person would type for this borehole from scratch."""
    n = 1  # the ID
    n += 1 if "position" in fields and b["position"] else 0
    n += 1 if "ground_elevation" in fields and b["ground_elevation"] else 0
    n += 1 if "final_depth" in fields and b["final_depth"] else 0
    n += len(b["groundwater"]["readings"]) if "groundwater" in fields else 0
    n += 2 * len(b["layers"]) if "layers" in fields else 0  # a depth and a material per layer
    n += len(b["spt"]) if "spt" in fields else 0
    n += len(b["rqd"]) if "rqd" in fields else 0
    return n


def score_report(ann, pred):
    fields = set(ann["scope"]["fields"])
    failures = collections.Counter()
    res = {"report_id": ann["report_id"], "status": ann["status"], "complete_prediction": pred.get("complete", True)}
    if not pred.get("complete", True):
        failures["ocr_incomplete"] += 1

    # 1. Document understanding: log pages.
    if ann["scope"]["pages"] == "all":
        in_scope = {(p["doc"], p["page"]) for p in ann["pages"]}
    else:
        in_scope = {(r["doc"], n) for r in ann["scope"]["pages"] for n in range(r["from"], r["to"] + 1)}
    gt_log = {(p["doc"], p["page"]) for p in ann["pages"] if p["type"] in ("borehole_log", "core_log")} & in_scope
    pr_log, pr_read = set(), set()
    for d in pred["documents"]:
        read = set(d["log_pages"]) | set(d.get("core_pages", []))
        pr_read |= {(d["doc"], n) for n in read}
        pr_log |= {(d["doc"], n) for n in read | {u["page"] for u in d.get("unread_log_pages", [])}}
    pr_log &= in_scope
    tp = len(gt_log & pr_log)
    failures["log_page_missed"] += len(gt_log - pr_log)
    failures["log_page_false"] += len(pr_log - gt_log)
    failures["log_page_unread"] += len((gt_log & pr_log) - pr_read)
    res["document"] = {"pages_in_scope": len(in_scope), "log_pages": len(gt_log), "detected": len(pr_log), "true_positive": tp,
                       "recall": round(tp / len(gt_log), 4) if gt_log else None,
                       "precision": round(tp / len(pr_log), 4) if pr_log else None,
                       "read_rate": round(len(gt_log & pr_read) / len(gt_log), 4) if gt_log else None,
                       "page_types": None}  # the reader does not type pages

    # 2. Borehole assembly.
    gts = ann["boreholes"]
    preds = pred["boreholes"]
    if ann["scope"]["boreholes"] == "sample":
        sampled = {(s["doc"], s["page"]) for g in gts for s in g["pages"]}
        preds = [p for p in preds if any((p["doc"], n) in sampled for n in p["pages"])]
    else:
        preds = [p for p in preds if any((p["doc"], n) in in_scope for n in p["pages"])] if ann["scope"]["pages"] != "all" else preds
    pairs = match_boreholes(gts, preds)
    matched_g = {i for i, _ in pairs}
    matched_p = {j for _, j in pairs}
    splits = merges = 0
    for g in gts:
        gp = {(s["doc"], s["page"]) for s in g["pages"]}
        if sum(1 for p in preds if gp & {(p["doc"], n) for n in p["pages"]}) > 1:
            splits += 1
    for p in preds:
        pp = {(p["doc"], n) for n in p["pages"]}
        if sum(1 for g in gts if pp & {(s["doc"], s["page"]) for s in g["pages"]}) > 1:
            merges += 1
    ids_right = sum(1 for i, j in pairs if same_id(gts[i]["id"], preds[j]["id"]) or any(same_id(a, preds[j]["id"]) for a in gts[i].get("aliases", [])))
    pages_right = sum(1 for i, j in pairs if {(s["doc"], s["page"]) for s in gts[i]["pages"]} == {(preds[j]["doc"], n) for n in preds[j]["pages"]} | {(preds[j]["doc"], n) for n in preds[j].get("core_pages", [])})
    failures["borehole_missed"] += len(gts) - len(pairs)
    failures["borehole_spurious"] += len(preds) - len(pairs)
    failures["borehole_split"] += splits
    failures["borehole_merged"] += merges
    failures["id_wrong"] += len(pairs) - ids_right
    res["assembly"] = {"boreholes": len(gts), "predicted": len(preds), "matched": len(pairs),
                       "recall": round(len(pairs) / len(gts), 4) if gts else None,
                       "precision": round(len(pairs) / len(preds), 4) if preds else None,
                       "id_correct": ids_right, "pages_exact": pages_right, "splits": splits, "merges": merges}

    # 3. Field extraction on matched boreholes.
    T = collections.defaultdict(Tally)
    lith = [0, 0]
    edits = 0
    values = 0
    for i, j in pairs:
        g, p = gts[i], preds[j]
        unit = g["depth_unit"]
        tol = TOL[unit]["value"]
        values += gt_values(g, fields)
        edits += 0 if same_id(g["id"], p["id"]) or any(same_id(a, p["id"]) for a in g.get("aliases", [])) else 1
        if "position" in fields:
            gpos, ppos = g["position"], p["position"]
            gpos = gpos if gpos and gpos["kind"] in ("latlon", "projected") else None
            if gpos is None and ppos is None:
                pass
            elif gpos is None:
                T["position"].add("spurious"); failures["position_spurious"] += 1; edits += 1
            elif ppos is None:
                T["position"].add("missed"); failures["position_missed"] += 1; edits += 1
            else:
                if gpos["kind"] == "latlon" and "lat" in ppos:
                    ok = haversine(gpos["lat"], gpos["lon"], ppos["lat"], ppos["lon"]) <= POS_TOL_M
                elif gpos["kind"] == "projected" and "x" in ppos:
                    f = FT if gpos.get("unit") == "ft" else 1
                    ok = math.hypot((gpos["x"] - ppos["x"]) * f, (gpos["y"] - ppos["y"]) * f) <= POS_TOL_M
                else:
                    ok = False
                T["position"].add("correct" if ok else "wrong")
                if not ok:
                    failures["position_wrong"] += 1; edits += 1
        if "ground_elevation" in fields:
            edits += scalar(T["ground_elevation"], g["ground_elevation"]["value"] if g["ground_elevation"] else None,
                            p["ground_elevation"], tol, failures, "elevation")
        if "final_depth" in fields:
            edits += scalar(T["final_depth"], g["final_depth"]["value"] if g["final_depth"] else None, p["final_depth"], tol, failures, "final_depth")
        if "groundwater" in fields:
            rs = [r["depth"] for r in g["groundwater"]["readings"]]
            w = p["water_depth"]
            if not rs and w is None:
                pass
            elif not rs:
                T["groundwater"].add("spurious"); failures["water_spurious"] += 1; edits += 1
            elif w is None:
                T["groundwater"].add("missed"); failures["water_missed"] += 1; edits += 1
            elif any(abs(r - w) <= tol for r in rs):
                T["groundwater"].add("correct")
            else:
                T["groundwater"].add("wrong"); failures["water_wrong"] += 1; edits += 1
        if "layers" in fields:
            t, (r, n), relabel = layer_scores(g, p, unit, failures)
            T["layer_boundaries"].merge(t)
            lith[0] += r; lith[1] += n
            edits += t.c["missed"] + t.c["spurious"] + relabel
        if "spt" in fields:
            t = spt_scores(g, p, unit, failures)
            T["spt"].merge(t)
            edits += t.c["missed"] + t.c["wrong"] + t.c["spurious"]
        if "rqd" in fields:
            t = rqd_scores(g, p, unit, failures)
            T["rqd"].merge(t)
            edits += t.c["missed"] + t.c["wrong"] + t.c["spurious"]
    # Boreholes the reader missed are typed in full; spurious ones deleted.
    missed_values = sum(gt_values(gts[i], fields) for i in range(len(gts)) if i not in matched_g)
    edits += missed_values + (len(preds) - len(pairs))
    values += missed_values
    res["fields"] = {k: v.summary() for k, v in sorted(T.items())}
    res["fields"]["lithology_depth_weighted"] = {"right": lith[0], "total": lith[1], "accuracy": round(lith[0] / lith[1], 4) if lith[1] else None}

    # 4. Readiness.
    exp, got = ann["readiness"], pred["readiness"]
    right = exp["expected"] == got["decision"]
    placed_right = T["position"].c["correct"] if "position" in fields else 0
    unsafe = got["decision"] == "spatial_model" and (exp["expected"] != "spatial_model" or placed_right < 2)
    if not right:
        failures["readiness_wrong"] += 1
    if unsafe:
        failures["unsafe_build"] += 1
    res["readiness"] = {"expected": exp["expected"], "expected_reasons": exp["reasons"], "predicted": got["decision"],
                        "predicted_reasons": got.get("reasons", []), "correct": right, "unsafe_build": unsafe}

    res["effort"] = {"values_in_truth": values, "edits": edits,
                     "edits_per_borehole": round(edits / len(gts), 2) if gts else None,
                     "automation": round(1 - min(edits, values) / values, 4) if values else None}
    tm = pred.get("timing", {})
    pages = sum(d["pages"] for d in pred["documents"])
    res["time"] = {"pages": pages, "text_and_reconstruction_ms": tm.get("judge_ms", 0) + tm.get("read_ms", 0),
                   "ocr_ms": tm.get("ocr_ms", 0), "ocr_pages": tm.get("ocr_pages", 0), "ocr_backend": tm.get("ocr_backend", [])}
    res["failures"] = dict(sorted((k, v) for k, v in failures.items() if v))
    return res


def aggregate(rs):
    out = {"reports": len(rs), "draft": sum(r["status"] != "verified" for r in rs)}
    d = collections.Counter()
    for r in rs:
        for k in ("log_pages", "detected", "true_positive"):
            d[k] += r["document"][k]
        d["read"] += round((r["document"]["read_rate"] or 0) * r["document"]["log_pages"])
    out["document"] = {"log_pages": d["log_pages"], "recall": round(d["true_positive"] / d["log_pages"], 4) if d["log_pages"] else None,
                       "precision": round(d["true_positive"] / d["detected"], 4) if d["detected"] else None,
                       "read_rate": round(d["read"] / d["log_pages"], 4) if d["log_pages"] else None}
    a = collections.Counter()
    for r in rs:
        for k in ("boreholes", "predicted", "matched", "id_correct", "pages_exact", "splits", "merges"):
            a[k] += r["assembly"][k]
    out["assembly"] = dict(a, recall=round(a["matched"] / a["boreholes"], 4) if a["boreholes"] else None,
                           precision=round(a["matched"] / a["predicted"], 4) if a["predicted"] else None)
    F = collections.defaultdict(Tally)
    lith = [0, 0]
    for r in rs:
        for k, v in r["fields"].items():
            if k == "lithology_depth_weighted":
                lith[0] += v["right"]; lith[1] += v["total"]
                continue
            t = Tally()
            t.c.update({x: v[x] for x in ("correct", "wrong", "missed", "spurious")})
            F[k].merge(t)
    out["fields"] = {k: v.summary() for k, v in sorted(F.items())}
    out["fields"]["lithology_depth_weighted"] = {"accuracy": round(lith[0] / lith[1], 4) if lith[1] else None}
    out["readiness"] = {"correct": sum(r["readiness"]["correct"] for r in rs), "of": len(rs),
                        "unsafe_builds": sum(r["readiness"]["unsafe_build"] for r in rs),
                        "abstention_cases": sum(r["readiness"]["expected"] == "abstain" for r in rs),
                        "abstained_correctly": sum(r["readiness"]["expected"] == "abstain" and r["readiness"]["correct"] for r in rs)}
    e = collections.Counter()
    for r in rs:
        e["values"] += r["effort"]["values_in_truth"]
        e["edits"] += r["effort"]["edits"]
    out["effort"] = {"values_in_truth": e["values"], "edits": e["edits"],
                     "automation": round(1 - min(e["edits"], e["values"]) / e["values"], 4) if e["values"] else None}
    tm = collections.Counter()
    for r in rs:
        for k in ("pages", "text_and_reconstruction_ms", "ocr_ms", "ocr_pages"):
            tm[k] += r["time"][k]
    out["time"] = dict(tm)
    fl = collections.Counter()
    for r in rs:
        fl.update(r["failures"])
    out["failures"] = dict(fl.most_common())
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("run")
    ap.add_argument("--split", default="all")
    ap.add_argument("--out")
    a = ap.parse_args()
    run = pathlib.Path(a.run)
    manifest = {r["id"]: r for r in json.loads((BENCH / "manifest" / "sources.json").read_text())["reports"]}
    dev_families = {r["layout_family"] for r in manifest.values() if r["split"] == "dev"}
    results, skipped = [], []
    for rid, rep in manifest.items():
        if a.split != "all" and rep["split"] != a.split:
            continue
        ap_, pp = BENCH / "annotations" / f"{rid}.json", run / "predictions" / f"{rid}.json"
        if not ap_.exists() or not pp.exists():
            skipped.append((rid, "no annotation" if not ap_.exists() else "no prediction"))
            continue
        r = score_report(json.loads(ap_.read_text()), json.loads(pp.read_text()))
        r["split"], r["family"], r["country"] = rep["split"], rep["layout_family"], rep["country"]
        r["family_seen_in_dev"] = rep["layout_family"] in dev_families
        results.append(r)
    summary = {"run": run.name, "per_report": results, "skipped": skipped, "by_split": {}}
    for s in ("dev", "validation", "test"):
        rs = [r for r in results if r["split"] == s]
        if rs:
            summary["by_split"][s] = aggregate(rs)
    test = [r for r in results if r["split"] == "test"]
    if test:
        summary["test_by_family"] = {"seen_in_dev": aggregate([r for r in test if r["family_seen_in_dev"]]) if any(r["family_seen_in_dev"] for r in test) else None,
                                     "unseen_in_dev": aggregate([r for r in test if not r["family_seen_in_dev"]]) if any(not r["family_seen_in_dev"] for r in test) else None}
    summary["all"] = aggregate(results) if results else None
    out = pathlib.Path(a.out) if a.out else run
    out.mkdir(parents=True, exist_ok=True)
    (out / "scores.json").write_text(json.dumps(summary, ensure_ascii=False, indent=1) + "\n")
    for r in results:
        d, s, f, rd = r["document"], r["assembly"], r["fields"], r["readiness"]
        print(f"{r['report_id']:<32} {r['split']:<10} log pages {d['recall']}/{d['precision']}  boreholes {s['matched']}/{s['boreholes']} (pred {s['predicted']})  "
              f"readiness {rd['predicted']} vs {rd['expected']}{' UNSAFE' if rd['unsafe_build'] else ''}  automation {r['effort']['automation']}")
    for rid, why in skipped:
        print(f"{rid:<32} skipped: {why}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
