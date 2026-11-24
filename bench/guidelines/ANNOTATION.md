# Annotation guidelines (schema 1.0.0)

These rules say how a report's ground truth is written, so that two people annotating the same report write the same
file. The schema is [`schema/annotation.schema.json`](../schema/annotation.schema.json); `scripts/validate.py` checks
every file against it and against the rules below that a program can check.

## What ground truth is

Ground truth is **what the report shows**, read by a person from the pages. It is never:

- **made up or estimated**: a value the report does not print is `null` or left out, and the reason goes in `note`;
- **corrected**: a value that looks wrong is kept as printed and explained in `note` (for example a final depth
  that differs from the last layer's base);
- **taken from the reader under test**: the reader's output is never a starting point for annotation;
- **taken from another source**: a database record of the same borehole is no help, because the benchmark measures
  reading the document.

Tools may help (a PDF's own text layer copied into the file, a page zoomed in). Every value is still checked against
the page image, and `provenance.method` says which tools were used.

## Privacy

Annotations hold engineering values only. **Never** transcribe:

- names of people (engineers, drillers, loggers, checkers), signatures, seals, registration numbers;
- telephone numbers, e-mail addresses, postal addresses of people;
- landowners or occupants of private property.

A borehole ID, a survey or project title and the public body that commissioned the work may be kept.

## Status

- `draft`: transcribed by one annotator, who may be a person or an assistant (`provenance.annotator_kind`).
- `verified`: a person other than the annotator has checked every value in scope against the pages and recorded the
  date in `provenance.verified_on`.

Only verified reports count towards a benchmark result that is called complete. Scores on draft annotations are
labelled draft wherever they are reported.

## Scope

- `scope.pages`: the pages whose type is annotated, normally `"all"`. A long compilation may be annotated over page
  ranges, which `scope.pages` lists; pages outside them are not scored for document understanding.
- `scope.boreholes`: `"all"`, or `"sample"` for long compilations, with `scope.sample_rule` saying how the sample was
  drawn (for example "every 10th log page from page 1, the borehole on that page"). Boreholes outside the sample are
  not scored.
- `scope.fields`: the fields annotated for every borehole in scope. A field listed here is complete: each of its
  values on the pages is transcribed. A field not listed is not scored.

## Documents and pages

- `documents` lists the report's files in manifest order; `doc` numbers count from 0 and pages from 1, as a PDF
  viewer shows them (not the page numbers printed on the sheets).
- Each page in scope gets one `type`:

| type | the page is… |
|---|---|
| `borehole_log` | a log of one or more holes: a depth scale or a From/To table with descriptions |
| `core_log` | a rock-core sheet: runs with recovery, RQD or fracture data, not the main log |
| `core_photo` | photographs of core boxes |
| `borehole_summary` | a table listing holes with positions, levels or depths |
| `site_plan` | a map or plan showing where the holes are |
| `cross_section` | a geological section or profile through holes |
| `lab_results` | laboratory test tables or plots |
| `insitu_test` | in-situ test records that are not a borehole log (CPT, sounding, permeability, pumping test, pressuremeter) |
| `legend` | a key to symbols and terms |
| `text` | prose: introduction, method, discussion, recommendations |
| `front_matter` | cover, title page, contents |
| `drawing_other` | another drawing |
| `table_other` | another table |
| `blank` | nothing printed, or only a page number |
| `other` | none of the above (say what in `note`) |

  Where a page carries two things (a log beside a location plan), it takes the type that carries borehole data, in the
  order of the table, and the other is named in `note`.
- `boreholes` on a page lists the IDs of the holes whose log, core sheet or summary entry is on it.
- `scan_quality` is given per page where it differs from the report's (manifest) value.

## Boreholes

- `id`: as printed on the log, with its own spacing and case (`BV-2`, `No.1`, `B-3(追加)`). Other names for the same
  hole go in `aliases`. The scorer compares IDs after folding width, case, spaces, hyphens and a leading `No.`.
- `pages`: every page of the hole's log and core sheets, in order.
- `depth_unit`: the unit of the log's depths, `m` or `ft`. All depths of the hole are in that unit.
- `depth_resolution`: only where boundaries or test depths are drawn on a scale and not printed as numbers: how
  closely they can be read (for example `1` for a scale labelled every 2 ft). Depths are then read to the nearest
  scale step, and the scorer accepts a reader's depth within this distance.
- `position`: as printed on the log or in a summary table of the same report (never from a plan by measuring):
  - `latlon` in decimal degrees, converted from degrees, minutes and seconds where so printed, with the datum in
    `crs` (`JGD2011`, `JGD2000`, `Tokyo`, `WGS84`, or `unstated`);
  - `projected` with `x` easting and `y` northing and the `crs` as an EPSG code where the report names the system;
  - `local` for site grid coordinates with no stated reference;
  - `station_offset` for chainage and offset along an alignment (`x` = station, `y` = offset).
  - `as_printed` keeps the text exactly as on the page.
  - `null` where the report gives none for that hole.
- `ground_elevation`: the elevation of the top of the hole (孔口標高, ground level, collar), with its `datum` as
  printed (`T.P.`, `KBM`, `mAOD`, `NAVD88`, or `unstated`). `null` if none is printed.
- `final_depth`: the depth at the bottom of the hole as printed in the header (総掘進長, final depth, total depth), or
  failing that the deepest depth printed on the log; `null` if neither is.
- `layers`: each described stratum, top to base, as the log draws it:
  - `top` and `base` are depths below the top of the hole in `depth_unit`. Where a log prints elevations only, depths
    are not computed: the layer is left out and the reason noted.
  - `description` is the log's description, abridged with … where it is longer than about 200 characters. The soil
    or rock name always stays.
  - `principal` is the material the description names first as the main constituent: `SANDY CLAY` is clay; `粘土混じり砂`
    is sand; `表土` is topsoil; `盛土` and fill are made_ground; `玉石混じり砂礫` is gravel; rock names (mudstone,
    granite, 泥岩, 凝灰岩) are rock; `火山灰` and loam (ローム) are volcanic_ash; core loss is no_recovery. A description
    that names no material is `other`.
- `spt`: each Standard Penetration Test: `depth` at the top of the test, and `n` the N value the log prints for it.
  Where the log prints no number (">50", or nothing), `n` is the blows counted. A test stopped short (refusal) has
  `refusal: true`, `blows` the blows counted and `penetration_cm` the distance driven; a test driven further than the
  standard distance under its own weight has `penetration_cm` and no refusal. A test printed on two sheets is
  transcribed once. Blows per 10 cm are not transcribed.
- `rqd`: each core run or interval with an RQD value, with total and solid core recovery (`tcr`, `scr`) where printed.
- `groundwater`: `status` `recorded` with each depth printed (`strike` where met while drilling, `standing` or
  `stabilised` after a wait, else `unspecified`); `not_encountered` where the log says none was met;
  `not_recorded` where the log is silent. Water levels in boreholes logged in water (over the sea, a river) are
  `unspecified` with a `note`.

## Readiness

`readiness.expected` is the right answer to "can a 3-D ground model be built from this report as it stands?":

- `spatial_model`: two or more holes with positions in one known reference system, and logs that can be read.
- `column_only`: a single hole: layers can be shown, but there is nothing to interpolate between.
- `abstain`: a model cannot be built without more information. `reasons` say why:
  `no_logs` (no borehole logs at all), `no_positions` (two or more holes, none positioned), `too_few_positions` (one
  positioned among many), `local_coordinates_only` / `unknown_crs` (positions that cannot be placed on a map, where a
  map placement is needed), `single_borehole` (only with `column_only`), `no_ground_elevation` (holes positioned but
  with no levels, so their layers cannot be set side by side; note it, as a model may still assume a flat ground).

A reader that abstains for the right reason is right. A reader that builds a model from positions it invented or
misread is wrong, and is counted separately as an **unsafe build**.

## Checking a file

```
python3 -I bench/scripts/validate.py
```

checks the schema, page and document numbers against the files, that layers are ordered and do not overlap, that
every `source` page belongs to the hole or a summary page, that IDs are unique, and that no field looks like personal
data.
