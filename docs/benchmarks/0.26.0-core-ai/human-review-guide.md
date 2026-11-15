# Review the 40-image Qwen pilot

The prepared materials contain no completed human review. Source class labels originate in published geologist-derived logs; that does not mean a geologist has reviewed these selected crops or model answers. [Rubric](rubric.md) · [Protocol](protocol.json) · [Blank CSV](human-review-template.csv).

## 1. Prepare image-only references

Open the device benchmark page's source-image review panel before running a model or opening output reports. Use neutral case IDs and the exact 512 × 512 PNGs. The public manifest is `public/core-benchmark-v026/manifest.json`; the CSV provides repository-relative image paths and SHA256s. Review all 40 cases, including difficult, ambiguous and non-core images. Do not substitute easier photographs.

Download or copy the CSV. Its blank fields are intentional. For each case, fill `reference_reviewer_id`, actual role, qualification basis and review date; a consistent reviewer code is enough for a shared sheet if identifying details are retained privately. Do not invent credentials or imply external verification of self-reported qualifications. Record whether published labels or model outputs were seen.

Write specific observations in the colour, texture/markings and boundary/gap columns, with uncertainties. Use stable observation IDs within those cells, such as `case-11-C1`. Record visible material as `rock-like`, `non-rock`, `mixed` or `unclear`, without inferring lithology or engineering properties. Gray padding is not observed material; upscaling adds no detail. A non-core source class can contain a rock edge.

Leave all evaluation columns blank/unassessed. Keep borehole identity unverified unless an authoritative record links the exact source image to that hole; an apparent filename match alone is insufficient. Note any exclusions or category inapplicability before viewing answers.

## 2. Freeze the references

Save an immutable reference copy, record its UTC freeze time and compute its SHA256. Preserve the file itself. Avoid a circular hash: leave `reference_freeze_sha256` blank in the immutable reference copy, then record its digest in a separate record or the later grading copy. Sign off the reference copy before model text is disclosed to the reviewer.

For example, use `sha256sum references.csv` on Linux or `shasum -a 256 references.csv` on macOS. On a phone, transfer the completed file to the study organizer for hashing before any output disclosure. A manually typed hash is not proof of when a reference was frozen; retain the actual file, timestamp and disclosure record.

If inference already ran, its text can remain sealed from the image-only reviewer. Record that references preceded **output disclosure**, not inference. If the reviewer has already seen text, label those references output-informed and use a fresh reviewer for an independent reference. Do not edit a frozen reference in light of an answer; log later observations separately.

## 3. Generate and retain the browser records

The device page downloads the pinned model only after an explicit start. First use requires about 1,001 MiB of weights, plus tokenizer/runtime files and working memory. Use **quality mode (128 tokens)** for the quality study. **Compatibility mode (32 tokens)** checks bounded execution and is excluded from quality scores.

A full cohort is all 40 images. A selected case or first-five run remains partial. Keep the page visible; hiding it or stopping should preserve prior records and mark the interrupted/unstarted cases. Export the JSON after each attempt. Retain failed, cancelled, timed-out, empty and capped outcomes. Do not rerun an image to choose a better answer; infrastructure retries get a separate run ID and retain the original attempt.

For iPhone evidence, operate the page on the actual iPhone in Safari and record device model, iOS/Safari version, date and relevant conditions. Device labels are self-reported; the export's actual browser/adapter metadata is separate. A desktop browser with a phone-shaped viewport is not an iPhone result. Software WebGPU and CPU diagnostics are separate from hardware-phone measurements.

Cold downloads/session loading differ from warm generation. The protocol's 10-second warm first-token and 30-second warm total p95 targets are research screening thresholds, not promised performance or accepted user requirements. Record measured values and missing metrics honestly. JavaScript heap, when available, is not GPU memory; an unavailable memory API leaves that measurement unknown.

## 4. Grade without identity/timing cues

The organizer makes a scoring packet containing case image, frozen reference, fixed prompt, anonymous output ID and generated text. Hide model name, runtime/backend, device and timings; keep its ID-to-run mapping separately. Since this is one model, identity may be inferred. Call it identity-masked review and disclose its limitations, rather than claiming a double-blind panel.

Make a new grading copy of the CSV, carry the immutable reference digest into `reference_freeze_sha256`, and fill evaluation reviewer/date, anonymous output ID, category points, quoted atomic claim classifications, critical flags and reasons. Preserve the original model text in the run record. Review output against the frozen image observations, not the published lithology class.

Use the rubric's separate `minimum_useful` and `fully_supported` fields. A minimum-useful answer can still contain noncritical unverified claims. Blank/unassessed values remain missing evidence. Nonresponsive generated text can receive points for omitted categories but fails minimum usefulness; points are not accuracy percentages. Independently re-review critical/disputed cases and record how differences were resolved.

Freeze and sign the grading file before opening the output mapping. Retain original and adjudicated judgments separately if scores change. An assistant may help organize files, but must not be listed as a geologist or substitute its judgment for human review.

## 5. Report coverage before conclusions

Report expected 40, selected, attempted, completed, human-reviewed, minimum-useful and fully-supported counts separately. Keep backend/mode/device cohorts separate. Report all critical failures, visual contradictions, unverified claims, caps, execution failures and missing evidence. Never pool CPU or 32-token records into the 128-token browser-quality denominator.

The local software-GPU plan attempts only **case-11 in quality mode**, fixed before viewing, within a 30-minute ceiling. The other 39 browser cases remain unrun on that device. It is a runtime check, with any resulting text still unscored until qualified review. It cannot establish the 40-case or physical-iPhone gate.

Use passed/failed/unassessed for the protocol's criteria. Missing independent-hole mapping, expert references, full browser coverage or physical-device measurements cannot be treated as passing. Keep the app's model selector/default unchanged while these requirements remain unresolved.
