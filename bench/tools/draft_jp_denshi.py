#!/usr/bin/env python3
"""Turn assist_jp_denshi.py's column dump of one borehole into a draft borehole entry of the annotation format, for
the annotator to check against the page image and correct. Not ground truth until checked.

    python3 -I bench/tools/draft_jp_denshi.py FILE.pdf DOC [FIRST_PAGE LAST_PAGE]
"""
import collections, json, re, sys, pathlib
sys.path.insert(0, str(pathlib.Path(__file__).parent))
from assist_jp_denshi import draft  # noqa: E402

ROCK = ("岩", "チャート", "ホルンフェルス", "片麻", "蛇紋", "石灰", "珪", "凝灰")


def principal(name):
    n = re.sub(r"[（(].*?[)）]", "", name).strip()
    if not n:
        return "other"
    if re.search(r"表土", n):
        return "topsoil"
    if re.search(r"盛土|埋土|埋戻|舗装|アスファルト|コンクリート|砕石", n):
        return "made_ground"
    if re.search(r"腐植|泥炭|有機質土$|ピート", n):
        return "peat_organic"
    if re.search(r"ローム|火山灰|軽石|黒ボク", n):
        return "volcanic_ash"
    if any(r in n for r in ROCK) or re.search(r"岩$|岩盤", n):
        return "rock"
    # The principal soil is the last noun: 礫混じり粘性土 is clay, 粘土混じり砂 is sand, 砂礫 is gravel.
    for pat, p in ((r"(粘性土|粘土|粘土質土)$", "clay"), (r"シルト$", "silt"), (r"(砂質土|砂)$", "sand"),
                   (r"(礫質土|砂礫|礫|角礫)$", "gravel"), (r"(玉石|転石|巨礫)$", "cobbles_boulders")):
        if re.search(pat, n):
            return p
    return "other"


def checks(d, h):
    """Internal consistency of the copied values: elevation = ground - depth, thickness = base - top, and the N
    column agrees with blows and penetration. A failure means the sheet must be looked at."""
    out = []
    top = 0.0
    for s in d["sheets"]:
        for (y, base) in s["bases"]:
            e = [v for (yy, v) in s["elevations"] if abs(yy - y) < 2]
            t = [v for (yy, v) in s["thicknesses"] if abs(yy - y) < 2]
            if "ground" in h and (not e or abs(h["ground"] - base - e[0]) > 0.011):
                out.append(f"p{s['page']} base {base}: elevation {e} vs ground-depth {round(h['ground'] - base, 2)}")
            if not t or abs(base - top - t[0]) > 0.011:
                out.append(f"p{s['page']} base {base}: thickness {t} vs {round(base - top, 2)}")
            top = base
        if len(s["spt_depths"]) % 2:
            out.append(f"p{s['page']}: odd number of SPT depth labels {[v for _, v in s['spt_depths']]}")
        if len(s["blows"]) != len(s["spt_depths"]):
            out.append(f"p{s['page']}: {len(s['blows'])} blow/penetration values for {len(s['spt_depths'])} depth labels")
        s["_n"] = [v for (_, v) in s["n_column"]]
    if "final" in h and d["sheets"] and d["sheets"][-1]["bases"] and abs(d["sheets"][-1]["bases"][-1][1] - h["final"]) > 0.011:
        out.append(f"last base {d['sheets'][-1]['bases'][-1][1]} vs final depth {h['final']}")
    return out


