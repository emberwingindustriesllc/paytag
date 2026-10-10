#!/usr/bin/env python3
"""
Generate QR fixtures from segno for test/qr.test.js.

The fixtures pin the mask (0-7) so the comparison isolates encoding — data
placement, Reed-Solomon, format info, masking — from the mask-selection
heuristic, which is allowed to differ between implementations as long as the
chosen mask is among the valid ones.

Run:  python scripts/gen-qr-fixtures.py
Requires: pip install segno
"""
import json
import pathlib

import segno

ROOT = pathlib.Path(__file__).resolve().parent.parent
OUT = ROOT / 'test' / 'fixtures' / 'qr-segno.json'

CASES = [
    {'name': 'short-ascii', 'text': 'HELLO PAYTAG', 'level': 'L'},
    {'name': 'solana-uri', 'text': 'solana:9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin', 'level': 'L'},
    {
        'name': 'solana-uri-amount',
        'text': 'solana:9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin?amount=4',
        'level': 'L',
    },
    {
        'name': 'solana-uri-usdc-label',
        'text': 'solana:5y5Peuhq2FvYCC4WLVKM6tirDSRJ4KHa4oACaFb6Xp3d'
                '?amount=12.5&spl-token=4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU'
                '&label=%40alice',
        'level': 'L',
    },
    {
        'name': 'paytag-url',
        'text': 'https://emberwingindustriesllc.github.io/paytag/?tag=alice'
                '&to=9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin&amount=0.25',
        'level': 'L',
    },
    {'name': 'level-m', 'text': 'solana:9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin?amount=4', 'level': 'M'},
    {'name': 'utf8-label', 'text': 'solana:9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin?label=caf\u00e9', 'level': 'L'},
]


def main():
    fixtures = []
    for case in CASES:
        masks = {}
        for mask in range(8):
            qr = segno.make(
                case['text'],
                error=case['level'].lower(),
                mask=mask,
                micro=False,
                mode='byte',
                encoding='utf-8',
                boost_error=False,
            )
            rows = [''.join(str(int(v)) for v in row) for row in qr.matrix]
            masks[str(mask)] = rows
            version = qr.version
            size = len(rows)

        # segno's own choice of mask, for the selection comparison.
        auto = segno.make(case['text'], error=case['level'].lower(),
                          micro=False, mode='byte', encoding='utf-8',
                          boost_error=False)

        fixtures.append({
            'name': case['name'],
            'text': case['text'],
            'level': case['level'],
            'version': version,
            'size': size,
            'masks': masks,
            'segnoAutoMask': auto.mask,
        })

    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(fixtures, indent=1), encoding='utf-8')
    print('wrote %s (%d cases)' % (OUT, len(fixtures)))
    for f in fixtures:
        print('  %-22s v%-3d %dx%d  autoMask=%s' %
              (f['name'], f['version'], f['size'], f['size'], f['segnoAutoMask']))


if __name__ == '__main__':
    main()
