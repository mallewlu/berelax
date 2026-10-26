#!/usr/bin/env python3
"""Make the bubble's light-ground studio (Radiance RGBE .hdr, 512x256).

Glass on a white backdrop is shot "bright field": the room is white and
black cards stand just out of frame, so the edges and reflections read dark
and crisp instead of vanishing into the white. This draws that room for the
bubble's light-ground images: white walls, a soft box above, a black card
behind the bubble (its rim reflects that direction) and two narrow black
flags at the sides. Behind the camera stays white, so the bubble's middle
stays clean.

Equirect layout as the shader reads it: u = 0.5 looks behind the bubble,
u = 0 / 1 behind the camera, v = 1 straight up. Only numpy (BSD licence).

Usage: python scripts/make-studio-env.py [out.hdr]
"""
import os
import sys

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from importlib import import_module

hdr = import_module('downsample-env')

W, H = 512, 256


def band(x, lo, hi, soft):
    """1 inside [lo, hi], smooth 0 outside (soft = edge width)."""
    rise = np.clip((x - (lo - soft)) / soft, 0, 1)
    fall = np.clip(((hi + soft) - x) / soft, 0, 1)
    rise, fall = rise * rise * (3 - 2 * rise), fall * fall * (3 - 2 * fall)
    return rise * fall


def main():
    here = os.path.dirname(os.path.abspath(__file__))
    target = sys.argv[1] if len(sys.argv) > 1 else os.path.join(here, '..', 'public', 'bubble', 'env', 'studio-512.hdr')
    u = (np.arange(W) + 0.5) / W
    v = 1 - (np.arange(H) + 0.5) / H  # row 0 is the top
    U, V = np.meshgrid(u, v)
    behind = np.abs(U - 0.5)  # 0 = behind the bubble, 0.5 = behind the camera
    light = np.full((H, W), 0.55)
    light += 2.0 * band(V, 0.86, 1.0, 0.04)  # soft box above
    card = band(behind, 0.0, 0.1, 0.03) * band(V, 0.2, 0.78, 0.05)
    flags = band(np.abs(behind - 0.24), 0.0, 0.025, 0.012) * band(V, 0.15, 0.85, 0.04)
    light *= 1 - 0.985 * np.maximum(card, flags)
    rgb = np.repeat(light[..., None], 3, axis=-1)
    hdr.write_hdr(target, hdr.float_to_rgbe(rgb))
    print(f'{os.path.basename(target)}: {W}x{H}, mean {light.mean():.3f}, min {light.min():.3f}, max {light.max():.2f}, {os.path.getsize(target):,} bytes')


if __name__ == '__main__':
    main()
