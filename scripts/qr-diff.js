// Visualise where our QR matrix differs from segno's for a given case+mask.
const fs = require('node:fs');
const path = require('node:path');
const QR = require('../qr.js');

const FIXTURES = JSON.parse(
  fs.readFileSync(path.join(__dirname, '..', 'test', 'fixtures', 'qr-segno.json'), 'utf8')
);

const name = process.argv[2] || 'short-ascii';
const mask = Number(process.argv[3] || 0);
const fx = FIXTURES.find((f) => f.name === name);

const qr = QR.encode(fx.text, { level: fx.level, mask });
const ours = qr.modules.map((r) => r.map((v) => (v ? '1' : '0')).join(''));
const theirs = fx.masks[String(mask)];

console.log(`case=${name} mask=${mask} ours v${qr.version} ${qr.size}x${qr.size}  segno v${fx.version} ${fx.size}x${fx.size}`);
if (ours.length !== theirs.length) {
  console.log('SIZE MISMATCH — version differs, stopping');
  process.exit(0);
}

const n = ours.length;
let diffs = 0;
const lines = [];
for (let y = 0; y < n; y++) {
  let line = '';
  for (let x = 0; x < n; x++) {
    const a = ours[y][x];
    const b = theirs[y][x];
    if (a === b) {
      line += a === '1' ? '#' : '.';
    } else {
      line += a === '1' ? 'A' : 'B'; // A = ours dark only, B = theirs dark only
      diffs++;
    }
  }
  lines.push(line);
}
console.log(`differing modules: ${diffs}`);
console.log(lines.join('\n'));

if (diffs) {
  console.log('\nfirst 25 differing coordinates (x,y ours theirs):');
  let shown = 0;
  for (let y = 0; y < n && shown < 25; y++) {
    for (let x = 0; x < n && shown < 25; x++) {
      if (ours[y][x] !== theirs[y][x]) {
        console.log(`  (${x},${y}) ours=${ours[y][x]} segno=${theirs[y][x]}`);
        shown++;
      }
    }
  }
}
