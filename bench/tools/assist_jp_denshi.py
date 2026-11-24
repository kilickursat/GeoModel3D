#!/usr/bin/env python3
"""Annotation aid for one layout family: Japanese electronic borehole logs drawn by the delivery software that prints
"<file>.pdf (0 - 6 m)" at the top of each sheet (family jp-denshi-chujozu: the Tochigi and Ehime logs).

It copies the values a sheet's text layer holds into a draft in the annotation format, column by column of the
standard JACIC form. It is an aid for the annotator, not ground truth: every value it writes is checked against the
page image before the annotation is saved, and the annotation's provenance says so. It never reads the output of the
reader under test.

    python3 -I bench/tools/assist_jp_denshi.py FILE.pdf [FIRST_PAGE LAST_PAGE]   # prints a draft borehole as JSON
"""
import json, re, sys
import pymupdf

# Column bounds in PDF points on the A4 form, from the header labels of the form (checked on each page).
COL = {"elev": (53, 66), "thick": (66, 77), "depth": (77, 89), "soil": (110, 134), "note": (172, 246),
       "water": (246, 271), "sptd": (271, 283), "blows": (314, 328)}
NUM = re.compile(r"^-?\d+(?:\.\d+)?$")


def dms(words):
    """'36°' '20’' '27.6574”' → decimal degrees."""
    parts = [float(re.sub(r"[^\d.]", "", w)) for w in words]
    while len(parts) < 3:
        parts.append(0.0)
    return round(parts[0] + parts[1] / 60 + parts[2] / 3600, 7)


def row(words, y, x0, x1, tol=2.0):
    return [w for w in words if abs(w[1] - y) < tol and x0 <= w[0] < x1]


def page_items(pg):
    # Text drawn twice at the same place (overprinted) is taken once.
    seen, ws = set(), []
    for w in pg.get_text("words"):
        key = (round(w[0], 1), round(w[1], 1), w[4])
        if key not in seen:
            seen.add(key); ws.append((w[0], w[1], w[2], w[3], w[4]))
    head = next((w for w in ws if re.match(r".*\.pdf$", w[4])), None)
    rng = re.search(r"\((\d+(?:\.\d+)?)\s*-\s*(\d+(?:\.\d+)?)\s*m\)", pg.get_text())
    return ws, head, (float(rng.group(1)), float(rng.group(2))) if rng else None


def header(ws):
    h = {}
    label = lambda chars, y=None: [w for w in ws if w[4] == chars[0] and (y is None or abs(w[1] - y) < 2)]
    for w in ws:
        if w[4] == "ボーリング名":
            h["id"] = " ".join(v[4] for v in sorted(row(ws, w[1], 88, 195), key=lambda v: v[0]))
            h["id_box"] = w[1]
    for key, a, b in (("lat", "北", "緯"), ("lon", "東", "経")):
        for w in ws:
            if w[4] == a and 455 < w[0] < 470 and any(v[4] == b and abs(v[1] - w[1]) < 2 for v in ws):
                vals = sorted(row(ws, w[1], 490, 560, 2.5), key=lambda v: v[0])
                if vals:
                    h[key] = {"value": dms([v[4] for v in vals]), "as_printed": " ".join(v[4] for v in vals)}
    for key, first in (("ground", "孔"), ("final", "総")):
        for w in ws:
            if w[4] == first and 44 < w[0] < 50:
                vals = [v for v in row(ws, w[1], 88, 120) if NUM.match(v[4])]
                if vals:
                    h[key] = float(vals[0][4])
    for w in ws:
        if w[4] in ("調査期間",):
            h["period"] = " ".join(v[4] for v in sorted(row(ws, w[1], 312, 400), key=lambda v: v[0]))
    return h


def body(ws, top_y):
    """Layer bases with their y, soil names, notes, water levels, SPT tests on one sheet."""
    col = lambda name: sorted([w for w in ws if COL[name][0] <= w[0] < COL[name][1] and w[1] > top_y], key=lambda w: (w[1], w[0]))
    bases = [(w[1], float(w[4])) for w in col("depth") if NUM.match(w[4])]
    thick = [(w[1], float(w[4])) for w in col("thick") if NUM.match(w[4])]
    elevs = [(w[1], float(w[4])) for w in col("elev") if NUM.match(w[4])]
    soil = [(w[1], w[4]) for w in col("soil")]
    note = [(w[1], w[4]) for w in col("note")]
    water = [(w[1], w[4]) for w in col("water")]
    sptd = [(w[1], float(w[4])) for w in col("sptd") if NUM.match(w[4])]
    blows = [(w[1], w[4]) for w in col("blows")]
    return bases, elevs, thick, soil, note, water, sptd, blows


def scale(ws, top_y):
    """y of depth labels down the left edge (標尺), for placing names between boundaries."""
    labels = [(w[1], float(w[4])) for w in ws if w[0] < 50 and w[1] > top_y and NUM.match(w[4])]
    return labels


def draft(path, first=None, last=None):
    d = pymupdf.open(path)
    first = first or 1
    last = last or d.page_count
    out = {"header": {}, "sheets": []}
    for n in range(first, last + 1):
        ws, head, rng = page_items(d[n - 1])
        units = [w for w in ws if w[4] == "(m)" and w[0] < 60]
        # The body starts below the units row of the column heads; a continuation sheet has no heads, and its body
        # starts below the file line at the top.
        top_y = (units[0][1] + 5) if units else (head[1] + 5 if head else 300)
        if n == first:
            out["header"] = header(ws)
        bases, elevs, thick, soil, note, water, sptd, blows = body(ws, top_y)
        nvals = sorted([(w[1], w[4]) for w in ws if 326 <= w[0] < 342 and w[1] > top_y], key=lambda v: v[0])
        out["sheets"].append({"page": n, "range": rng, "scale": scale(ws, top_y), "bases": bases, "elevations": elevs, "thicknesses": thick, "n_column": nvals,
                              "soil": soil, "note": note, "water": water, "spt_depths": sptd, "blows": blows})
    return out


if __name__ == "__main__":
    a = sys.argv[1:]
    print(json.dumps(draft(a[0], *(int(x) for x in a[1:3])), ensure_ascii=False, indent=1))
