# Data formats

What GeoModel3D reads, and how to prepare it. Files are read in the browser and are not uploaded anywhere.

Use **Import…** at the top right, or drop files on the page. Files are read in the browser and are not uploaded anywhere.

## Which format

| You have | Import |
|---|---|
| A spreadsheet of boreholes | CSV tables (below): one combined table, or separate collar, log, unit, test, SPT and water-level tables imported together. Start from the [templates](templates). |
| An AGS4 file (UK, Ireland, Hong Kong, Singapore, Australia, New Zealand…) | The `.ags` file. |
| Japanese electronic-delivery borehole logs (電子納品, KuniJiban) | All of a project's `.xml` logs at once. |
| Dutch BRO geotechnical boreholes (BHR-GT) | The IMBRO `.xml` from BROloket or the BRO web service, all at once. |
| Flemish DOV boreholes | The XML of each borehole (`dov.vlaanderen.be/data/boring/…`) together with the XML of its interpretations (`…/data/interpretatie/…`). |
| A project saved from GeoModel3D, or a Georeport3D extraction | The `.json` file. |
| Terrain | An ESRI ASCII grid (`.asc`) or gridded `x y z` points (`.xyz`), with the boreholes or on its own. |
| A tunnel, road or railway alignment | A LandXML or J-LandXML file, a CSV of its points, a GeoJSON line or a DXF polyline, with the boreholes or on its own ([Sections along a line](guide.md#sections-along-a-line)). |
| Cone penetration tests (CPT) | GEF files, BRO or DOV CPT XML, an AGS4 file with `SCPG` and `SCPT`, or a CSV table, with the boreholes or on their own ([CPT files](#cone-penetration-tests-cpt)). |
| Nothing in a file yet | The **Input data** tab ([Entering your own data](guide.md#entering-your-own-data)). |

## CSV tables

Each table is a CSV file with a header row. Headers are matched by name: case, spaces, punctuation and a unit in brackets do not matter, so `Depth From (m)` reads as `from`. Comma, semicolon and tab delimiters are detected, and decimal commas are accepted in semicolon files. Files are read as UTF-8 or Shift_JIS. The kind of table is recognised from its columns. Ready-to-fill examples are in [docs/templates](templates):

| Template | Table | Columns (accepted names) |
|---|---|---|
| [boreholes.csv](templates/boreholes.csv) | **Collars**, one row per borehole | **hole id** (`hole_id`, `Hole ID`, `BH`, `LOCA_ID`, `Name`); **x** (`x`, `Easting`, `E`) and **y** (`y`, `Northing`, `N`), *or* **latitude** and **longitude** (`lat`, `lon`); **ground level** (`z`, `Elevation`, `RL`, `Ground level`); optional **final depth** (`depth`, `Final depth`, `EOH`); optional **water depth** (`water_depth`, `Water level`, `GWL`) |
| [logs.csv](templates/logs.csv) | **Logs**, one row per interval | **hole id**; **from** and **to** (`from`/`to`, `Depth From`/`Depth To`, `Top`/`Base`), in metres below the collar; **unit** (`unit`, `Formation`, `Lithology`, `Stratum`, `GEOL_GEOL`) and/or **description** (`description`, `GEOL_DESC`) |
| [units.csv](templates/units.csv) | **Units**, top to bottom in stratigraphic order | **unit**; optional `name`, `colour` (`#rrggbb`), `erosive` (yes/no), unit weight `gamma` and saturated unit weight `gamma_sat` (kN/m³), design values `c` (kPa), `phi` (°), `su` (kPa), `E` (MPa), `k` (m/s), `K0` or any property of the catalogue below, and `source` |
| [water.csv](templates/water.csv) | **Water levels** | **hole id**; **water depth** below the collar (m); optional `date` |
| [spt.csv](templates/spt.csv) | **SPT tests** | **hole id**; **depth** (m); `N`, or `blows` and `penetration` (mm, 300 for a complete test) |
| [tests.csv](templates/tests.csv) | **Test results**, long form: one value per row | **hole id**; **depth** (m), optional **to** for a sample over a depth range; **property** (key, name or symbol of the catalogue below, or any other name); **value**; optional `unit` |
| [tests-wide.csv](templates/tests-wide.csv) | **Test results**, wide form: one sample per row | **hole id**; **depth**; one column per property, such as `w (%)`, `bulk density (Mg/m3)`, `LL`, `PL`, `su (kPa)` |
| [boreholes-combined.csv](templates/boreholes-combined.csv) | **One combined table** | The collar columns and the log columns on every row |
| [alignment.csv](templates/alignment.csv) | **An alignment**, one row per point of the line ([Sections along a line](guide.md#sections-along-a-line)) | **x** and **y**, *or* **latitude** and **longitude**; optional **chainage** (`chainage`, `ch`, `station`, metres or `12+345.6`; `km`, `KP` in kilometres) and design levels: `crown` and `invert`, `axis` and `diameter`, or one `level`; optional line name (`alignment`, `line`, `route`) |
| [profile.csv](templates/profile.csv) | **Design levels** of the line imported before, by chainage | **chainage**; `crown` and `invert`, `axis` and `diameter`, or one `level` |
| [cpt.csv](templates/cpt.csv) | **CPT readings**, one row per reading ([CPT files](#cone-penetration-tests-cpt)) | **CPT id** (`cpt_id`, `CPT`, `test`, `location`); **depth** (m below the start); **qc** (`qc`, `cone resistance`, MPa); one or more of **fs** (`fs`, `sleeve friction`, kPa), **u2** (`u2`, `pore pressure`, kPa) and **Rf** (`Rf`, `friction ratio`, %); the position, **x** and **y** or **latitude** and **longitude**, and the start level **z**, on the first row of each CPT, or in a collar table imported with it. A unit in brackets, such as `qc (kPa)`, `fs (MPa)` or `qc (tsf)`, is converted |

How these tables are read:
- **Lengths** are in metres, unless their header names another unit in brackets: `ft` or `feet` (the international foot), `US ft` (the US survey foot), `cm` or `mm`. These are converted to metres, to the millimetre, and the notes name the columns converted: `Depth From (ft)` reads 10 as 3.048 m. Any other unit there, such as `m`, `mbgl`, `mAOD` or `m NAP`, is read as metres. This applies to eastings and northings, ground level, final depth, from and to, water depths and test depths; SPT penetration stays in millimetres.
- **Coordinates:**
  - x and y are eastings and northings in metres in one projected coordinate system. Eastings and northings converted from feet need the metric version of their coordinate system, such as the State Plane zone in metres.
  - Latitude and longitude (WGS 84, or a national realisation within a metre or two of it: JGD2011, ETRS89, GDA2020, NAD83) are converted to the project's system, or to the one suggested for the site.
- **Units:** a unit not in the units table is added at the bottom of the column. Without a units table, the order is inferred from the logs (a unit directly above another in any hole is younger).
- **Descriptions without units:** intervals that carry only descriptions are grouped by principal soil or rock: Made ground, Peat, Clay, Silt, Sand, Gravel and rock types. These [unit rules](methods.md#how-a-model-is-built) can then be edited.
- **Converted values:**
  - a density column becomes a unit weight (× 9.81);
  - strengths and moduli given in the other of kPa and MPa (or GPa) are converted;
  - values outside a property's plausible range are reported.

**Property catalogue.** Test results and unit design values use these keys; the names and symbols are also understood.

| Key | Property | Unit | | Key | Property | Unit |
|---|---|---|---|---|---|---|
| `N` | SPT N-value | blows/300 mm | | `su` | Undrained shear strength | kPa |
| `w` | Water content | % | | `qu` | Unconfined compressive strength | kPa |
| `gamma` | Bulk unit weight | kN/m³ | | `ucs` | Uniaxial compressive strength (rock) | MPa |
| `gammaDry` | Dry unit weight | kN/m³ | | `c` | Effective cohesion c′ | kPa |
| `LL` | Liquid limit | % | | `phi` | Effective friction angle φ′ | ° |
| `PL` | Plastic limit | % | | `E` | Young's modulus | MPa |
| `PI` | Plasticity index | % | | `k` | Hydraulic conductivity | m/s |
| `fines` | Fines content (< 63 or 75 µm) | % | | `qc` | Cone resistance | MPa |
| `organic` | Organic content | % | | `Vs` | Shear-wave velocity | m/s |
| `RQD` | Rock quality designation | % | | `K0` | Earth pressure coefficient at rest (gives σ′h) | – |
| `fs` | Sleeve friction (CPT) | kPa | | `Rf` | Friction ratio (CPT) | % |
| `u2` | Pore pressure behind the cone (CPT) | kPa | | | | |

## AGS4

| Group | What is read |
|---|---|
| `LOCA` | `LOCA_NATE`/`LOCA_NATN`, or `LOCA_LAT`/`LOCA_LON`, with the local grid as a fallback; ground level `LOCA_GL`; final depth `LOCA_FDEP`. A recognised `LOCA_GREF` (such as `OSGB`, `ITM`, `HK1980`, `SVY21`, `NZTM` or `EPSG:27700`) sets the coordinate system. |
| `GEOL` | `GEOL_TOP`/`GEOL_BASE`, the unit from `GEOL_GEOL`, `GEOL_GEO2` or `GEOL_LEG` (named from `ABBR`), and the description `GEOL_DESC`, which gives the units when there are no codes |
| `ISPT` | SPT N-values (`ISPT_TOP`, `ISPT_NVAL`) |
| `WSTG`, `WSTD` | Water strikes, and the level they rose to (`WSTD_POST`) |
| `LNMC`, `LDEN`, `LLPL`, `GRAG` | Water content; bulk and dry density (as unit weights); liquid and plastic limits and plasticity index; fines |
| `TRIT`, `LVAN`, `LPEN`, `IVAN` | Undrained shear strength from triaxial, laboratory vane, hand penetrometer and in-situ vane tests |
| `TREG`, `SHBG` | Effective cohesion and friction angle from triaxial and shear box tests |
| `RUCS`, `PTST` | Rock uniaxial compressive strength and Young's modulus; permeability |
| `SCPG`, `SCPT` | CPTs: depth `SCPT_DPTH`, cone resistance `SCPT_RES`, sleeve friction `SCPT_FRES`, pore pressure `SCPT_PWP2` and friction ratio `SCPT_FRR`, in the units of the `UNIT` row, placed at their `LOCA` location. A location tested more than once gives one CPT per test (`SCPG_TESN`). A file with CPTs and no `GEOL` adds them to the site shown |

Laboratory results are placed at the specimen depth (`SPEC_DPTH`) or the top of the sample (`SAMP_TOP`).

Lengths whose `UNIT` row gives `ft`, `US ft`, `cm` or `mm` are converted to metres, as in CSV tables, and the notes say so.

## Japanese borehole XML

These are logs in the electronic-delivery format (地質・土質調査成果電子納品要領, versions 2 to 4), as delivered with Japanese public-works site investigations and served by [KuniJiban](https://www.kunijiban.pwri.go.jp). What is read:
- the position and geodetic datum (the Tokyo datum is shifted to JGD2011);
- the collar elevation;
- soil and rock descriptions;
- SPT tests;
- water levels.

Units come from the current project's unit rules or, for a new project, from a grouping of the soil names by principal material.

## Dutch BRO geotechnical boreholes (BHR-GT)

These are IMBRO XML files from the Key Register of the Subsurface ([BROloket](https://www.broloket.nl), or `publiek.broservices.nl/sr/bhrgt/v2/objects/<BRO-ID>`). What is read:
- the RD New position;
- the level in NAP, and whether it is the ground or a water bottom;
- the field description of the layers;
- the groundwater level;
- the laboratory determinations: water content, density (as unit weight), organic content, fines, Atterberg limits and undrained shear strength.

Soil names are written English first, principal soil leading, with the Dutch kept: `zwakSiltigZandMetGrind` becomes "Sand, slightly silty, with gravel (zwak siltig zand met grind)".

## Flemish DOV boreholes

DOV serves the XML of a borehole (`dov.vlaanderen.be/data/boring/<key>.xml`) and of its interpretations (`…/data/interpretatie/<key>.xml`). Import both together; they are joined by the borehole's identifier.

The most geological interpretation present is used for every borehole, the latest where there are several. In order of preference:
1. formal stratigraphy;
2. Quaternary or informal stratigraphy;
3. lithological description (Dutch or French);
4. geotechnical coding.

Formal stratigraphy is modelled by formation, named in English from DOV's code list, with the members kept in the descriptions. Positions are in Belgian Lambert 72, heights in metres TAW.

## Cone penetration tests (CPT)

| File | What is read |
|---|---|
| **GEF** (`.gef`, GEF-CPT-Report, the Dutch exchange format) | The columns by their GEF quantity number: penetration length (1), cone resistance (2), sleeve friction (3), friction ratio (4), pore pressure u2 (6), and the depth corrected for inclination (11), which is used where given. Missing values (`#COLUMNVOID`), column and record separators, and the units of the columns. The test's name (`#TESTID`), position (`#XYID`; code 31000 is RD New), start level (`#ZID`; 31000 is NAP), date and pre-drilled depth. GEF borehole logs (GEF-BORE) are not read. |
| **BRO CPT** (IMBRO XML from [BROloket](https://www.broloket.nl) or `publiek.broservices.nl/sr/cpt/v1/objects/<BRO-ID>`) | The readings, in the order of the parameters the file lists; RD New position, or the standardized ETRS89 position; start level and datum, and whether it is the ground or a water bed; date and pre-drilled depth. |
| **DOV CPT** (`dov.vlaanderen.be/data/sondering/<key>.xml`) | Penetration length and depth, qc, fs and the pore pressure `u` (DOV does not say where on the cone it is measured; it is shown as u2); Belgian Lambert 72 position and height in TAW; date. |
| **AGS4** | `SCPG` and `SCPT`, as in the [AGS4 table](#ags4). |
| **CSV** | A table of readings, as in the [cpt.csv template](templates/cpt.csv). |

Readings are stored as qc in MPa, fs and u2 in kPa and Rf in percent, converted from the file's units. The friction ratio is the file's own, else fs/qc. A CPT goes into the project's coordinate system: positions in RD New, Lambert 72 or by latitude and longitude are converted. CPTs more than 2 km (or the site's own size) from the boreholes belong to another site and are left out, with a note. A CPT read again replaces the one of the same name.

## Project JSON

**Export → Project (JSON)** writes everything the viewer knows, and it imports back unchanged:

```json
{
  "format": "geomodel3d-project",
  "version": 1,
  "name": "My site",
  "source": "Site investigation report 2024-17",
  "crs": "WGS 84 / UTM zone 54N",
  "crsCode": "EPSG:32654",
  "groundwaterDepth": 2.0,
  "units": [
    {"id": "MG", "name": "Made ground", "color": "#9a5b4f", "gamma": 19, "source": "Site investigation report, table 4"},
    {"id": "CG", "name": "Channel gravel", "color": "#d08a4c", "erosive": true},
    {"id": "MS", "name": "Mudstone", "color": "#6f7686", "gamma": 23, "gammaSat": 23.5, "params": {"c": 25, "phi": 32, "E": 400}}
  ],
  "boreholes": [
    {"id": "BH-01", "x": 456732.2, "y": 3987210.6, "z": 124.6, "depth": 35,
     "intervals": [{"from": 0, "to": 3.2, "unit": "MG", "name": "Made ground: sandy gravel"}, {"from": 3.2, "to": 30, "unit": "MS"}],
     "water": [{"depth": 2.4, "date": "2024-03-12"}],
     "spt": [{"depth": 5, "blows": 12, "penetration": 300}, {"depth": 8, "blows": 50, "penetration": 120}],
     "tests": [{"depth": 2.5, "to": 2.9, "property": "w", "value": 31.5}, {"depth": 6.0, "property": "ucs", "value": 4.2}]}
  ],
  "terrain": {"x0": 456725, "y0": 3987205, "dx": 5, "dy": 5, "ncols": 3, "nrows": 2,
              "z": [124.1, 124.3, 124.8, 123.9, null, 124.5]}
}
```

Fields of the project file:
- **Depths and values:** depths are in metres below the collar. Unit weights are in kN/m³. `params` holds unit design values by catalogue key.
- **Groundwater:** `groundwaterDepth` is an assumed water-table depth, used where no borehole has a water level.
- **Model base:** `base` (optional) is the elevation of a flat model base.
- **Model extent:** `margin` (optional, metres) extends the model beyond its outermost boreholes.
- **Terrain:** cells run west to east from the south-west cell centre (`x0`, `y0`); `null` marks a cell without data.
- **Coordinate system:** `crsCode` georeferences the project with a code from the registry. A system not in the registry can be given as a PROJ definition in `crsProj4`.
- **Projects built from descriptions** also keep `rules` (`match`, `unit`, and optionally `minN`, `maxN`, `minZ`, `maxZ`), and each interval's logged description as `name`.
- **Georeport3D extractions:** `collar` easting/northing/elevation, `total_depth`, and `intervals` (`depth_from`, `depth_to`, `lithology`). A borehole without a complete collar is reported and not placed; coordinates are never invented.
- **Alignments:** `alignments` lists the lines of the project, each with a `name` and its `points` (`x`, `y`, and a `chainage` at every point or at none). It may also have a `start` chainage and `design` levels: `chainage` and `top`, and `bottom` for a crown and invert.
- **CPTs:** `cpts` lists the cone penetration tests, each with an `id`, its position `x`, `y` and start level `z` (`null` to start at the model's ground), and its readings as lists of one length: `depth` (m below the start), `qc` (MPa) and, where measured, `fs` (kPa), `u2` (kPa), `rf` (%) and `qt` (MPa), with `null` for a missing reading. It may also have the cone's net area ratio `a`, a `date`, a `predrill` depth, and its `layers` (`from`, `to`, `unit`, and the soil as `name`). `cptLayers: true` builds the model with the CPT layers, and `cptRules` give them their units (else `rules` do).

**Export** also writes:
- **Boreholes (CSV)**, with descriptions and water depths;
- **Tests (CSV)**;
- **CPTs (CSV)**: every reading, with its elevation and the friction ratio;
- **Section (SVG and CSV)**;
- **Section colours (CSV)**: the stress or property shown, on a grid over the section;
- **Chainage table (CSV)** and **Alignment (CSV)**, along a line;
- **Report, A3 or A4 (PDF)**.
