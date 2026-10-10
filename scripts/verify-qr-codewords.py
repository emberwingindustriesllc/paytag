#!/usr/bin/env python3
"""
Compare OUR final codeword sequence against segno's, case by case.

This separates the two possible sources of a matrix mismatch:
  * codewords differ  -> data encoding, padding, Reed-Solomon or interleaving
  * codewords match   -> placement or masking
Without this split you end up guessing at placement while the bug is in
Reed-Solomon (or vice versa).

Run:  python scripts/verify-qr-codewords.py
Requires: pip install segno
"""
import json
import pathlib
import subprocess
import sys

import segno.consts as C
import segno.encoder as E

ROOT = pathlib.Path(__file__).resolve().parent.parent

CASES = [
    ('short-ascii', 'HELLO PAYTAG', 'L', 1),
    ('solana-uri', 'solana:9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin', 'L', None),
    ('solana-uri-amount',
     'solana:9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin?amount=4', 'L', None),
    ('level-m', 'solana:9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin?amount=4', 'M', None),
]

ERR = {'L': C.ERROR_LEVEL_L, 'M': C.ERROR_LEVEL_M}


def segno_codewords(text, level, version):
    error = ERR[level]
    if version is None:
        segments = E.prepare_data(text, C.MODE_BYTE, None)
        version = E.find_version(segments, error, eci=False, micro=False)
    segments = E.prepare_data(text, C.MODE_BYTE, None)
    buff = E.Buffer()
    ver_range = E.version_range(version)
    for segment in segments:
        E.write_segment(buff, segment, None, ver_range, False)
    capacity = C.SYMBOL_CAPACITY[version][error]
    E.write_terminator(buff, capacity, None, len(buff))
    E.write_padding_bits(buff, version, len(buff))
    E.write_pad_codewords(buff, version, capacity, len(buff))
    data = list(buff.toints())
    final = E.make_final_message(version, error, buff)
    # segno's buffer can carry a byte past the symbol's codeword count; the
    # matrix only ever receives `total` codewords, so slice to that.
    total = sum(b[0] * b[1] for b in _spec(version, level))
    return version, data, list(final.toints())[:total]


def _spec(version, level):
    """[[num_blocks, num_total, num_data], ...] straight from segno."""
    import segno.consts as C2
    row = C2.ECC[version]
    key = 1 if level == 'L' else 0
    return [[b.num_blocks, b.num_total, b.num_data] for b in row[key]]


def our_codewords(text, level):
    script = (
        "const QR=require('./qr.js');"
        f"const t={json.dumps(text)};"
        f"const lv={json.dumps(level)};"
        "const bytes=QR._debug.toUtf8Bytes(t);"
        "const v=QR.pickVersion(bytes.length,lv);"
        "const d=QR._debug.buildDataCodewords(bytes,v,lv);"
        "const c=QR._debug.buildCodewords(d,v,lv);"
        "process.stdout.write(JSON.stringify({version:v,data:d,final:c}));"
    )
    out = subprocess.run(['node', '-e', script], cwd=ROOT,
                         capture_output=True, text=True, check=True)
    return json.loads(out.stdout)


def fmt(words):
    return ' '.join('%02x' % b for b in words)


def main():
    bad = 0
    for name, text, level, version in CASES:
        sv, sdata, sfinal = segno_codewords(text, level, version)
        ours = our_codewords(text, level)
        ov, odata, ofinal = ours['version'], ours['data'], ours['final']

        print(f'=== {name} ({level}) ===')
        print(f'  version      segno={sv}  ours={ov}   {"OK" if sv == ov else "DIFFER"}')
        print(f'  data words   segno={len(sdata):>3}  ours={len(odata):>3}')
        print(f'  final words  segno={len(sfinal):>3}  ours={len(ofinal):>3}')

        d_ok = sdata == odata
        f_ok = sfinal == ofinal
        print(f'  data match   {"OK" if d_ok else "DIFFER"}')
        print(f'  final match  {"OK" if f_ok else "DIFFER"}')
        if not d_ok:
            print(f'    segno data : {fmt(sdata)}')
            print(f'    ours  data : {fmt(odata)}')
        if not f_ok:
            print(f'    segno final: {fmt(sfinal)}')
            print(f'    ours  final: {fmt(ofinal)}')
        if not (sv == ov and d_ok and f_ok):
            bad += 1
        print()

    if bad:
        print(f'{bad} of {len(CASES)} cases differ')
        sys.exit(1)
    print(f'all {len(CASES)} cases produce identical codewords to segno')


if __name__ == '__main__':
    main()
