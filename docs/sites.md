# Sample sites and data sources

The sites that come with the app, how each was prepared, and the terms of their data.

## Reference datasets

- **Sakae, Yokohama, Japan (real site).** 75 borehole logs from MLIT road surveys around Sakae-ku, Yokohama, from KuniJiban: the Yokohama Circular South Route, Ken-O-Do and Yokohama-Shonan Road. They are in JGD2011 / Japan Plane Rectangular CS IX. The logs name no formations, so the units are an interpretation by unit rules of the logged names, SPT N-values and elevations:
  - **Fill:** fill, topsoil and pavement.
  - **Alluvium** (erosive): organic soils, clay and silt with N < 5, and sand and gravel with N < 20, below the 25 m valley floors.
  - **Kanto Loam:** volcanic ash soils.
  - **Pleistocene sediments:** the other soils.
  - **Kazusa Group:** from the first mudstone, cemented silt or layer with N ≥ 50 (the bearing stratum).

  Layers out of this order in a log (dense beds within softer ones, for instance) are modelled with the unit above and listed in the notes. Five rock-core logs are left out: they describe mudstone from the collar, where every neighbouring log shows 10–15 m of soft alluvium first. `scripts/make-sakae-site.ts` downloads the logs and builds the dataset.
- **Antwerp, Belgium (real site).** 170 DOV boreholes at least 15 m deep in a 3 × 3 km square over the old town and the Scheldt, each with DOV's formal lithostratigraphic interpretation. They are in Belgian Lambert 72, with heights in TAW. Three boreholes of 1987, GEO-87/185-B1, B2 and B3, are left out: DOV records their collar heights with an unknown method, 20 m above the surveyed collar of GEO-78/136-BLO6 nine metres away, and their logs put the top of the Boom Formation 20 m above the boreholes around them. [Cross-validation](guide.md#checking-the-model) and the check of the collars against the terrain both pointed to them. The units:
  - **Made ground and disturbed ground.**
  - **Quaternary deposits:** the thin Quaternary formations of the newer interpretations (Vlaanderen, Arenberg, Eeklo, Gent) and the undifferentiated Quaternary, as one erosive unit. Each interval keeps DOV's name.
  - **Kattendijk Formation** (Pliocene).
  - **Berchem Formation** (Miocene).
  - **Boom Formation** (Oligocene).

  Intervals interpreted as unknown are gaps in the logs, and the holes end at their deepest interpreted layer. `scripts/make-antwerp-site.ts` pins and downloads the borehole and interpretation XML.
- **Maasvlakte 2, Rotterdam, Netherlands (real site).** 100 BRO geotechnical boreholes of the Port of Rotterdam, 2017–2024, on land and in the harbour basins. They carry 3,188 laboratory results and 56 groundwater levels, in RD New with heights in NAP. Each described log is interpreted as a sequence:
  - **Sand:** reclamation fill and sea-bed sand, with the quay paving.
  - **Holocene clay and peat:** the basal complex, from the first clay, silt or peat more than 16 m below NAP, through thin sand partings.
  - **Pleistocene sand and gravel:** below it.

  In the basins the logs start at the bed, 17–21 m below NAP, so no terrain is fetched: the map lies on a plane at the collars' median level. The site also has 26 of the BRO's CPTs in the same rectangle, whose layers by soil behaviour type (from all their readings) are interpreted by the same sequence as the logs and build the model with them: of the 703 made since 2018, as the boreholes were, of quality class 1 or 2 and at least 30 m deep (into the Pleistocene sand), the deepest in each 400 m square. A reading is kept every 0.1 m (of every 0.02 m measured), qc to 0.01 MPa and fs and u2 to 1 kPa, with the friction ratio the BRO gives. `scripts/make-rotterdam-site.ts` pins and downloads the IMBRO XML.
- **Creswick deep leads, Victoria, Australia (real site).** 150 groundwater bores in about 10 × 10 km of the basalt plains north-east of Creswick, from the National Groundwater Information System (NGIS v1.1, 2013) of the Bureau of Meteorology. Lava flows filled valleys cut into Palaeozoic bedrock and buried the sand and gravel of the old rivers, the deep leads, once mined for gold. The units are the hydrostratigraphic interpretation of each log by the Victorian Department of Primary Industries, as published in NGIS, from the surface down:
  - **Surface alluvium.**
  - **Basalt, upper flows**, then **interbasalt clay** and **basalt, lower flows**.
  - **Sub-basaltic clay.**
  - **Deep lead:** buried river sand and gravel.
  - **Palaeozoic bedrock.**

  Every log runs in this order, with no gaps to fill. Coordinates are in GDA94 / MGA zone 54, with ground elevations in metres AHD from LiDAR, a terrain model or GPS. Only bore IDs, positions, elevations, depths and the interpretation are kept: the licence and source fields of NGIS are not read. `scripts/extract-ngis-deepleads.py` reads the bores from the NGIS geodatabase on data.gov.au, and `scripts/make-deepleads-site.ts` builds the dataset.
- **Synthetic valley, buried channel and layer-cake.** Generated by the scripts in `scripts/`; they exercise the modelling kernel and are not real sites. The channel generator also writes the true geometry the tests compare against, and a synthetic tunnel alignment that crosses the channel, with crown and invert levels.

## Data sources

- **Borehole logs** of the Sakae site and the Japanese test fixtures: 国土地盤情報検索サイト「KuniJiban」の地盤情報 (KuniJiban; MLIT, PWRI and PARI). Under the KuniJiban terms of use, individual logs carry no copyright and may be copied and redistributed, provided their source is shown.
- **Boreholes and interpretations** of the Antwerp site and the DOV test fixtures: Databank Ondergrond Vlaanderen (DOV), Flemish Government; consulted on 07/10/2026, on https://www.dov.vlaanderen.be. They may be reused free of charge, commercially or not, under the Flemish government's model licence for free reuse (Modellicentie Gratis Hergebruik), which asks for this attribution.
- **Geotechnical boreholes and cone penetration tests** of the Maasvlakte site and the BRO test fixtures: BRO, Basisregistratie Ondergrond (Dutch Key Register of the Subsurface); open data in the public domain (CC0 1.0).
- **Groundwater bores** of the Creswick site: National Groundwater Information System (NGIS) v1.1, © Commonwealth of Australia (Bureau of Meteorology), licensed under [CC BY 3.0 AU](https://creativecommons.org/licenses/by/3.0/au/), from [data.gov.au](https://data.gov.au/data/dataset/0ddc1f79-6ed3-4f4f-9195-52cf3eb59127); bore data © State of Victoria. Changes made: the bores of one area selected, multi-unit intervals split into their units, and the units named in English as above.
- **Coordinate systems:** derived from the EPSG Geodetic Parameter Dataset (© IOGP), retrieved through epsg.io.
- **Terrain and maps,** fetched in the browser and not stored here:
  - 地理院タイル (GSI tiles, Geospatial Information Authority of Japan);
  - Terrain Tiles (Mapzen, on AWS Open Data; [sources](https://github.com/tilezen/joerd/blob/master/docs/attribution.md));
  - map data © [OpenStreetMap](https://www.openstreetmap.org/copyright) contributors.

No copyright is claimed here on the data above, and the Apache-2.0 licence does not apply to them.
