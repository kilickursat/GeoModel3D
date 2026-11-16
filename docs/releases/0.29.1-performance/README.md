# 0.29.1 performance regression evidence

These are local software diagnostics from **2026-11-16**, using **Node v24.22.1 on Linux x64** in a shared execution environment. The baseline source commit is `37dfeb6927466a442cb221f6693e4dd5647cbf9a` (0.29.0). Source SHA-256 hashes and workload metadata are recorded in the result JSON files. The scripts substitute the relevant baseline source files; other dependencies come from the current checkout. They are not a comparison of two complete deployed applications.

The copied scripts and result files retain their original bytes. Scripts contain the original absolute `/workspace/GeoModel3D` and `/tmp` paths; adapt those paths for another checkout. Generated bundles and dependencies are deliberately not archived. Some artifact hashes in `group-performance.json` identify the temporary bundles used during measurement.

## Workspace cache lifetime

[storage-memory.json](storage-memory.json) records three independent Node processes per implementation. Each process keeps one workspace live, warms the serializer with three replacement workspaces, then serializes and discards 24 independent workspaces. Each has two revisions and a 200 × 200 terrain grid. The fixture yields to the event loop and explicitly invokes garbage collection before reading `process.memoryUsage().heapUsed`.

The additional retained JavaScript heap was **18,947,528–18,947,560 bytes before** and **90,584 bytes after**. This is measured JavaScript heap growth, not retained character count, total process memory, browser memory or GPU memory. The live workspace still serializes identically and round-trips. The committed isolated-process regression test uses a generous 8 MiB growth limit; exact bytes and garbage-collection schedules are not product guarantees.

[storage-wire.json](storage-wire.json) records byte-identical serialization of the same document across implementations, including all six pooled slots, page images, missing numeric readings, revisions and an inactive scenario. The synthetic file was 6,307 bytes. Its identifiers and timestamps are generated, so a rerun should establish equality within that run rather than reproduce the archived digest. A separate 30-revision Rotterdam sample produced 1,597,822-byte files for both implementations. Ten warm saves had local medians of 24.15 ms before and 24.73 ms after; these are diagnostic timing observations, not a speedup claim.

From the repository root, with dependencies installed, the recorded commands were equivalent to:

```sh
node docs/releases/0.29.1-performance/storage-measure.mjs
node docs/releases/0.29.1-performance/storage-wire.mjs
```

The first script creates before/after bundles under `/tmp` and invokes [the committed memory fixture](../../../tests/fixtures/workspace-memory.mjs) with `--expose-gc`; the second uses those bundles. Outputs go to the original `/tmp/geomodel3d-v0291-storage-*` paths. Child-process execution must be permitted. The ordinary test is `npx vitest run tests/workspace-memory.test.ts`.

## Dense location grouping

[group-performance.json](group-performance.json), [group-before.jsonl](group-before.jsonl) and [group-after.jsonl](group-after.jsonl) record **one ascending trial per size** in one fresh process per implementation, with the baseline process run first. Sizes were 100, 200, 400 and 800 logs, arranged in 40 columns at 1 m spacing, with two identical interpretations and a 100 m grouping radius. All logs form one group, leaving zero training groups. This deliberately exercises dense grouping; it is not a representative model prediction or hardware benchmark.

The observed 800-log call changed from 20,605 ms to 13 ms, with the same group and training counts. There are no repeated trials, confidence intervals or p95 statistics. Shared-host load, JIT warm-up and run order limit comparisons; do not generalize these timings into a universal speed claim. No AI inference was run.

The original build and run commands can be reconstructed as follows from the repository root:

```sh
cp docs/releases/0.29.1-performance/group-benchmark.ts /tmp/geomodel3d-v0291-group-benchmark.ts
git show 37dfeb6927466a442cb221f6693e4dd5647cbf9a:src/disagreementValidation.ts > /tmp/geomodel3d-v0291-group-base-disagreementValidation.ts
git show 37dfeb6927466a442cb221f6693e4dd5647cbf9a:src/calibration.ts > /tmp/geomodel3d-v0291-group-base-calibration.ts
node docs/releases/0.29.1-performance/group-build.mjs
node /tmp/geomodel3d-v0291-group-before.mjs > /tmp/geomodel3d-v0291-group-before.jsonl
node /tmp/geomodel3d-v0291-group-after.mjs > /tmp/geomodel3d-v0291-group-after.jsonl
```

[group-differential.mjs](group-differential.mjs) is a separate seeded semantic comparison: 1,000 randomized fixtures and 22,000 queries across six grouping radii. It compares sorted membership sets for old and new grouping implementations, including moved identities, rounded positions and unknown locations. It passed without a membership mismatch. The script imports temporary `group-review-output/group-review-before.mjs` and `group-review-after.mjs` modules; these are generated from the `const finite=` through `locationGroups` source block, ending immediately before `export function observedTop`, using esbuild to strip TypeScript. The archived script is unchanged and must be placed in `/tmp` beside those generated modules, or its relative imports adapted.
