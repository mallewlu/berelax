#!/usr/bin/env python3
"""Downsample the bubble's reflection environment (Radiance RGBE .hdr).

Reads public/bubble/env/ufuk.hdr (new-style RLE or flat scanlines), averages
2x2 and 4x4 pixel blocks in linear float (box / area filter, exact for
power-of-two factors) and writes valid RLE RGBE files that three.js HDRLoader
reads: ufuk-1024.hdr and ufuk-512.hdr next to the source.

Ar-Ge 2026-10-26 (ortam): is a smaller environment file visibly different on
the bubble? Only Python stdlib + numpy (BSD licence).

Usage: python scripts/downsample-env.py [source.hdr]
"""
import gzip
import os
import re
import sys

import numpy as np


def read_hdr(path):
    with open(path, 'rb') as f:
        data = f.read()
    pos = 0
    header = []
    while True:
        end = data.index(b'\n', pos)
        line = data[pos:end].decode('ascii', 'replace')
        pos = end + 1
        if line == '':
            break
        header.append(line)
    if not header or not header[0].startswith('#?'):
        raise ValueError('not a Radiance HDR file')
    if not any(h == 'FORMAT=32-bit_rle_rgbe' for h in header):
        raise ValueError('only 32-bit_rle_rgbe is supported')
    end = data.index(b'\n', pos)
    m = re.match(r'-Y (\d+) \+X (\d+)', data[pos:end].decode('ascii'))
    if not m:
        raise ValueError('only -Y H +X W orientation is supported')
    height, width = int(m.group(1)), int(m.group(2))
    pos = end + 1
    buf = np.frombuffer(data, dtype=np.uint8)
    rgbe = np.zeros((height, width, 4), dtype=np.uint8)
    for y in range(height):
        if 8 <= width < 0x8000 and buf[pos] == 2 and buf[pos + 1] == 2 and (int(buf[pos + 2]) << 8 | int(buf[pos + 3])) == width:
            pos += 4
            for c in range(4):
                x = 0
                row = rgbe[y, :, c]
                while x < width:
                    count = int(buf[pos])
                    pos += 1
                    if count > 128:
                        count -= 128
                        row[x:x + count] = buf[pos]
                        pos += 1
                    else:
                        if count == 0:
                            raise ValueError('bad RLE run')
                        row[x:x + count] = buf[pos:pos + count]
                        pos += count
                    x += count
        else:
            # Flat scanline (old-style RLE is not used by modern writers).
            rgbe[y] = buf[pos:pos + width * 4].reshape(width, 4)
            pos += width * 4
    return header, rgbe


def rgbe_to_float(rgbe):
    # Radiance convention: (m + 0.5) / 256 * 2^(e - 128); e == 0 is black.
    e = rgbe[..., 3].astype(np.int32)
    scale = np.where(e > 0, np.ldexp(1.0, e - 136), 0.0)
    return (rgbe[..., :3].astype(np.float64) + 0.5) * scale[..., None] * (e[..., None] > 0)


def float_to_rgbe(rgb):
    v = rgb.max(axis=-1)
    mant, exp = np.frexp(v)
    out = np.zeros(rgb.shape[:-1] + (4,), dtype=np.uint8)
    ok = v > 1e-32
    factor = np.where(ok, mant * 256.0 / np.where(ok, v, 1.0), 0.0)
    out[..., :3] = np.clip(np.floor(rgb * factor[..., None]), 0, 255).astype(np.uint8)
    out[..., 3] = np.where(ok, np.clip(exp + 128, 0, 255), 0).astype(np.uint8)
    return out


def rle_channel(row):
    """Radiance new-style RLE for one channel of one scanline."""
    out = bytearray()
    n = len(row)
    x = 0
    while x < n:
        # Find the next run of at least 4 equal bytes.
        run_start = x
        run_len = 0
        while run_start < n:
            run_len = 1
            while run_start + run_len < n and run_len < 127 and row[run_start + run_len] == row[run_start]:
                run_len += 1
            if run_len >= 4:
                break
            run_start += run_len
        if run_len < 4:
            run_start = n
        # Literal bytes before the run.
        while x < run_start:
            count = min(128, run_start - x)
            out.append(count)
            out.extend(row[x:x + count])
            x += count
        if run_start < n:
            out.append(128 + run_len)
            out.append(row[run_start])
            x = run_start + run_len
    return out


def write_hdr(path, rgbe):
    height, width = rgbe.shape[:2]
    out = bytearray(b'#?RADIANCE\n# downsampled by scripts/downsample-env.py (box filter, linear)\nFORMAT=32-bit_rle_rgbe\n\n')
    out += f'-Y {height} +X {width}\n'.encode('ascii')
    for y in range(height):
        out += bytes([2, 2, width >> 8, width & 255])
        for c in range(4):
            out += rle_channel(rgbe[y, :, c].tobytes())
    with open(path, 'wb') as f:
        f.write(out)


def box_downsample(rgb, k):
    h, w, _ = rgb.shape
    return rgb[: h - h % k, : w - w % k].reshape(h // k, k, w // k, k, 3).mean(axis=(1, 3))


def main():
    here = os.path.dirname(os.path.abspath(__file__))
    source = sys.argv[1] if len(sys.argv) > 1 else os.path.join(here, '..', 'public', 'bubble', 'env', 'ufuk.hdr')
    source = os.path.abspath(source)
    _, rgbe = read_hdr(source)
    rgb = rgbe_to_float(rgbe)
    base, _ = os.path.splitext(source)
    print(f'{os.path.basename(source)}: {rgb.shape[1]}x{rgb.shape[0]}, mean {rgb.mean(axis=(0, 1)).round(4).tolist()}, max {rgb.max():.1f}')
    rows = [(source, os.path.getsize(source))]
    for k in (2, 4):
        small = box_downsample(rgb, k)
        target = f'{base}-{small.shape[1]}.hdr'
        write_hdr(target, float_to_rgbe(small))
        # Round trip: the written file must decode to the averaged image.
        _, back = read_hdr(target)
        error = np.abs(rgbe_to_float(back) - small).max(axis=-1) / np.maximum(small.max(axis=-1), 1e-9)
        print(f'{os.path.basename(target)}: {small.shape[1]}x{small.shape[0]}, mean {small.mean(axis=(0, 1)).round(4).tolist()}, max {small.max():.1f}, round-trip rel. error max {error.max():.4f}')
        rows.append((target, os.path.getsize(target)))
    print('\nfile                 bytes      gzip -9')
    for path, size in rows:
        with open(path, 'rb') as f:
            packed = len(gzip.compress(f.read(), 9))
        print(f'{os.path.basename(path):18} {size:9,} {packed:12,}')


if __name__ == '__main__':
    main()
