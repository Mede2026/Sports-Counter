"""Icônes du tray : convertit src-tauri/icons/tray/tray-N.png en pixels bruts
(RGBA, tray-N.rgba) que Rust intègre tel quel, sans bibliothèque d'images.
À relancer après avoir changé les PNG : python3 tools/make-tray.py
"""
import glob
import os
import struct
import zlib

DIR = os.path.join(os.path.dirname(__file__), '..', 'src-tauri', 'icons', 'tray')


def decode(path):
    """PNG RGBA 8 bits, non entrelacé -> (largeur, hauteur, octets RGBA)."""
    data = open(path, 'rb').read()
    assert data[:8] == b'\x89PNG\r\n\x1a\n', path
    pos, idat = 8, b''
    while pos < len(data):
        size, kind = struct.unpack('>I4s', data[pos:pos + 8])
        chunk = data[pos + 8:pos + 8 + size]
        if kind == b'IHDR':
            w, h, depth, color, _, _, interlace = struct.unpack('>IIBBBBB', chunk)
            assert (depth, color, interlace) == (8, 6, 0), f'{path} : RGBA 8 bits non entrelacé attendu'
        elif kind == b'IDAT':
            idat += chunk
        pos += 12 + size
    raw = zlib.decompress(idat)
    stride, bpp = w * 4, 4
    out, prev = bytearray(), bytearray(stride)
    for y in range(h):
        f = raw[y * (stride + 1)]
        line = bytearray(raw[y * (stride + 1) + 1:(y + 1) * (stride + 1)])
        for i in range(stride):
            a = line[i - bpp] if i >= bpp else 0
            b = prev[i]
            c = prev[i - bpp] if i >= bpp else 0
            if f == 1:
                line[i] = (line[i] + a) & 255
            elif f == 2:
                line[i] = (line[i] + b) & 255
            elif f == 3:
                line[i] = (line[i] + (a + b) // 2) & 255
            elif f == 4:
                p = a + b - c
                pa, pb, pc = abs(p - a), abs(p - b), abs(p - c)
                line[i] = (line[i] + (a if pa <= pb and pa <= pc else b if pb <= pc else c)) & 255
        out += line
        prev = line
    return w, h, bytes(out)


for png in sorted(glob.glob(os.path.join(DIR, 'tray-*.png'))):
    w, h, rgba = decode(png)
    open(png[:-4] + '.rgba', 'wb').write(rgba)
    print(os.path.basename(png), f'{w}x{h}', len(rgba), 'octets')
