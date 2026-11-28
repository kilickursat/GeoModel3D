# Mixed-report browser trials

We opened two original government reports in the browser and compared the reviewed data with reference values transcribed from each PDF before testing. The question was whether the reader could recover the measured intervals and the completed borehole's location from different pages. Page numbers below count from the first PDF page. The transcriptions still need independent engineering review.

| Original report | Pages initially selected | Source pages needed | Browser result |
| --- | ---: | --- | --- |
| GSQ Eulo 2, Queensland | 26 of 53 | 7 and 13 | One borehole, all five printed interval boundaries and the labelled 135.5 m drilled length. The review displayed two incompatible positions. |
| K7, South Australia | 72 of 77 | 24 and 34 | The reader found the location schedule. Local OCR read 86 lines on the scanned schematic but recovered none of the four lithology intervals. Import stayed disabled. |

## GSQ Eulo 2

Roach, I. C. and colleagues (2017), *GSQ Eulo 2 borehole completion record*, Geoscience Australia and State of Queensland. The copyright page grants CC BY 4.0 with exclusions for the Commonwealth Coat of Arms and separately identified material. The reference contains transcribed field values and our descriptions. [Publication](https://doi.org/10.11636/Record.2017.008) · [Original PDF](https://www.ga.gov.au/corporate_data/104421/Rec2017_008.pdf) · [Licence](https://creativecommons.org/licenses/by/4.0/) · [Reference and PDF hash](eulo2.json)

1. Open the PDF in the document reader. The initial selection includes the survey on page 7 and the graphic log on page 13. **Select log and location pages** narrows this to six pages and keeps both. Another trial explicitly included pages 16, 47 and 48 with the survey and log to exercise the interpreted stratigraphy, planned position and neighbouring borehole.
2. Inspect the two alternatives on page 7. The GDA94 latitude and longitude project to 313954.02 m E, 6866977.74 m N in MGA zone 55. The same table prints 314026 m E, 6866950 m N, a 77.14 m discrepancy. The printed grid pair also falls within about a metre of the planned location on page 47. Determining the surveyed position requires additional evidence.
3. Keep the position unresolved and choose **Use drilled length** separately. The trial recovered 135.5 m from the labelled field on page 7. The reviewed project left the position and ground elevation blank. Page 7 reports an ellipsoidal height of 162 m. An AHD elevation would need a verified conversion or a separate survey.
4. Inspect page 13. The bases of the five intervals were 2, 23, 51, 72.6 and 135.5 m. The source viewer highlights the range and description separately. Exporting and reopening the workspace preserved all five ranges, the drilled length, the alternate positions, source boxes and review decisions. Selecting the geographic alternative in a separate test preserved its MGA conversion and EPSG:28355.

## K7

Schneider, I., Costar, A. and Keppel, M. (2016), *SARFIIP SMM Investigations: Groundwater Well Design and Construction on Pike Floodplain and Katarapko Floodplain 2015 (Phase 1 and 2A)*. © Crown in right of the State of South Australia, Department of Environment, Water and Natural Resources. The copyright page grants CC BY 4.0. [Original PDF](https://www.waterconnect.sa.gov.au/Content/Publications/DEW/DEWNR-TN-2016-15.pdf) · [Licence](https://creativecommons.org/licenses/by/4.0/) · [Reference and PDF hash](k7.json)

Select pages 24 and 34, then read the selections. Both pages identify K7 as 7029-2839. The schematic on page 34 gives GDA94 zone 54, a drilled depth of 11.2 m, and four graphically delineated beds. The printed scale gives approximate bases of 1.5, 2.5, 4 and 11.2 m. Recovering those contacts requires interpreting the lithology column against its depth scale and distinguishing it from the water and screen symbols. The reader stopped at review. A user choosing only suggested log and location pages would need to add the scanned schematic manually. The original contains 43 pages without usable native text.

Chromium observed zero external requests between the start of import and export in the Eulo deterministic trial, and between import and the blocked review for K7. The built-in sample loaded before those measurements. These trials evaluate document reading. Neither provides spatial coverage for a test of predictions between boreholes.

## Next validation milestones

1. Have a geotechnical reviewer independently mark page roles, collars, horizontal and vertical references, interval boundaries and ambiguous graphic contacts. Reserve reports from additional publishers before adjusting the reader. Keep the complete original PDFs for testing so the page search encounters appendices, historical wells and planned locations.
2. Evaluate Qwen on cropped source images for image-only pages like K7. Score its ability to locate the lithology column, calibrated depth ticks and contact marks. Check against the independent references and preserve the page coordinates of every proposal. Include water marks, screens and sample boundaries as negative examples.
3. Measure how many required pages are found, how many irrelevant pages need review, how often the reader abstains, and the errors in accepted positions, elevations and depths. Record WebGPU hardware, peak memory and warm/cold time separately from CPU fallback runs.
4. On a multi-hole site, hold out an interior borehole from correlation and compare predicted contact elevations and material by depth against its observations. Agree on engineering tolerances for that site's purpose and report extrapolation separately. The existing Tochigi trial illustrates the difference between matching observations at a collar and predicting geology elsewhere. [Tochigi validation](../public-report-review/README.md)
