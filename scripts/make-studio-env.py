#!/usr/bin/env python3
"""Make the bubble's light-ground environments (Radiance RGBE .hdr, 512x256).

Glass on a white backdrop is shot "bright field": the room is white and
black cards stand just out of frame, so the edges and reflections read dark
and crisp instead of vanishing into the white. This draws that room for the
bubble's light-ground images: white walls, a soft box above, a black card
behind the bubble (its rim reflects that direction) and two narrow black
flags at the sides. Behind the camera stays white, so the bubble's middle
stays clean.

Equirect layout as the shader reads it: u = 0.5 looks behind the bubble,
u = 0 / 1 behind the camera, v = 1 straight up. Only numpy (BSD licence).

Writes studio-512.hdr (bright field) and oda-512.hdr (an everyday room).

Usage: python scripts/make-studio-env.py [out_dir]
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


# Radiance the engine sees directly (the identity page sets the environment
# intensity to 1). The light ground #ede9e3 is ~0.85 in linear light, so
# walls at that level reflect about what the film takes from the ground:
# only colour and the darker or brighter things in the room stay visible.
WALL = 0.85


def studio(U, V, behind):
    """Bright field: white room, soft box above, black card behind the bubble
    (its rim reflects that way), two narrow black flags at the sides."""
    light = np.full(U.shape, WALL)
    light += 2.0 * band(V, 0.86, 1.0, 0.04)
    card = band(behind, 0.0, 0.1, 0.03) * band(V, 0.2, 0.78, 0.05)
    flags = band(np.abs(behind - 0.24), 0.0, 0.025, 0.012) * band(V, 0.15, 0.85, 0.04)
    return light * (1 - 0.985 * np.maximum(card, flags))


def room(U, V, behind):
    """An everyday light room: pale walls, brighter ceiling, a darker floor,
    one daylight window, a dark doorway and the viewer standing behind the
    camera (a real bubble shows whoever looks at it)."""
    light = np.full(U.shape, WALL)
    light = np.where(V > 0.75, 0.95, light)
    light = np.where(V < 0.42, 0.32, light)
    window = band(np.abs(U - 0.72), 0.0, 0.07, 0.01) * band(V, 0.52, 0.8, 0.01)
    light = light * (1 - window) + 5.0 * window
    door = band(np.abs(U - 0.3), 0.0, 0.05, 0.01) * band(V, 0.4, 0.72, 0.01)
    light = light * (1 - 0.88 * door)
    viewer = band(np.minimum(U, 1 - U), 0.0, 0.035, 0.015) * band(V, 0.3, 0.62, 0.03)
    return light * (1 - 0.8 * viewer)


def main():
    here = os.path.dirname(os.path.abspath(__file__))
    out_dir = sys.argv[1] if len(sys.argv) > 1 else os.path.join(here, '..', 'public', 'bubble', 'env')
    u = (np.arange(W) + 0.5) / W
    v = 1 - (np.arange(H) + 0.5) / H  # row 0 is the top
    U, V = np.meshgrid(u, v)
    behind = np.abs(U - 0.5)  # 0 = behind the bubble, 0.5 = behind the camera
    for name, make in (('studio-512.hdr', studio), ('oda-512.hdr', room)):
        light = make(U, V, behind)
        target = os.path.join(out_dir, name)
        hdr.write_hdr(target, hdr.float_to_rgbe(np.repeat(light[..., None], 3, axis=-1)))
        print(f'{name}: {W}x{H}, mean {light.mean():.3f}, min {light.min():.3f}, max {light.max():.2f}, {os.path.getsize(target):,} bytes')


if __name__ == '__main__':
    main()
