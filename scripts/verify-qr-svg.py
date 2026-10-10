#!/usr/bin/env python3
"""
Verify the RENDERED SVG, not just the matrix.

Everything so far checked qr.js's matrix. But the browser draws the SVG that
toDom() builds from that matrix, and a bug in the path geometry (wrong scale,
off-by-one in the quiet zone, inverted coordinates) would produce a perfect
matrix and an unscannable image. This rasterises the actual SVG path string and
decodes it, closing that gap.

Run:  python scripts/verify-qr-svg.py
Requires: pip install opencv-python-headless numpy
"""
import json
import pathlib
import re
import subprocess
import sys

import cv2
import numpy as np

ROOT = pathlib.Path(__file__).resolve().parent.parent

CASES = [
    'https://emberwingindustriesllc.github.io/paytag/?tag=wife&to=5y5Peuhq2FvYCC4WLVKM6tirDSRJ4KHa4oACaFb6Xp3d&amount=4',
    'solana:5y5Peuhq2FvYCC4WLVKM6tirDSRJ4KHa4oACaFb6Xp3d?amount=4&label=%40wife',
    'solana:5Uw4H6Bs6Bp7AAVCywVsMNequrmgfU79tZCu9sGk8iyY?amount=12.5&spl-token=4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU&label=%40wife',
]


def our_svg(text):
    script = (
        "const QR=require('./qr.js');"
        f"process.stdout.write(QR.toSvg({json.dumps(text)},{{scale:4,border:4}}));"
    )
    out = subprocess.run(['node', '-e', script], cwd=ROOT,
                         capture_output=True, text=True, check=True)
    return out.stdout


def rasterise(svg):
    """Rebuild the image from the SVG's own width/height and path data."""
    m = re.search(r'width="(\d+)" height="(\d+)"', svg)
    if not m:
        raise SystemExit('SVG has no width/height')
    w, h = int(m.group(1)), int(m.group(2))
    img = np.full((h, w), 255, dtype=np.uint8)

    d = re.search(r'<path d="([^"]*)"', svg)
    if not d:
        raise SystemExit('SVG has no path')
    # Each module is "M{x} {y}h{s}v{s}h-{s}z" — read the origin of every one.
    for mx, my, hs, vs in re.findall(
            r'M(\d+) (\d+)h(\d+)v(\d+)h-', d.group(1)):
        x, y, s = int(mx), int(my), int(hs)
        img[y:y + s, x:x + s] = 0
    return cv2.cvtColor(img, cv2.COLOR_GRAY2BGR), w, h


def main():
    failures = 0
    for text in CASES:
        svg = our_svg(text)
        img, w, h = rasterise(svg)
        detector = cv2.QRCodeDetector()
        decoded, _, _ = detector.detectAndDecode(img)

        ok = decoded == text
        label = text[:52] + ('…' if len(text) > 52 else '')
        print(f'{"OK " if ok else "FAIL"} {w}x{h}  {label}')
        if not ok:
            failures += 1
            print(f'      decoded: {decoded!r}')

        # Geometry sanity: square, and a whole number of modules + quiet zone.
        if w != h:
            failures += 1
            print(f'      NOT SQUARE: {w}x{h}')
        if w % 4 != 0:
            failures += 1
            print(f'      width {w} is not a multiple of the 4px scale')

    print()
    if failures:
        print(f'{failures} problem(s) in the rendered SVG')
        sys.exit(1)
    print(f'all {len(CASES)} SVGs rasterise and decode correctly')


if __name__ == '__main__':
    main()
