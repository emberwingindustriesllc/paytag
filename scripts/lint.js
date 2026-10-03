#!/usr/bin/env node
/*
 * Minimal lint pass — PayTag has no build step and no ESLint dependency, but
 * it still deserves a few structural guarantees enforced mechanically.
 *
 * Checks:
 *   1. every file parses
 *   2. no innerHTML with dynamic data (XSS guard for a payments app)
 *   3. no `alert(` (the original used it; replaced by inline status)
 *   4. every getElementById() target exists in index.html
 *   5. no literal "bullet"/"arrow" placeholder strings
 *   6. HTML: every id referenced by app.js exists, and vice versa for the
 *      ids the app expects to exist
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');
const problems = [];

function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

const appJs = read('app.js');
const coreJs = read('paytag-core.js');
const html = read('index.html');
const css = read('style.css');

// ── 1. parse ────────────────────────────────────────────────────────────
for (const [name, src] of [['app.js', appJs], ['paytag-core.js', coreJs],
                           ['scripts/serve.js', read('scripts/serve.js')],
                           ['scripts/lint.js', read('scripts/lint.js')]]) {
  try {
    new vm.Script(src, { filename: name });
  } catch (e) {
    problems.push(`${name}: syntax error — ${e.message}`);
  }
}

// ── 2. innerHTML guard ───────────────────────────────────────────────────
for (const [name, src] of [['app.js', appJs], ['paytag-core.js', coreJs]]) {
  src.split('\n').forEach((line, i) => {
    if (/\.innerHTML\s*=/.test(line) && !/\.innerHTML\s*=\s*['"`]\s*['"`]\s*;?/.test(line)) {
      problems.push(`${name}:${i + 1}: innerHTML assignment — use textContent/createElement`);
    }
  });
}

// ── 3. no alert() ───────────────────────────────────────────────────────
appJs.split('\n').forEach((line, i) => {
  if (/\balert\s*\(/.test(line)) problems.push(`app.js:${i + 1}: alert() — use the status element`);
});

// ── 4/6. id wiring ──────────────────────────────────────────────────────
const htmlIds = new Set();
for (const m of html.matchAll(/id="([^"]+)"/g)) htmlIds.add(m[1]);

const referenced = new Set();
for (const m of appJs.matchAll(/\$\('([^']+)'\)/g)) referenced.add(m[1]);
for (const m of appJs.matchAll(/getElementById\(\s*'([^']+)'\s*\)/g)) referenced.add(m[1]);

for (const id of referenced) {
  if (!htmlIds.has(id)) problems.push(`app.js references #${id} but index.html has no such id`);
}

// ids the app expects to exist
const REQUIRED = [
  'networkBadge', 'invalidCard', 'invalidReason', 'walletDisconnected',
  'walletConnected', 'connectButton', 'status', 'connectedWallet',
  'username', 'handleHint', 'saveButton', 'paytagResult', 'paytagHandle',
  'paytagUrl', 'copyButton', 'savedTags', 'paymentSection', 'recipientName',
  'recipientAddress', 'paymentConnectButton', 'paymentForm', 'customAmount',
  'sendButton', 'paymentStatus'
];
for (const id of REQUIRED) {
  if (!htmlIds.has(id)) problems.push(`index.html is missing required id="${id}"`);
}

// ── 5. no placeholder glyph words ───────────────────────────────────────
for (const [name, src] of [['app.js', appJs], ['index.html', html], ['style.css', css]]) {
  src.split('\n').forEach((line, i) => {
    if (/\b(bullet|arrow)\b/i.test(line) && !/aria-/.test(line)) {
      problems.push(`${name}:${i + 1}: literal placeholder word — use • or →`);
    }
  });
}

// ── 6. styles referenced by JS must exist ───────────────────────────────
for (const cls of ['hidden', 'is-selected', 'status--error', 'status--ok',
                   'network-badge--live', 'handle-hint--error']) {
  if (!css.includes('.' + cls)) problems.push(`style.css is missing .${cls}`);
}

// ── 7. every class used in the markup is defined in the CSS ─────────────
// Catches typos that would otherwise fail silently (a typo'd class simply
// does nothing, and there is no browser in CI to notice).
const cssClasses = new Set(
  [...css.matchAll(/\.([a-zA-Z][\w-]*)/g)].map((m) => m[1])
);
const htmlClasses = new Set();
for (const m of html.matchAll(/\bclass="([^"]*)"/g)) {
  m[1].trim().split(/\s+/).filter(Boolean).forEach((c) => htmlClasses.add(c));
}
// classes app.js adds at runtime
for (const c of ['hidden', 'is-selected', 'status--error', 'status--ok',
                 'network-badge--live', 'handle-hint--error']) {
  htmlClasses.add(c);
}
for (const c of htmlClasses) {
  if (!cssClasses.has(c)) problems.push(`class "${c}" is used but not defined in style.css`);
}

// ── 8. every <label for=...> points at a real input ─────────────────────
for (const m of html.matchAll(/<label[^>]*\bfor="([^"]+)"/g)) {
  if (!new RegExp(`\\bid="${m[1]}"`).test(html)) {
    problems.push(`<label for="${m[1]}"> has no matching element id`);
  }
}

// ── 9. balanced-ish tag sanity: every section/div opened is closed ──────
for (const tag of ['section', 'header', 'footer', 'main', 'div']) {
  const open = (html.match(new RegExp(`<${tag}[\\s>]`, 'g')) || []).length;
  const close = (html.match(new RegExp(`</${tag}>`, 'g')) || []).length;
  if (open !== close) {
    problems.push(`unbalanced <${tag}>: ${open} open vs ${close} close`);
  }
}

// ── report ──────────────────────────────────────────────────────────────
if (problems.length) {
  console.error(`lint: ${problems.length} problem(s)\n`);
  for (const p of problems) console.error('  - ' + p);
  process.exit(1);
}
console.log('lint: OK');