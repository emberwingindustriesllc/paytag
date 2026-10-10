#!/usr/bin/env python3
"""
Decode our QR matrices and segno's with an independent decoder (OpenCV).

This is the decisive check: if a matrix decodes to the original text, it is a
correct QR code regardless of which mask/placement an implementation chose.
Matching segno module-for-module is a stronger claim, but only after this
passes — otherwise we would be chasing cosmetic differences while the symbol
is actually broken.

Run:  python scripts/verify-qr-decode.py
Requires: pip install segno opencv-python-headless numpy
"""
import json
import pathlib
import subprocess
import sys

import cv2
import numpy as np
import segno

ROOT = pathlib.Path(__file__).resolve().parent.parent
SCALE = 8
QUIET = 4


def matrix_to_png_array(rows):
    """rows: list of strings of '0'/'1'. Returns a BGR uint8 image."""
    n = len(rows)
    dim = (n + QUIET * 2) * SCALE
    img = np.full((dim, dim), 255, dtype=np.uint8)
    for y, row in enumerate(rows):
        for x, ch in enumerate(row):
            if ch == '1':
                y0 = (y + QUIET) * SCALE
                x0 = (x + QUIET) * SCALE
                img[y0:y0 + SCALE, x0:x0 + SCALE] = 0
    return cv2.cvtColor(img, cv2.COLOR_GRAY2BGR)


def decode(rows):
    img = matrix_to_png_array(rows)
    detector = cv2.QRCodeDetector()
    text, points, _ = detector.detectAndDecode(img)
    return text


def ours(text, level, mask):
    """Render our encoder's matrix via node so we test the real code path."""
    script = (
        "const QR=require('./qr.js');"
        f"const qr=QR.encode({json.dumps(text)},{{level:{json.dumps(level)},mask:{mask}}});"
        "process.stdout.write(JSON.stringify(qr.modules.map(r=>r.map(v=>v?'1':'0').join(''))));"
    )
    out = subprocess.run(
        ['node', '-e', script], cwd=ROOT, capture_output=True, text=True, check=True
    )
    return json.loads(out.stdout)


def main():
    fixtures = json.loads((ROOT / 'test' / 'fixtures' / 'qr-segno.json').read_text('utf-8'))
    failures = 0

    for fx in fixtures:
        text = fx['text']
        # segno reference, mask 0
        seg_rows = fx['masks']['0']
        seg_decoded = decode(seg_rows)
        seg_ok = seg_decoded == text

        # ours, mask 0
        our_rows = ours(text, fx['level'], 0)
        our_decoded = decode(our_rows)
        our_ok = our_decoded == text

        status = 'OK ' if our_ok else 'FAIL'
        if not our_ok:
            failures += 1
        print(f'{status} {fx["name"]:<22} segno={"ok" if seg_ok else "FAIL"} ours={"ok" if our_ok else "FAIL"}')
        if not our_ok:
            print(f'      expected: {text!r}')
            print(f'      ours    : {our_decoded!r}')
        if not seg_ok:
            print(f'      (note: segno itself did not decode — fixture/decoder issue)')
            print(f'      segno decoded: {seg_decoded!r}')

    print()
    if failures:
        print(f'{failures} of {len(fixtures)} of OUR matrices failed to decode')
        sys.exit(1)
    print(f'all {len(fixtures)} of our matrices decoded correctly')


if __name__ == '__main__':
    main()