def borehole(path, doc, first=None, last=None):
    d = draft(path, first, last)
    h = d["header"]
    problems = checks(d, h)
    layers, spt, water = [], [], []
    top = 0.0
    carry = None  # (name, note, top, source) of a layer whose base is on a later sheet
    for s in d["sheets"]:
        page = s["page"]
        src = {"doc": doc, "page": page}
        bases = s["bases"]
        # A base depth is printed just above its boundary line: the line is about 4 pt below the number's top.
        bands = [-1.0] + [y + 4 for (y, _) in bases]  # band k runs from bands[k] to bands[k+1]; the last one on
        # Soil names: a name ends at its code in brackets ("礫混じり粘性土(C-G)"); it belongs to the band it starts in.
        band = lambda yy: max(i for i, ty in enumerate(bands) if yy >= ty - 0.5)
        # A name without a code ends where the next word starts in a later band, if the name is a whole word by
        # then ("凝灰質粘土" then "粘土(CH)"); a name cut in mid-word runs on past a thin layer's boundary.
        names, cur, cur_y = [], "", None
        for (yy, t) in s["soil"]:
            if not cur and names and re.match(r"[(（]", t):  # a code run on past the boundary: it ends the name above
                names[-1] = (names[-1][0], names[-1][1] + t)
                continue
            if cur and band(yy) > band(cur_y) and re.search(r"(土|砂|礫|ト|岩|層|石|ム|ク|炭)$", cur):
                names.append((cur_y, cur)); cur = ""
            cur_y = yy if cur == "" else cur_y
            cur += t
            if re.search(r"[)）]$", t):
                names.append((cur_y, cur)); cur = ""
        if cur:
            names.append((cur_y, cur))
        nm = collections.defaultdict(str)
        for (yy, t) in names:
            nm[band(yy)] += t
        # Notes: a note starts in its layer's band; lines that run past a boundary belong to the note above until
        # its sentence ends.
        blocks = collections.defaultdict(list)
        for (yy, t) in s["note"]:
            blocks[band(yy)].append(t)
        # (Only on sheets whose notes end their sentences with 。: other sheets give no sign where a note ends.)
        periods = any(t.endswith("。") for (_, t) in s["note"])
        for k in range(1, len(bands)):
            while periods and blocks[k] and blocks[k - 1] and not blocks[k - 1][-1].endswith("。"):
                blocks[k - 1].append(blocks[k].pop(0))
        for k in range(len(bands)):
            name, note = nm.get(k, ""), "".join(blocks.get(k, []))
            if k == 0 and carry is not None:  # the layer running on from the sheet before
                # A continuation sheet repeats the name of the layer it continues: kept once.
                name, note, start, src0 = (carry[0] or name), carry[1] + note, carry[2], carry[3]
                carry = None
            else:
                start, src0 = top, src
            if k == len(bases):
                carry = (name, note, start, src0)
                break
            layers.append({"top": start, "base": bases[k][1], "description": name + ("：" + note if note else ""),
                           "principal": principal(name), "source": src0})
            top = bases[k][1]
        tests = s["spt_depths"]
        starts = tests[0::2]
        bl = s["blows"]
        pairs = [(bl[i][1], bl[i + 1][1]) for i in range(0, len(bl) - 1, 2)]
        for k, (y, depth) in enumerate(starts):
            if any(abs(q["depth"] - depth) < 0.005 for q in spt):
                continue  # a test across the sheet break, printed on both sheets
            t = {"depth": depth, "n": None, "source": src}
            if k < len(pairs):
                blows, pen = pairs[k]
                try:
                    t["n"], cm = float(blows), float(pen)
                    if cm != 30:
                        t["penetration_cm"] = cm
                    if cm < 30 and float(blows) >= 50:
                        t["refusal"] = True
                except ValueError:
                    t["n"] = None
            spt.append(t)
        for (y, v) in s["water"]:
            if re.fullmatch(r"-?\d+\.\d+", v):
                water.append({"depth": float(v), "kind": "unspecified", "source": src})
    # N as printed: where the N column has one value per test, a test that is not a refusal takes the printed N
    # (a test driven past 30 cm prints N scaled to 30 cm).
    ncol, seen = [], set()
    for sh in d["sheets"]:
        depths = [v for (_, v) in sh["spt_depths"]][0::2]
        for dep, v in zip(depths, sh["_n"]):
            if round(dep, 2) not in seen:
                seen.add(round(dep, 2)); ncol.append(v)
    # (">50" is no number: n stays the blows counted. A refusal is a test stopped short, from its penetration.)
    if len(ncol) == len(spt):
        for t, v in zip(spt, ncol):
            if re.fullmatch(r"\d+", v):
                t["n"] = float(v)
            elif v.startswith(">") and t.get("penetration_cm", 30) < 30:
                t["refusal"] = True
    for t in spt:
        if t.get("refusal"):
            t["blows"] = t["n"]
    first = first or 1
    pages = [{"doc": doc, "page": p} for p in range(first, (last or first + len(d["sheets"]) - 1) + 1)]
    p0 = {"doc": doc, "page": first}
    pos = None
    if "lat" in h and "lon" in h:
        pos = {"kind": "latlon", "lat": h["lat"]["value"], "lon": h["lon"]["value"], "crs": "unstated",
               "as_printed": f"北緯 {h['lat']['as_printed']} 東経 {h['lon']['as_printed']}", "source": p0}
    return {"id": h.get("id", ""), "pages": pages, "kind": "borehole", "depth_unit": "m", "position": pos,
            "ground_elevation": {"value": h["ground"], "datum": "unstated", "unit": "m", "source": p0} if "ground" in h else None,
            "final_depth": {"value": h["final"], "source": p0} if "final" in h else None,
            "layers": layers, "spt": spt, "rqd": [],
            "groundwater": {"status": "recorded" if water else "not_recorded", "readings": water},
            "_checks": problems, "_n_column": [v for s in d["sheets"] for v in s["_n"]]}


if __name__ == "__main__":
    a = sys.argv[1:]
    print(json.dumps(borehole(a[0], int(a[1]), *(int(x) for x in a[2:4])), ensure_ascii=False, indent=1))
