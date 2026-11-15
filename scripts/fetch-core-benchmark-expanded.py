#!/usr/bin/env python3
"""Reproduce the 40 frozen v0.26 core-image source JPEGs with bounded public ZIP ranges.

Originals stay in .cache; image/manifest CC BY-SA terms are separate from Apache-2.0 code.
"""
import argparse
import collections
import hashlib
import importlib.util
import json
from pathlib import Path
import sys
import zipfile

sys.dont_write_bytecode = True

ROOT = Path(__file__).resolve().parents[1]
MANIFEST = ROOT / 'docs/benchmarks/0.26.0-core-ai/dataset-manifest.json'
MANIFEST_SHA256 = '301b53789551d3423730f56572762ab99cee8f59b1d1e7b3dfa30c6cf80141d2'
SEED = 'geomodel3d-core-v026-20261115'
CLASSES = ('garbage', 'limestone', 'sandstone', 'shale')
ARCHIVE_BYTES = 1201499645
ARCHIVE_FILES = 101995
DOWNLOAD_URL = ('https://www.kaggle.com/api/v1/datasets/download/'
                'breejeshdhar/automated-lithology-classification?datasetVersionNumber=1')


def digest(data):
    return hashlib.sha256(data).hexdigest()


def parent_token(name):
    # Sampling proxy only. This string is not an independently identified tray.
    return Path(name).name.split('_row_')[0]


def hole_token(name):
    # Sampling proxy only. This string is not a verified borehole identifier.
    return Path(name).name.split('_')[0]


def select(inventory, excluded):
    if set(inventory) != set(CLASSES) or any(len(inventory[c]) != 3000 for c in CLASSES):
        raise ValueError('The pinned archive must contain 3,000 test images per class')
    ordered = {c: sorted(inventory[c], key=lambda n: digest((SEED + '\0' + n).encode())) for c in CLASSES}
    parents = {parent_token(n) for n in excluded}
    counts = collections.Counter()
    result = []
    for _ in range(10):
        for label in CLASSES:
            for rank, name in enumerate(ordered[label], 1):
                if name in excluded or parent_token(name) in parents or counts[hole_token(name)] >= 3:
                    continue
                result.append((name, label, rank, len(result) + 1))
                parents.add(parent_token(name))
                counts[hole_token(name)] += 1
                break
            else:
                raise ValueError('Insufficient cases under the frozen grouping rule: ' + label)
    # Selection order stays round-robin, but public IDs group the four classes.
    return [row for label in CLASSES for row in result if row[1] == label]


def verify(data, sample):
    if (not data.startswith(b'\xff\xd8') or len(data) != sample['bytes']
            or digest(data) != sample['sha256']):
        raise ValueError(sample['id'] + ': JPEG bytes differ from the frozen source')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--cache-dir', type=Path, default=ROOT / '.cache/v026-core-benchmark')
    parser.add_argument('--verify-only', action='store_true', help='Verify cached JPEGs without network access')
    args = parser.parse_args()
    manifest_bytes = MANIFEST.read_bytes()
    if digest(manifest_bytes) != MANIFEST_SHA256:
        raise ValueError('Frozen source manifest changed; a new study needs a new versioned baseline')
    manifest = json.loads(manifest_bytes)
    samples = manifest['samples']
    if len(samples) != 40 or manifest['sampling']['seed'] != SEED:
        raise ValueError('Expected the frozen 40-case study')
    missing = []
    for i, sample in enumerate(samples, 1):
        case = f'case-{i:02}'
        if (sample['id'] != case or sample['path'] != f'images/{case}.jpeg'
                or sample['referenceClass'] != CLASSES[(i - 1) // 10]):
            raise ValueError('Unexpected case order or cache path')
        path = args.cache_dir / sample['path']
        if path.exists():
            verify(path.read_bytes(), sample)
        else:
            missing.append(sample)
    if args.verify_only and missing:
        raise ValueError('Missing cached cases: ' + ', '.join(s['id'] for s in missing))
    transferred = requests = 0
    if missing:
        # Reuse the earlier strict reader: exact 206 ranges, 24 MiB per-read and
        # 32 MiB total budget, and no whole-archive fallback or auth workaround.
        spec = importlib.util.spec_from_file_location('core_benchmark_range_reader', ROOT / 'scripts/fetch-core-benchmark.py')
        reader = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(reader)
        if (reader.DOWNLOAD_URL != DOWNLOAD_URL or reader.ARCHIVE_BYTES != ARCHIVE_BYTES
                or reader.ARCHIVE_FILES != ARCHIVE_FILES):
            raise ValueError('Shared range-reader source configuration changed')
        prior = json.loads((ROOT / 'docs/benchmarks/0.25.0-core-ai/dataset-manifest.json').read_text())
        excluded = {s['originalArchivePath'] for s in prior['samples']}
        if len(excluded) != 8:
            raise ValueError('Expected all eight prior pilot exclusions')
        with reader.RangeFile() as remote, zipfile.ZipFile(remote) as archive:
            entries = archive.infolist()
            if len(entries) != ARCHIVE_FILES:
                raise ValueError('Pinned archive inventory count changed')
            inventory = {c: [e.filename for e in entries if not e.is_dir()
                            and e.filename.startswith(f'Lithology Dataset/test/{c}/')] for c in CLASSES}
            selected = select(inventory, excluded)
            expected = [(s['originalArchivePath'], s['referenceClass'], s['selectionRankWithinClass'], s['selectionOrder']) for s in samples]
            if selected != expected:
                raise ValueError('Deterministic case selection changed; refusing replacements')
            for sample in missing:
                entry = archive.getinfo(sample['originalArchivePath'])
                if (entry.file_size != sample['bytes'] or entry.compress_size > 2_000_000
                        or f'{entry.CRC:08x}' != sample['zipCrc32']):
                    raise ValueError(sample['id'] + ': ZIP entry metadata changed')
                data = archive.read(entry)  # zipfile independently checks entry CRC.
                verify(data, sample)
                path = args.cache_dir / sample['path']
                path.parent.mkdir(parents=True, exist_ok=True)
                temporary = path.with_suffix('.jpeg.part')
                temporary.write_bytes(data)
                temporary.replace(path)
            transferred, requests = remote.transferred, remote.requests
    print(json.dumps({'verifiedSamples': len(samples), 'downloadedSamples': len(missing),
                      'rangePayloadBytes': transferred, 'rangeRequests': requests,
                      'cacheDirectory': str(args.cache_dir)}, indent=2))


if __name__ == '__main__':
    try:
        main()
    except (OSError, ValueError, KeyError, zipfile.BadZipFile) as error:
        sys.exit(f'Expanded core benchmark download failed: {error}')
