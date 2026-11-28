# Local document-reader benchmark

The runner measures page detection, borehole assembly, field extraction and readiness for a ground model. Supply an independently authored synthetic PDF and an answer key following the [annotation schema](schema/annotation.schema.json) and [annotation guidelines](guidelines/ANNOTATION.md). Use an explicitly supplied external document only for a temporary test. Supply the reference fields and expected abstentions before running the reader.

## Run one case

Run these commands from the repository root with the JavaScript dependencies installed. `npm run build` provides the local OCR worker and weights. The annotation check requires Python's `jsonschema` package. The script below runs in a subshell so its temporary OCR output and predictions are deleted on exit. Replace the two input paths and case ID with your own. The case ID must match `report_id` in the answer key. For a multi-document case, pass its PDFs in the same order to both `plan` and `read`.

```sh
npm run build
node_modules/.bin/esbuild bench/runner/read.ts --bundle --platform=node --format=esm --packages=external --outfile=.cache/bench-read.mjs
(
  set -eu
  run_dir=$(mktemp -d)
  trap 'rm -rf -- "$run_dir"' EXIT
  case_id=synthetic-log
  reference=/path/to/annotation.json
  pdf=/path/to/synthetic.pdf
  python3 -I bench/scripts/validate.py "$reference"
  node .cache/bench-read.mjs plan "$run_dir" "$case_id" "$pdf"
  node bench/runner/ocr.mjs "$run_dir"
  node .cache/bench-read.mjs read "$run_dir" "$case_id" "$pdf"
  python3 -I bench/scripts/score.py "$reference" "$run_dir/predictions/$case_id.json"
)
```

The runner reads the local PDF, routes pages through text extraction or the OCR worker, and reconstructs boreholes using the application's reader. Run the browser workflow separately to evaluate page selection, Qwen suggestions, human review or interactive 3D rendering. The scorer checks the input document names, page counts and SHA-256 hashes against the answer key. It prints aggregate field counts, error categories, readiness and correction effort. Draft annotations retain their draft status in the output.
