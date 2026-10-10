#!/usr/bin/env python3
"""
Verify the wallet-app QR end to end: encode OUR solana: URI, then decode it
with an INDEPENDENT decoder (OpenCV) and confirm the payload survives.

A wallet's scanner is the consumer of this QR, so "our encoder round-trips
through our decoder" would prove nothing. This uses a third-party decoder and
also re-parses the decoded text the way a wallet would.

Run:  python scripts/verify-wallet-qr.py
Requires: pip install opencv-python-headless numpy
"""
import json
import pathlib
import subprocess
import sys
from urllib.parse import parse_qs

import cv2
import numpy as np

ROOT = pathlib.Path(__file__).resolve().parent.parent
SCALE = 8
QUIET = 4

# The two shapes the app can produce.
CASES = [
    ('sol-devnet',
     'solana:5y5Peuhq2FvYCC4WLVKM6tirDSRJ4KHa4oACaFb6Xp3d?amount=4&label=%40wife'),
    ('usdc-devnet',
     'solana:5Uw4H6Bs6Bp7AAVCywVsMNequrmgfU79tZCu9sGk8iyY'
     '?amount=12.5&spl-token=4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU&label=%40wife'),
    ('no-amount',
     'solana:5y5Peuhq2FvYCC4WLVKM6tirDSRJ4KHa4oACaFb6Xp3d'),
]


def matrix_to_image(rows):
    n = len(rows)
    dim = (n + QUIET * 2) * SCALE
    img = np.full((dim, dim), 255, dtype=np.uint8)
    for y, row in enumerate(rows):
        for x, ch in enumerate(row):
            if ch == '1':
                y0, x0 = (y + QUIET) * SCALE, (x + QUIET) * SCALE
                img[y0:y0 + SCALE, x0:x0 + SCALE] = 0
    return cv2.cvtColor(img, cv2.COLOR_GRAY2BGR)


def our_matrix(text):
    script = (
        "const QR=require('./qr.js');"
        f"const qr=QR.encode({json.dumps(text)},{{level:'L'}});"
        "process.stdout.write(JSON.stringify(qr.modules.map(r=>r.map(v=>v?'1':'0').join(''))));"
    )
    out = subprocess.run(['node', '-e', script], cwd=ROOT,
                         capture_output=True, text=True, check=True)
    return json.loads(out.stdout)


def main():
    failures = 0
    for name, uri in CASES:
        rows = our_matrix(uri)
        img = matrix_to_image(rows)
        detector = cv2.QRCodeDetector()
        decoded, _, _ = detector.detectAndDecode(img)

        ok = decoded == uri
        if not ok:
            failures += 1
        print(f'{"OK " if ok else "FAIL"} {name}')
        if not ok:
            print(f'      expected: {uri!r}')
            print(f'      decoded : {decoded!r}')
            continue

        # Now parse it the way a wallet would, to confirm the fields a wallet
        # needs are actually present and well-formed.
        assert decoded.startswith('solana:'), decoded
        body = decoded[len('solana:'):]
        recipient, _, query = body.partition('?')
        q = parse_qs(query)
        print(f'      recipient : {recipient}')
        print(f'      amount    : {q.get("amount", ["-"])[0]}')
        print(f'      spl-token : {q.get("spl-token", ["-"])[0]}')
        print(f'      label     : {q.get("label", ["-"])[0]}')
        # The recipient must be a base58 address a wallet can hand to
        # PublicKey(); anything else fails at the wallet, not here.
        assert recipient and recipient.isalnum(), recipient
        assert 32 <= len(recipient) <= 44, len(recipient)

    print()
    if failures:
        print(f'{failures} of {len(CASES)} failed to round-trip through the decoder')
        sys.exit(1)
    print(f'all {len(CASES)} wallet URIs round-trip through an independent decoder')


if __name__ == '__main__':
    main()
