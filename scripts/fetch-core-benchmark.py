#!/usr/bin/env python3
"""Reproduce the eight frozen v0.25 core-photo pilot inputs with bounded ZIP ranges.

Only Python's standard library is required. Original JPEGs stay in .cache; the
dataset's CC BY-SA notices are separate from this script's Apache-2.0 licence.
"""
import argparse
import hashlib
import io
import json
from pathlib import Path
import sys
import urllib.error
import urllib.request
import zipfile

ROOT = Path(__file__).resolve().parents[1]
MANIFEST = ROOT / 'docs/benchmarks/0.25.0-core-ai/dataset-manifest.json'
DOWNLOAD_URL = ('https://www.kaggle.com/api/v1/datasets/download/'
                'breejeshdhar/automated-lithology-classification?datasetVersionNumber=1')
ARCHIVE_BYTES = 1201499645
ARCHIVE_FILES = 101995
SEED = '20261115'
CLASSES = ('garbage', 'limestone', 'sandstone', 'shale')
# These constants prevent a later mirror update from silently selecting new cases.
EXPECTED = (
    ('garbage/IHAD1_1_row_2_10.jpg_C2_.jpeg', 'e95a2ee0154bb7e157da4b49866dca9ff53b070428ddbc2caafd337b2028da29'),
    ('garbage/COD013_0_row_1_1.jpg_C2_.jpeg', '0efd5ee107d017cee7115cbd915ca436bd26ea59fc37cb5693d21bcbbc9e02af'),
    ('limestone/LB04D005_58_row_2_2_23.jpg.jpeg', '192b3fbca36f6769544db53027454293b85b0dad724c204c62d3bc0b0e652908'),
    ('limestone/08PD04c_30_row_4_1_8.jpg.jpeg', '75c298c6a67cb8eed8d74a421f90c91a502b1d9037391d8ba4d0b329f6e9507f'),
    ('sandstone/MURNAROO 1_62_row_5_2.jpeg', '6998746136b8a0dbd32b4de96bba6850a29b1727a4047fa58d74bd58f3489ad7'),
    ('sandstone/07PD01_28_row_3_6.jpeg', '62dacde15c78665b60a60db5bc1ad5b89a002eeee064051a1cbf939c426248e8'),
    ('shale/HODD1_54_row_0_16.jpeg', 'e8d474270d72def2b00ed1826a289803bfc7ef661ce415daf8ac5bac2eae1ec4'),
    ('shale/07PD01_38_row_4_2_22.jpg.jpeg', '733e7071fd4e1f2182c0fa2a3ae937034d6143476c6a4d3ce177997f01f27228'),
)


class RangeFile(io.RawIOBase):
    """Seekable public ZIP reader that refuses a server's full-file fallback."""
    def __init__(self):
        super().__init__()
        # GET is used because this public endpoint does not support HEAD. Close
        # immediately after headers; only subsequent exact ranges are consumed.
        with urllib.request.urlopen(DOWNLOAD_URL, timeout=30) as response:
            if response.status != 200 or 'zip' not in response.headers.get('Content-Type', ''):
                raise ValueError('Public download did not return a ZIP archive')
            self.url = response.url
            self.size = int(response.headers['Content-Length'])
        if self.size != ARCHIVE_BYTES:
            raise ValueError('Archive size changed; refusing to update the frozen pilot')
        self.position = 0
        self.transferred = 0
        self.requests = 0

    def seekable(self):
        return True

    def readable(self):
        return True

    def tell(self):
        return self.position

    def seek(self, offset, whence=0):
        if whence not in (0, 1, 2):
            raise ValueError('Invalid seek origin')
        self.position = offset + (self.position if whence == 1 else self.size if whence == 2 else 0)
        if not 0 <= self.position <= self.size:
            raise ValueError('Invalid ZIP seek')
        return self.position

    def read(self, size=-1):
        if size < 0:
            size = self.size - self.position
        size = min(size, self.size - self.position)
        if size == 0:
            return b''
        if size > 24 * 1024 * 1024 or self.transferred + size > 32 * 1024 * 1024:
            raise ValueError('ZIP ranges exceed the bounded metadata/download budget')
        start, end = self.position, self.position + size - 1
        request = urllib.request.Request(self.url, headers={'Range': f'bytes={start}-{end}'})
        with urllib.request.urlopen(request, timeout=45) as response:
            expected = f'bytes {start}-{end}/{self.size}'
            if response.status != 206 or response.headers.get('Content-Range') != expected:
                raise ValueError('Server ignored the exact byte range; refusing a full download')
            data = response.read(size + 1)
        if len(data) != size:
            raise ValueError('Truncated or oversized byte range')
        self.position += size
        self.transferred += size
        self.requests += 1
        return data


def verify(data, sample):
    if (not data.startswith(b'\xff\xd8') or len(data) != sample['bytes']
            or hashlib.sha256(data).hexdigest() != sample['sha256']):
        raise ValueError(f"{sample['id']}: JPEG bytes do not match the frozen source hash")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--cache-dir', type=Path, default=ROOT / '.cache/v025-core-benchmark')
    parser.add_argument('--verify-only', action='store_true', help='Verify all eight cached JPEGs without network access')
    args = parser.parse_args()
    manifest = json.loads(MANIFEST.read_text())
    samples = manifest['samples']
    expected_paths = ['Lithology Dataset/test/' + path for path, _ in EXPECTED]
    if (len(samples) != len(EXPECTED)
            or [(s['originalArchivePath'], s['sha256']) for s in samples]
            != list(zip(expected_paths, [sha for _, sha in EXPECTED]))):
        raise ValueError('Manifest differs from the frozen source paths/hashes')
    missing = []
    for i, sample in enumerate(samples, 1):
        if sample['id'] != f'sample-{i:02}' or sample['path'] != f'images/sample-{i:02}.jpeg':
            raise ValueError('Unexpected cache path or case identifier')
        path = args.cache_dir / sample['path']
        if path.exists():
            verify(path.read_bytes(), sample)
        else:
            missing.append(sample)
    if args.verify_only and missing:
        raise ValueError('Missing cached cases: ' + ', '.join(s['id'] for s in missing))
    transferred = requests = 0
    if missing:
        with RangeFile() as remote, zipfile.ZipFile(remote) as archive:
            entries = archive.infolist()
            if len(entries) != ARCHIVE_FILES:
                raise ValueError('Archive file count changed')
            selected = []
            for label in CLASSES:
                names = [e.filename for e in entries if not e.is_dir()
                         and e.filename.startswith(f'Lithology Dataset/test/{label}/')]
                if len(names) != 3000:
                    raise ValueError(f'Test inventory changed for {label}')
                selected.extend(sorted(names, key=lambda n: hashlib.sha256((SEED + '\0' + n).encode()).hexdigest())[:2])
            if selected != expected_paths:
                raise ValueError('Seeded selection changed; refusing to reshuffle cases')
            for sample in missing:
                entry = archive.getinfo(sample['originalArchivePath'])
                if (entry.file_size != sample['bytes'] or entry.compress_size > 2 * 1024 * 1024
                        or f'{entry.CRC:08x}' != sample['zipCrc32']):
                    raise ValueError(f"{sample['id']}: ZIP entry metadata changed")
                data = archive.read(entry)  # zipfile also verifies the entry CRC.
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
        sys.exit(f'Core benchmark download failed: {error}')
