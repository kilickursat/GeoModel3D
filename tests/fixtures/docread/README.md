# Fixtures for reading borehole logs from documents

All are made from public records already in this repository. None comes from a real report.

| File | What it is |
|---|---|
| `bro-470162-strip.pdf` | BRO borehole BHR000000470162 (Maasvlakte 2), drawn as a strip log: depth scale, legend column, descriptions, base depths, water mark. |
| `kj-148301107.pdf` | KuniJiban borehole 148301107 (Sakae, Yokohama), drawn as a Japanese log (柱状図) with elevations, thicknesses, depths and N-values. |
| `bro-tables.pdf` | BRO boreholes BHR000000470162 and BHR000000470187, set out as tables on one page: From and To depths written vertically, beside a column of core runs. |
| `*.truth.json` | The values each document shows: ID, position, ground level, water level, final depth and layers. |
| `ocr/*.lines.json` | Lines of text with their boxes, read by OCR (PP-OCRv6 small, PaddlePaddle, Apache-2.0) from page images. |

**How they were made:**
- **Records:** from `src/data/rotterdam-site.json` and `src/data/sakae-site.json`. Each record was laid out as HTML and printed to PDF in Chromium. Samples with the same description were joined into one layer.
- **Page images:** the PDFs at 150 and 200 dpi. Images marked `scan` were made to look scanned: greyscale, a 0.4–0.9° tilt, blur, noise and JPEG compression.
- **OCR lines:** keep only the text and its box, in pixels of the page image.

**Data sources:**
- **BRO**, Basisregistratie Ondergrond: public domain (CC0 1.0).
- **国土地盤情報検索サイト「KuniJiban」の地盤情報** (KuniJiban; MLIT, PWRI, PARI): logs may be copied and redistributed with the source shown.
