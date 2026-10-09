# Extracts the boreholes of the deep-leads site (central Victoria, Australia) from the National Groundwater Information
# System (NGIS) v1.1 of the Bureau of Meteorology, published on data.gov.au under CC BY 3.0 AU:
#   https://data.gov.au/data/dataset/0ddc1f79-6ed3-4f4f-9195-52cf3eb59127 (an ESRI file geodatabase in a zip)
# The archive served there ends partway through its last table, which is not one of those read here; the complete
# entries are unpacked by `--unpack`. Only what the model needs is kept: the bore ID, its position, its ground
# elevation and depth, and the hydrostratigraphic log (formation-level scenario). Licence and source fields are not
# read.
#   pip install pyogrio
#   python3 scripts/extract-ngis-deepleads.py --unpack .cache/au/ngis-v1.1.zip .cache/au/ngis
#   python3 scripts/extract-ngis-deepleads.py .cache/au/ngis/NGIS_v1pt1.gdb .cache/au/deepleads-ngis.json
import json, math, os, struct, sys, zlib

# The site: about 10 x 10 km of the basalt plains north-east of Creswick.
WINDOW = (143.86, 143.97, -37.40, -37.31)


def unpack(archive, out):
    data = open(archive, 'rb').read()
    pos = 0
    while pos < len(data) - 30 and data[pos:pos + 4] == b'PK\x03\x04':
        _, flags, method, _, _, _, csize, usize, nlen, elen = struct.unpack('<HHHHHIIIHH', data[pos + 4:pos + 30])
        name = data[pos + 30:pos + 30 + nlen].decode('cp437')
        extra = data[pos + 30 + nlen:pos + 30 + nlen + elen]
        i = 0
        while i < len(extra):
            hid, size = struct.unpack('<HH', extra[i:i + 4])
            if hid == 1:
                usize, csize = struct.unpack('<QQ', extra[i + 4:i + 20])
            i += 4 + size
        start = pos + 30 + nlen + elen
        if start + csize > len(data):
            print('incomplete, skipped:', name)
            break
        path = os.path.join(out, name.split('/', 1)[-1])
        if name.endswith('/'):
            os.makedirs(path, exist_ok=True)
        else:
            os.makedirs(os.path.dirname(path), exist_ok=True)
            raw = data[start:start + csize]
            open(path, 'wb').write(zlib.decompress(raw, -15) if method == 8 else raw)
        pos = start + csize


def number(v):
    if v is None:
        return None
    v = float(v)
    return None if math.isnan(v) else v


def extract(gdb, out):
    from pyogrio.raw import read

    def table(layer, columns, where=None):
        meta, _, _, fields = read(gdb, layer=layer, columns=columns, where=where, read_geometry=False)
        return [dict(zip(meta['fields'], row)) for row in zip(*fields)]

    w = WINDOW
    bores = table('NGIS_Bore', ['HydroID', 'StateBoreID', 'StateTerritory', 'Latitude', 'Longitude', 'HeightDatum', 'LandElev',
                                'LandElevMethod', 'DrilledDepth', 'BoreDepth'],
                  f'StateTerritory=2 AND Longitude>={w[0]} AND Longitude<{w[1]} AND Latitude>={w[2]} AND Latitude<{w[3]}')
    ids = {int(b['HydroID']) for b in bores}
    units = {r['HydroID']: r['HGUName'] for r in table('NGIS_HydrogeologicUnit', ['HydroID', 'HGUName'])}
    logs = {}
    for r in table('NGIS_BoreholeLog', ['BoreID', 'FromDepth', 'ToDepth', 'HGUID', 'Description', 'Scenario']):
        b = number(r['BoreID'])
        if b is None or int(b) not in ids or str(r['Scenario']).split('.')[0] != '1':
            continue
        logs.setdefault(int(b), []).append({'from': number(r['FromDepth']), 'to': number(r['ToDepth']),
                                            'description': r['Description'], 'hgu': units.get(r['HGUID'])})
    site = []
    for b in sorted(bores, key=lambda b: str(b['StateBoreID'])):
        rows = logs.get(int(b['HydroID']))
        if not rows:
            continue
        site.append({'id': str(b['StateBoreID']), 'lat': number(b['Latitude']), 'lon': number(b['Longitude']),
                     'datum': b['HeightDatum'], 'elevation': number(b['LandElev']), 'elevationMethod': b['LandElevMethod'],
                     'depth': number(b['DrilledDepth']) or number(b['BoreDepth']),
                     'log': sorted(rows, key=lambda r: (r['from'] if r['from'] is not None else -1))})
    json.dump({'source': 'NGIS v1.1 (Bureau of Meteorology), data.gov.au, CC BY 3.0 AU', 'window': WINDOW, 'bores': site},
              open(out, 'w'), indent=1)
    print(len(site), 'bores with a hydrostratigraphic log')


if __name__ == '__main__':
    if sys.argv[1] == '--unpack':
        unpack(sys.argv[2], sys.argv[3])
    else:
        extract(sys.argv[1], sys.argv[2])
