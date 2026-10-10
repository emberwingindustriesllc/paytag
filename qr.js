/*
 * qr.js — a minimal QR Code encoder (byte mode, error levels L and M).
 *
 * Why hand-rolled: PayTag ships with no build step and no runtime
 * dependencies, and a QR code is the only way to pay someone in person.
 * Pulling a CDN library in for that would undo the property the whole app is
 * built on, so the encoder lives here and is verified against the segno
 * reference implementation by test/qr.test.js.
 *
 * Scope is deliberately narrow: byte mode only (a solana: URI is ASCII, but
 * byte mode keeps it correct for any label text), versions 1-20, levels L/M.
 * That covers every URL this app can produce with a wide margin.
 *
 * Reference data (block layouts, alignment positions, BCH tables) lives in
 * qr-data.js, which is generated from segno rather than typed by hand.
 *
 * Algorithm follows ISO/IEC 18004. Structure and masking penalties follow the
 * approach used by Nayuki's reference implementation.
 */
(function (root) {
  'use strict';

  var DATA = (typeof module === 'object' && module.exports)
    ? require('./qr-data.js')
    : root.QRData;

  var MODE_BYTE = 0x4;      // 0100
  var PAD_0 = 0xEC;
  var PAD_1 = 0x11;

  var EC_BITS = { L: 0b01, M: 0b00 };
  var FORMAT_MASK = 0x5412;

  // ── bit buffer ────────────────────────────────────────────────────────────

  function BitBuffer() {
    this.bits = [];
  }

  BitBuffer.prototype.append = function (value, length) {
    for (var i = length - 1; i >= 0; i--) {
      this.bits.push((value >>> i) & 1);
    }
  };

  // ── finite field GF(256) for Reed-Solomon ─────────────────────────────────

  function gfMultiply(x, y) {
    var z = 0;
    for (var i = 7; i >= 0; i--) {
      z = (z << 1) ^ ((z >>> 7) * 0x11d);
      z ^= ((y >>> i) & 1) * x;
    }
    return z & 0xff;
  }

  /** Generator polynomial of the given degree, as `degree` coefficients. */
  function rsDivisor(degree) {
    var result = new Array(degree);
    for (var i = 0; i < degree; i++) result[i] = 0;
    result[degree - 1] = 1;
    var root = 1;
    for (var k = 0; k < degree; k++) {
      for (var j = 0; j < result.length; j++) {
        result[j] = gfMultiply(result[j], root);
        if (j + 1 < result.length) result[j] ^= result[j + 1];
      }
      root = gfMultiply(root, 0x02);
    }
    return result;
  }

  function rsRemainder(data, divisor) {
    var result = new Array(divisor.length);
    for (var i = 0; i < result.length; i++) result[i] = 0;
    for (var d = 0; d < data.length; d++) {
      var factor = (data[d] ^ result[0]) & 0xff;
      for (var s = 0; s < result.length - 1; s++) result[s] = result[s + 1];
      result[result.length - 1] = 0;
      for (var j = 0; j < result.length; j++) {
        result[j] ^= gfMultiply(divisor[j], factor);
      }
    }
    return result;
  }

  // ── capacity / version selection ──────────────────────────────────────────

  /** Total data codewords available for a version+level. */
  function dataCodewords(version, level) {
    var spec = DATA.ECC[version][level];
    var total = 0;
    for (var i = 0; i < spec.length; i++) total += spec[i][0] * spec[i][2];
    return total;
  }

  function countIndicatorBits(version) {
    return version <= 9 ? 8 : 16;
  }

  function pickVersion(byteLen, level) {
    for (var v = 1; v <= DATA.MAX_VERSION; v++) {
      var capacity = dataCodewords(v, level) * 8;
      var needed = 4 + countIndicatorBits(v) + byteLen * 8;
      if (needed <= capacity) return v;
    }
    return -1;
  }

  // ── codeword assembly ─────────────────────────────────────────────────────

  function toUtf8Bytes(text) {
    var out = [];
    for (var i = 0; i < text.length; i++) {
      var code = text.charCodeAt(i);
      if (code < 0x80) {
        out.push(code);
      } else if (code < 0x800) {
        out.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f));
      } else if (code >= 0xd800 && code <= 0xdbff && i + 1 < text.length) {
        // surrogate pair
        var next = text.charCodeAt(i + 1);
        var cp = 0x10000 + ((code - 0xd800) << 10) + (next - 0xdc00);
        out.push(0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 0x3f),
                 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
        i++;
      } else {
        out.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f),
                 0x80 | (code & 0x3f));
      }
    }
    return out;
  }

  function buildDataCodewords(bytes, version, level) {
    var totalData = dataCodewords(version, level);
    var bb = new BitBuffer();
    bb.append(MODE_BYTE, 4);
    bb.append(bytes.length, countIndicatorBits(version));
    for (var i = 0; i < bytes.length; i++) bb.append(bytes[i], 8);

    var capacity = totalData * 8;
    // Terminator: up to four zero bits.
    var terminator = Math.min(4, capacity - bb.bits.length);
    for (var t = 0; t < terminator; t++) bb.bits.push(0);

    // Pad to the codeword boundary.
    //
    // Note the deliberate quirk: when the stream is ALREADY byte-aligned we
    // still insert a full zero codeword, because that is what segno does and
    // the tests verify our output byte-for-byte against segno. Both forms
    // decode identically (a decoder reads the length header and ignores
    // trailing pad codewords), so this is a compatibility choice, not a
    // correctness one. The bounds check is ours: segno would overrun a symbol
    // whose payload exactly fills the capacity, and we must not.
    var padBits = 8 - (bb.bits.length % 8);
    if (bb.bits.length + padBits <= capacity) {
      for (var p = 0; p < padBits; p++) bb.bits.push(0);
    }

    // Pad codewords: EC and 11 alternating.
    var padToggle = true;
    while (bb.bits.length < capacity) {
      bb.append(padToggle ? PAD_0 : PAD_1, 8);
      padToggle = !padToggle;
    }

    var words = [];
    for (var b = 0; b < bb.bits.length; b += 8) {
      var byteVal = 0;
      for (var k = 0; k < 8; k++) byteVal = (byteVal << 1) | bb.bits[b + k];
      words.push(byteVal);
    }
    return words;
  }

  /**
   * Split data codewords into blocks, add Reed-Solomon ECC, and interleave
   * into the final codeword sequence the symbol carries.
   */
  function buildCodewords(dataWords, version, level) {
    var spec = DATA.ECC[version][level];
    var blocks = [];
    var offset = 0;
    var eccLen = 0;

    for (var g = 0; g < spec.length; g++) {
      var numBlocks = spec[g][0];
      var numTotal = spec[g][1];
      var numData = spec[g][2];
      eccLen = numTotal - numData;
      for (var n = 0; n < numBlocks; n++) {
        var data = dataWords.slice(offset, offset + numData);
        offset += numData;
        blocks.push({ data: data, ecc: rsRemainder(data, rsDivisor(eccLen)) });
      }
    }

    var result = [];
    var maxData = 0;
    for (var i = 0; i < blocks.length; i++) {
      if (blocks[i].data.length > maxData) maxData = blocks[i].data.length;
    }
    // Data codewords, column by column across blocks (shorter blocks skip).
    for (var d = 0; d < maxData; d++) {
      for (var b = 0; b < blocks.length; b++) {
        if (d < blocks[b].data.length) result.push(blocks[b].data[d]);
      }
    }
    // Then all ECC codewords, again column by column.
    for (var e = 0; e < eccLen; e++) {
      for (var c = 0; c < blocks.length; c++) result.push(blocks[c].ecc[e]);
    }
    return result;
  }

  // ── matrix construction ───────────────────────────────────────────────────

  function makeMatrix(version, level, codewords, maskOverride) {
    var size = version * 4 + 17;
    var modules = [];
    var isFunction = [];
    var r, c;
    for (r = 0; r < size; r++) {
      modules.push(new Array(size).fill(0));
      isFunction.push(new Array(size).fill(false));
    }

    function setFn(x, y, dark) {
      if (x < 0 || y < 0 || x >= size || y >= size) return;
      modules[y][x] = dark ? 1 : 0;
      isFunction[y][x] = true;
    }

    function drawFinder(cx, cy) {
      for (var dy = -4; dy <= 4; dy++) {
        for (var dx = -4; dx <= 4; dx++) {
          var dist = Math.max(Math.abs(dx), Math.abs(dy));
          setFn(cx + dx, cy + dy, dist !== 2 && dist !== 4);
        }
      }
    }

    function drawAlignment(cx, cy) {
      for (var dy = -2; dy <= 2; dy++) {
        for (var dx = -2; dx <= 2; dx++) {
          setFn(cx + dx, cy + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
        }
      }
    }

    // Timing patterns.
    for (var i = 0; i < size; i++) {
      setFn(6, i, i % 2 === 0);
      setFn(i, 6, i % 2 === 0);
    }

    // Finder patterns (with their separators, via the 9x9 draw).
    drawFinder(3, 3);
    drawFinder(size - 4, 3);
    drawFinder(3, size - 4);

    // Alignment patterns, skipping the three that collide with finders.
    var pos = DATA.ALIGN[version] || [];
    for (var a = 0; a < pos.length; a++) {
      for (var b = 0; b < pos.length; b++) {
        var isCorner =
          (a === 0 && b === 0) ||
          (a === 0 && b === pos.length - 1) ||
          (a === pos.length - 1 && b === 0);
        if (!isCorner) drawAlignment(pos[a], pos[b]);
      }
    }

    // Reserve format-info cells so data is not placed there. Only the
    // isFunction flag is set here — the values are written by writeFormat once
    // the mask is known. (8,6) and (6,8) are TIMING modules and must not be
    // touched: the naive "reserve row 8 and column 8 up to 8" loop zeroes them
    // and silently destroys the timing pattern.
    var fmtCells = [
      [0, 8], [1, 8], [2, 8], [3, 8], [4, 8], [5, 8], [7, 8], [8, 8],
      [8, 7], [8, 5], [8, 4], [8, 3], [8, 2], [8, 1], [8, 0]
    ];
    for (var f = 0; f < fmtCells.length; f++) {
      isFunction[fmtCells[f][1]][fmtCells[f][0]] = true;
    }
    // Second copy: row 8 rightwards, and column 8 downwards.
    for (var f2 = 0; f2 < 8; f2++) {
      isFunction[8][size - 1 - f2] = true;
      isFunction[size - 1 - f2][8] = true;
    }
    // The always-dark module.
    setFn(8, size - 8, true);

    // Version info for versions 7+.
    if (version >= 7) {
      var vbits = DATA.VERSION[version];
      for (var vi = 0; vi < 18; vi++) {
        var bit = (vbits >>> vi) & 1;
        var xx = size - 11 + (vi % 3);
        var yy = Math.floor(vi / 3);
        setFn(xx, yy, bit === 1);
        setFn(yy, xx, bit === 1);
      }
    }

    // ── data placement: two-column zigzag from the bottom-right ──
    var bitIndex = 0;
    var totalBits = codewords.length * 8;
    for (var right = size - 1; right >= 1; right -= 2) {
      if (right === 6) right = 5;
      for (var vert = 0; vert < size; vert++) {
        for (var j = 0; j < 2; j++) {
          var x = right - j;
          var upward = ((right + 1) & 2) === 0;
          var y = upward ? size - 1 - vert : vert;
          if (!isFunction[y][x] && bitIndex < totalBits) {
            var byteIdx = bitIndex >>> 3;
            modules[y][x] = (codewords[byteIdx] >>> (7 - (bitIndex & 7))) & 1;
            bitIndex++;
          }
        }
      }
    }

    // ── masking ──
    var mask = (maskOverride === null || maskOverride === undefined)
      ? chooseMask(modules, isFunction, size, level)
      : maskOverride;
    applyMask(modules, isFunction, size, mask);
    writeFormat(modules, size, level, mask);

    return modules;
  }

  function maskFn(mask, x, y) {
    switch (mask) {
      case 0: return (x + y) % 2 === 0;
      case 1: return y % 2 === 0;
      case 2: return x % 3 === 0;
      case 3: return (x + y) % 3 === 0;
      case 4: return (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0;
      case 5: return ((x * y) % 2) + ((x * y) % 3) === 0;
      case 6: return (((x * y) % 2) + ((x * y) % 3)) % 2 === 0;
      case 7: return (((x + y) % 2) + ((x * y) % 3)) % 2 === 0;
      default: return false;
    }
  }

  function applyMask(modules, isFunction, size, mask) {
    for (var y = 0; y < size; y++) {
      for (var x = 0; x < size; x++) {
        if (!isFunction[y][x] && maskFn(mask, x, y)) {
          modules[y][x] ^= 1;
        }
      }
    }
  }

  function writeFormat(modules, size, level, mask) {
    var bits = DATA.FORMAT[level][mask];
    // modules[y][x]. The two copies are placed around the finder patterns:
    // one runs down the left of the top-left finder and then along its bottom
    // edge; the other sits under the top-right finder and right of the
    // bottom-left one. Getting x and y the wrong way round here still produces
    // a QR-shaped symbol that no decoder can read.
    for (var i = 0; i <= 5; i++) modules[i][8] = (bits >>> i) & 1;
    modules[7][8] = (bits >>> 6) & 1;
    modules[8][8] = (bits >>> 7) & 1;
    modules[8][7] = (bits >>> 8) & 1;
    for (var k = 9; k < 15; k++) modules[8][14 - k] = (bits >>> k) & 1;

    for (var m = 0; m < 8; m++) modules[8][size - 1 - m] = (bits >>> m) & 1;
    for (var n = 8; n < 15; n++) modules[size - 15 + n][8] = (bits >>> n) & 1;
    modules[size - 8][8] = 1; // always dark
  }

  // ── mask selection (penalty scoring) ──────────────────────────────────────

  function penalty(modules, size) {
    var N1 = 3, N2 = 3, N3 = 40, N4 = 10;
    var score = 0;
    var x, y, run, color, i;

    // Rule 1: runs of five or more same-coloured modules in a line.
    for (y = 0; y < size; y++) {
      run = 1;
      color = modules[y][0];
      for (x = 1; x < size; x++) {
        if (modules[y][x] === color) {
          run++;
        } else {
          if (run >= 5) score += N1 + (run - 5);
          color = modules[y][x];
          run = 1;
        }
      }
      if (run >= 5) score += N1 + (run - 5);
    }
    for (x = 0; x < size; x++) {
      run = 1;
      color = modules[0][x];
      for (y = 1; y < size; y++) {
        if (modules[y][x] === color) {
          run++;
        } else {
          if (run >= 5) score += N1 + (run - 5);
          color = modules[y][x];
          run = 1;
        }
      }
      if (run >= 5) score += N1 + (run - 5);
    }

    // Rule 2: 2x2 blocks of one colour.
    for (y = 0; y < size - 1; y++) {
      for (x = 0; x < size - 1; x++) {
        var v = modules[y][x];
        if (v === modules[y][x + 1] &&
            v === modules[y + 1][x] &&
            v === modules[y + 1][x + 1]) {
          score += N2;
        }
      }
    }

    // Rule 3: finder-like 1:1:3:1:1 patterns with a 4-module quiet run.
    var P1 = [1, 0, 1, 1, 1, 0, 1, 0, 0, 0, 0];
    var P2 = [0, 0, 0, 0, 1, 0, 1, 1, 1, 0, 1];
    function matches(get, len, at, pattern) {
      for (var p = 0; p < pattern.length; p++) {
        if (at + p >= len || get(at + p) !== pattern[p]) return false;
      }
      return true;
    }
    for (y = 0; y < size; y++) {
      for (x = 0; x < size; x++) {
        if (matches(function (idx) { return modules[y][idx]; }, size, x, P1)) score += N3;
        if (matches(function (idx) { return modules[y][idx]; }, size, x, P2)) score += N3;
      }
    }
    for (x = 0; x < size; x++) {
      for (y = 0; y < size; y++) {
        if (matches(function (idx) { return modules[idx][x]; }, size, y, P1)) score += N3;
        if (matches(function (idx) { return modules[idx][x]; }, size, y, P2)) score += N3;
      }
    }

    // Rule 4: deviation of the dark-module proportion from 50%.
    var dark = 0;
    for (y = 0; y < size; y++) {
      for (x = 0; x < size; x++) if (modules[y][x]) dark++;
    }
    var total = size * size;
    var percent = (dark * 100) / total;
    var k = Math.floor(Math.abs(percent - 50) / 5);
    score += k * N4;

    return score;
  }

  function chooseMask(modules, isFunction, size, level) {
    var best = 0;
    var bestScore = Infinity;
    for (var mask = 0; mask < 8; mask++) {
      // Fresh copy each time: `modules` stays unmasked for the caller.
      var trial = [];
      for (var y = 0; y < size; y++) trial.push(modules[y].slice());
      applyMask(trial, isFunction, size, mask);
      // Format info participates in scoring, so write it before measuring.
      writeFormat(trial, size, level, mask);
      var s = penalty(trial, size);
      if (s < bestScore) {
        bestScore = s;
        best = mask;
      }
    }
    return best;
  }

  // ── public API ────────────────────────────────────────────────────────────

  /**
   * Encode `text` and return { size, modules, version, level, mask }.
   * Throws when the text cannot fit at the requested level.
   */
  function encode(text, options) {
    options = options || {};
    var level = options.level === 'M' ? 'M' : 'L';
    var bytes = toUtf8Bytes(String(text));

    var version = pickVersion(bytes.length, level);
    if (version < 0 && level === 'L') {
      throw new Error('QR: text too long (' + bytes.length + ' bytes)');
    }
    if (version < 0) {
      // Fall back to the more forgiving level before giving up.
      return encode(text, { level: 'L', mask: options.mask });
    }

    var dataWords = buildDataCodewords(bytes, version, level);
    var codewords = buildCodewords(dataWords, version, level);
    var modules = makeMatrix(version, level, codewords, options.mask);

    return {
      size: version * 4 + 17,
      modules: modules,
      version: version,
      level: level
    };
  }

  /**
   * Render to an SVG string. `scale` is the module size in pixels, `border`
   * the quiet zone in modules (the spec requires 4).
   */
  function toSvg(text, options) {
    options = options || {};
    var scale = options.scale || 4;
    var border = options.border === undefined ? 4 : options.border;
    var qr = encode(text, options);
    var dim = (qr.size + border * 2) * scale;

    var path = [];
    for (var y = 0; y < qr.size; y++) {
      for (var x = 0; x < qr.size; x++) {
        if (qr.modules[y][x]) {
          path.push('M' + ((x + border) * scale) + ' ' + ((y + border) * scale) +
                    'h' + scale + 'v' + scale + 'h-' + scale + 'z');
        }
      }
    }

    return '<svg xmlns="http://www.w3.org/2000/svg" width="' + dim +
      '" height="' + dim + '" viewBox="0 0 ' + dim + ' ' + dim +
      '" shape-rendering="crispEdges" role="img" aria-label="QR code">' +
      '<rect width="' + dim + '" height="' + dim + '" fill="#ffffff"/>' +
      '<path d="' + path.join('') + '" fill="#000000"/></svg>';
  }

  /** Render to a newline-joined string of '#' and ' ' — handy for tests. */
  function toAscii(text, options) {
    var qr = encode(text, options);
    var lines = [];
    for (var y = 0; y < qr.size; y++) {
      var row = '';
      for (var x = 0; x < qr.size; x++) row += qr.modules[y][x] ? '#' : ' ';
      lines.push(row);
    }
    return lines.join('\n');
  }

  /**
   * Build the QR as real SVG DOM nodes.
   *
   * Preferred over toSvg() in the app because it never requires innerHTML.
   * PayTag's whole security posture is "external data goes in via textContent
   * or createElement", and `npm run lint` fails the build on an innerHTML
   * assignment — so the DOM path exists to keep that rule absolute rather than
   * carve out an exception for convenience.
   */
  function toDom(doc, text, options) {
    options = options || {};
    var scale = options.scale || 4;
    var border = options.border === undefined ? 4 : options.border;
    var qr = encode(text, options);
    var dim = (qr.size + border * 2) * scale;
    var NS = 'http://www.w3.org/2000/svg';

    var svg = doc.createElementNS(NS, 'svg');
    svg.setAttribute('width', String(dim));
    svg.setAttribute('height', String(dim));
    svg.setAttribute('viewBox', '0 0 ' + dim + ' ' + dim);
    svg.setAttribute('shape-rendering', 'crispEdges');
    svg.setAttribute('role', 'img');
    svg.setAttribute('aria-label', 'QR code');

    var bg = doc.createElementNS(NS, 'rect');
    bg.setAttribute('width', String(dim));
    bg.setAttribute('height', String(dim));
    bg.setAttribute('fill', '#ffffff');
    svg.appendChild(bg);

    // One path covering every dark module: far fewer nodes than one per module.
    var d = [];
    for (var y = 0; y < qr.size; y++) {
      for (var x = 0; x < qr.size; x++) {
        if (qr.modules[y][x]) {
          d.push('M' + ((x + border) * scale) + ' ' + ((y + border) * scale) +
                 'h' + scale + 'v' + scale + 'h-' + scale + 'z');
        }
      }
    }
    var path = doc.createElementNS(NS, 'path');
    path.setAttribute('d', d.join(''));
    path.setAttribute('fill', '#000000');
    svg.appendChild(path);

    return svg;
  }

  var api = {
    encode: encode,
    toSvg: toSvg,
    toAscii: toAscii,
    toDom: toDom,
    dataCodewords: dataCodewords,
    pickVersion: pickVersion,
    penalty: penalty,
    // Exposed for tests and debugging: lets a test compare the codeword
    // stream against an independent implementation, which separates a
    // Reed-Solomon/interleaving bug from a placement or masking bug.
    _debug: {
      toUtf8Bytes: toUtf8Bytes,
      buildDataCodewords: buildDataCodewords,
      buildCodewords: buildCodewords,
      makeMatrix: makeMatrix
    }
  };

  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  } else {
    root.QR = api;
  }
})(typeof self !== 'undefined' ? self : this);
