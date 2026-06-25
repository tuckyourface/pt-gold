#!/usr/bin/env python3
"""Generate PT Gold icons (deep-green field, gold crown) with no external deps."""
import struct, zlib, math

GREEN_D = (10, 61, 42)     # deep Rolex green
GREEN_L = (18, 119, 73)
GOLD_D  = (150, 118, 56)
GOLD    = (197, 163, 90)
GOLD_L  = (233, 209, 150)

def lerp(a, b, t):
    return tuple(int(a[i] + (b[i] - a[i]) * t) for i in range(3))

def write_png(path, size):
    cx, cy = size / 2, size / 2
    r_out = size * 0.46
    r_in  = size * 0.40
    px = bytearray()
    for y in range(size):
        px.append(0)  # filter byte per row
        for x in range(size):
            dx, dy = x - cx, y - cy
            dist = math.hypot(dx, dy)
            a = 255
            if dist > r_out:
                r, g, b, a = 0, 0, 0, 0
            elif dist > r_in:
                r, g, b = GOLD_L                      # gold rim
            else:
                t = (y / size)
                r, g, b = lerp(GREEN_L, GREEN_D, t)   # green field
            # gold crown geometry (normalised)
            nx, ny = (x - cx) / size, (y - cy) / size
            in_crown = False
            # crown band
            if -0.22 <= nx <= 0.22 and 0.02 <= ny <= 0.12:
                in_crown = True
            # three spikes (triangles) rising from band top y=0.02 up to y=-0.20
            for sx in (-0.18, 0.0, 0.18):
                # triangle width shrinks toward apex
                top = -0.20 if sx == 0 else -0.15
                if 0.02 >= ny >= top:
                    frac = (0.02 - ny) / (0.02 - top)
                    half = 0.075 * (1 - frac)
                    if abs(nx - sx) <= half:
                        in_crown = True
            # gemstone dots at spike tips
            for sx, ty in ((-0.18, -0.15), (0.0, -0.20), (0.18, -0.15)):
                if math.hypot(nx - sx, ny - ty) <= 0.035:
                    in_crown = True
            if in_crown and a > 0:
                gt = (ny + 0.20) / 0.32
                r, g, b = lerp(GOLD_L, GOLD_D, max(0.0, min(1.0, gt)))
            px[-1:] = px[-1:]  # noop
            px += bytes((r, g, b, a))
    raw = bytes(px)
    def chunk(typ, data):
        c = struct.pack(">I", len(data)) + typ + data
        return c + struct.pack(">I", zlib.crc32(typ + data) & 0xffffffff)
    sig = b"\x89PNG\r\n\x1a\n"
    ihdr = struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0)
    idat = zlib.compress(raw, 9)
    with open(path, "wb") as f:
        f.write(sig + chunk(b"IHDR", ihdr) + chunk(b"IDAT", idat) + chunk(b"IEND", b""))
    print("wrote", path)

import os
ICON_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "icons")
os.makedirs(ICON_DIR, exist_ok=True)
for s in (16, 48, 128):
    write_png(os.path.join(ICON_DIR, f"icon{s}.png"), s)
