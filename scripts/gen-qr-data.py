#!/usr/bin/env python3
"""
Regenerate qr-data.js from the segno reference library.

Why this exists: QR error-correction block layouts, alignment-pattern
positions and the format/version BCH tables are pure reference data. Typing
them by hand invites silent typos that produce a QR code which scans to the
wrong bytes (or not at all), and a payment QR that scans wrong is worse than
no QR. So they are extracted from a known-good implementation and committed,
and qr.js is verified against segno independently.

Run:  python scripts/gen-qr-data.py
Requires: pip install segno
"""
import json
import pathlib

import segno.consts as C

ROOT = pathlib.Path(__file__).resolve().parent.parent
MAX_VERSION = 20  # v20-L holds 861 bytes; a solana: URL is ~90. Ample.

# segno keys error levels by int: 0=M, 1=L, 2=H, 3=Q. Note this is NOT
# alphabetical and NOT the order used anywhere else — getting it backwards
# silently produces symbols that use the wrong data capacity and the wrong
# Reed-Solomon split, which look like QR codes and do not decode.
LEVEL_KEY = {'L': 1, 'M': 0}
EC_BITS = {'L': 0b01, 'M': 0b00, 'Q': 0b11, 'H': 0b10}
# segno's FORMAT_INFO tuple is indexed by mask + this offset.
FORMAT_OFFSET = {'L': 8, 'M': 0, 'Q': 24, 'H': 16}


def format_info(ec_bits, mask):
    """BCH(15,5) format information, XOR-masked with 0x5412."""
    data = (ec_bits << 3) | mask
    rem = data << 10
    for i in range(14, 9, -1):
        if rem & (1 << i):
            rem ^= 0x537 << (i - 10)
    return ((data << 10) | rem) ^ 0x5412


def version_info(version):
    """BCH(18,6) version information for versions 7+."""
    rem = version << 12
    for i in range(17, 11, -1):
        if rem & (1 << i):
            rem ^= 0x1F25 << (i - 12)
    return (version << 12) | rem


def main():
    ecc = {}
    for v in range(1, MAX_VERSION + 1):
        row = C.ECC[v]
        entry = {}
        for name, key in LEVEL_KEY.items():
            blocks = row[key]
            entry[name] = [[b.num_blocks, b.num_total, b.num_data] for b in blocks]
        # Cross-check the data capacity against segno's own capacity table,
        # which is indexed 1=L, 0=M, 3=H, 2=Q.
        cap_key = {'L': 1, 'M': 0, 'H': 3, 'Q': 2}
        for name in ('L', 'M'):
            total_data = sum(b[0] * b[2] for b in entry[name])
            expected_bits = C.SYMBOL_CAPACITY[v][cap_key[name]]
            if total_data * 8 != expected_bits:
                raise SystemExit(
                    'capacity mismatch v%d-%s: %d bits vs segno %d'
                    % (v, name, total_data * 8, expected_bits))
        ecc[v] = entry

    align = {}
    for v in range(1, MAX_VERSION + 1):
        # Version 1 has no alignment patterns; segno indexes from version 2.
        align[v] = list(C.ALIGNMENT_POS[v - 2]) if v >= 2 else []

    # Format info, indexed by error level then mask.
    fmt = {}
    for name, bits in EC_BITS.items():
        fmt[name] = [format_info(bits, mask) for mask in range(8)]

    # Cross-check our BCH against segno's own table.
    mismatches = []
    for name, offset in FORMAT_OFFSET.items():
        for mask in range(8):
            expected = C.FORMAT_INFO[mask + offset]
            got = format_info(EC_BITS[name], mask)
            if got != expected:
                mismatches.append((name, mask, hex(got), hex(expected)))
    if mismatches:
        raise SystemExit('format-info mismatch vs segno: %r' % (mismatches,))

    ver = {v: version_info(v) for v in range(7, MAX_VERSION + 1)}
    for v, got in ver.items():
        expected = C.VERSION_INFO[v - 7]
        if got != expected:
            raise SystemExit('version-info mismatch for %d: %s vs %s'
                             % (v, hex(got), hex(expected)))

    out = []
    out.append('/*')
    out.append(' * QR reference data — GENERATED FILE, do not edit by hand.')
    out.append(' *')
    out.append(' * Extracted from segno (https://github.com/heuel/segno) by')
    out.append(' * scripts/gen-qr-data.py, and the BCH tables are re-derived and')
    out.append(' * cross-checked against segno at generation time.')
    out.append(' *')
    out.append(' * ECC: [blocks, totalCodewordsPerBlock, dataCodewordsPerBlock]')
    out.append(' */')
    out.append('(function (root) {')
    out.append("  'use strict';")
    out.append('  var QR_DATA = {')
    out.append('    MAX_VERSION: %d,' % MAX_VERSION)
    out.append('    ECC: %s,' % json.dumps(ecc, separators=(',', ':')))
    out.append('    ALIGN: %s,' % json.dumps(align, separators=(',', ':')))
    out.append('    FORMAT: %s,' % json.dumps(fmt, separators=(',', ':')))
    out.append('    VERSION: %s' % json.dumps(ver, separators=(',', ':')))
    out.append('  };')
    out.append('  if (typeof module === "object" && module.exports) {')
    out.append('    module.exports = QR_DATA;')
    out.append('  } else {')
    out.append('    root.QRData = QR_DATA;')
    out.append('  }')
    out.append('})(typeof self !== "undefined" ? self : this);')
    out.append('')

    target = ROOT / 'qr-data.js'
    target.write_text('\n'.join(out), encoding='utf-8')
    print('wrote %s (%d bytes)' % (target, target.stat().st_size))
    print('verified: FORMAT_INFO and VERSION_INFO match segno')


if __name__ == '__main__':
    main()
