#!/usr/bin/env python3
"""Generate the iOS app icon set from the bento logo (pure python, no deps).

Geometry and palette come from docs/assets/bento-logo.svg:
a #16273E rounded square with three blocks — slate, coral, cream — on a 32-unit
grid. The Android launcher icons are hand-authored vector XML with the same
geometry (native/android/.../res/drawable/).
"""
import os
import struct
import zlib

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

NAVY = (0x16, 0x27, 0x3E)
SLATE = (0x5E, 0x76, 0x99)
CORAL = (0xFF, 0x9E, 0x8A)
CREAM = (0xF0, 0xEB, 0xE0)

# (x, y, w, h, color) on the logo's 32-unit grid, radius 2
RECTS = [
    (5, 5, 7, 22, SLATE),
    (14, 5, 13, 10, CORAL),
    (14, 17, 13, 10, CREAM),
]
RADIUS = 2.5


def in_rounded_rect(px, py, x0, y0, x1, y1, r):
    if px < x0 or px >= x1 or py < y0 or py >= y1:
        return False
    cx = min(max(px, x0 + r), x1 - r)
    cy = min(max(py, y0 + r), y1 - r)
    return (px - cx) ** 2 + (py - cy) ** 2 <= r * r or (
        x0 + r <= px < x1 - r or y0 + r <= py < y1 - r)


def render(size, bg, rects, alpha=False):
    scale = size / 32.0
    base = (0, 0, 0) if bg is None else bg
    srects = [(x * scale, y * scale, (x + w) * scale, (y + h) * scale, c)
              for x, y, w, h, c in rects]
    r = RADIUS * scale
    rows = bytearray()
    for y in range(size):
        rows.append(0)
        py = y + 0.5
        for x in range(size):
            px = x + 0.5
            color, a = base, (0 if bg is None else 255)
            for x0, y0, x1, y1, c in srects:
                if in_rounded_rect(px, py, x0, y0, x1, y1, r):
                    color, a = c, 255
                    break
            rows += bytes(color) + (bytes([a]) if alpha else b'')
    return encode_png(size, size, bytes(rows), alpha)


def encode_png(w, h, raw, alpha):
    def chunk(tag, data):
        return struct.pack('>I', len(data)) + tag + data + \
            struct.pack('>I', zlib.crc32(tag + data))
    png = b'\x89PNG\r\n\x1a\n'
    png += chunk(b'IHDR', struct.pack('>IIBBBBB', w, h, 8, 6 if alpha else 2, 0, 0, 0))
    png += chunk(b'IDAT', zlib.compress(raw, 9))
    png += chunk(b'IEND', b'')
    return png


def write(path, data):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, 'wb') as f:
        f.write(data)
    print('%7d  %s' % (len(data), os.path.relpath(path, ROOT)))


iconset = os.path.join(ROOT, 'ios/Bento/Assets.xcassets/AppIcon.appiconset')

# Light and dark share the navy tile (it already is a dark design).
write(os.path.join(iconset, 'icon.png'), render(1024, NAVY, RECTS))
write(os.path.join(iconset, 'icon-dark.png'), render(1024, NAVY, RECTS))
# Tinted: grayscale blocks on transparency; the system supplies the backdrop.
tint = [(x, y, w, h, {SLATE: (150,) * 3, CORAL: (255,) * 3, CREAM: (210,) * 3}[c])
        for x, y, w, h, c in RECTS]
write(os.path.join(iconset, 'icon-tinted.png'), render(1024, None, tint, alpha=True))
