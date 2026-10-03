/*
 * PayTag core tests — node:test
 * Run with:  npm test
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');

const core = require('../paytag-core.js');

// A syntactically valid Solana address (base58, 44 chars) used as a fixture.
const VALID_ADDRESS =
  '9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin';

test('normalizeHandle lowercases, trims, strips @ and junk', () => {
  assert.equal(core.normalizeHandle('  @Alice  '), 'alice');
  assert.equal(core.normalizeHandle('MiXeD_Case-99'), 'mixed_case-99');
  assert.equal(core.normalizeHandle('a b!c'), 'abc');
  assert.equal(core.normalizeHandle('@@bob'), 'bob');
  assert.equal(core.normalizeHandle(null), '');
  assert.equal(core.normalizeHandle(undefined), '');
});

test('handleProblem rejects bad handles with a usable message', () => {
  assert.equal(core.handleProblem('alice'), null);
  assert.equal(core.handleProblem('a_b-9'), null);
  assert.ok(core.handleProblem(''), 'empty handle should be rejected');
  assert.ok(core.handleProblem('ab'), 'too short should be rejected');
  assert.ok(core.handleProblem('a'.repeat(21)), 'too long should be rejected');
  assert.ok(core.handleProblem('-leading'), 'leading dash should be rejected');
  assert.ok(core.handleProblem('trailing-'), 'trailing dash should be rejected');
});

test('isValidHandle agrees with handleProblem', () => {
  assert.equal(core.isValidHandle('alice'), true);
  assert.equal(core.isValidHandle('_alice'), false);
});

test('lamportsFromSol converts and rejects', () => {
  assert.equal(core.lamportsFromSol(1), 1000000000);
  assert.equal(core.lamportsFromSol(0.01), 10000000);
  assert.equal(core.lamportsFromSol('0.05'), 50000000);
  assert.equal(core.lamportsFromSol(0), null);
  assert.equal(core.lamportsFromSol(-1), null);
  assert.equal(core.lamportsFromSol('abc'), null);
  assert.equal(core.lamportsFromSol(NaN), null);
  assert.equal(core.lamportsFromSol(Infinity), null);
  assert.equal(core.lamportsFromSol(1e12), null);
  // dust still rounds to something positive
  assert.equal(core.lamportsFromSol(0.000000001), 1);
});

test('solFromLamports round-trips', () => {
  assert.equal(core.solFromLamports(1000000000), '1');
  assert.equal(core.solFromLamports(10000000), '0.01');
  assert.equal(core.solFromLamports(0), '0');
  assert.equal(core.solFromLamports(-5), '0');
  assert.equal(core.solFromLamports('nope'), '0');
});

test('looksLikeAddress accepts base58 and rejects lookalikes', () => {
  assert.equal(core.looksLikeAddress(VALID_ADDRESS), true);
  assert.equal(core.looksLikeAddress(''), false);
  assert.equal(core.looksLikeAddress('not-an-address'), false);
  // 0, O, I and l are not in the base58 alphabet
  assert.equal(core.looksLikeAddress('0x1234567890abcdefghij'), false);
  assert.equal(core.looksLikeAddress('lOIl'), false);
  assert.equal(core.looksLikeAddress('a'.repeat(45)), false, 'too long');
  assert.equal(core.looksLikeAddress(null), false);
});

test('truncateAddress is readable and leaves short values alone', () => {
  const t = core.truncateAddress(VALID_ADDRESS);
  assert.ok(t.startsWith('9xQe'), t);
  assert.ok(t.endsWith('VFin'), t);
  assert.equal(t, '9xQe…VFin');
  assert.equal(core.truncateAddress('short'), 'short');
});

test('parsePayTag reads canonical tag/to params', () => {
  const r = core.parsePayTag('?tag=alice&to=' + VALID_ADDRESS);
  assert.equal(r.ok, true);
  assert.equal(r.handle, 'alice');
  assert.equal(r.address, VALID_ADDRESS);
});

test('parsePayTag still reads legacy user/wallet params', () => {
  const r = core.parsePayTag('?user=alice&wallet=' + VALID_ADDRESS);
  assert.equal(r.ok, true, 'legacy links must keep working');
  assert.equal(r.handle, 'alice');
  assert.equal(r.address, VALID_ADDRESS);
});

test('parsePayTag rejects malformed links with a reason', () => {
  assert.deepEqual(core.parsePayTag(''), { ok: false, reason: 'empty' });
  assert.equal(core.parsePayTag('?tag=alice').ok, false);
  assert.match(core.parsePayTag('?tag=alice').reason, /missing a destination/i);
  assert.equal(core.parsePayTag('?tag=alice&to=nope').ok, false);
  assert.match(core.parsePayTag('?tag=alice&to=nope').reason, /invalid Solana address/i);
});

test('REGRESSION: a sub-path deployment prefix is not mistaken for a handle',
  () => {
    // GitHub Pages serves this site at /paytag/. The old parser read "paytag"
    // as a handle, then found no address and rendered the error card on the
    // bare root URL instead of the "Get your PayTag" screen.
    for (const prefix of ['/paytag/', '/app/', '/my-repo/', '/x/']) {
      const r = core.parsePayTagFromLocation(prefix, '');
      assert.deepEqual(r, { ok: false, reason: 'empty' },
        `${prefix} with no query must be the owner page`);
    }
    assert.equal(core.parsePayTagFromLocation('/paytag', '').reason, 'empty');
  });

test('REGRESSION: the URL 404.html produces is parsed correctly', () => {
  // Under a sub-path deployment a short link /paytag/alice?to=ADDR is
  // normalised by 404.html to /paytag/?tag=alice&to=ADDR. That normalised
  // URL is what the app must parse — this is the real handoff.
  const r = core.parsePayTagFromLocation(
    '/paytag/',
    '?tag=alice&to=' + VALID_ADDRESS
  );
  assert.equal(r.ok, true);
  assert.equal(r.handle, 'alice');
  assert.equal(r.address, VALID_ADDRESS);
});

test('single-segment short form works on a root deployment', () => {
  // Custom domain / or a plain static host: /alice?to=ADDR
  const r = core.parsePayTagFromLocation('/alice', '?to=' + VALID_ADDRESS);
  assert.equal(r.ok, true);
  assert.equal(r.handle, 'alice');
});

test('an explicit tag with no address is still reported as broken', () => {
  // Real intent — the sender made a tag but forgot the address.
  const r = core.parsePayTagFromLocation('/paytag/', '?tag=alice');
  assert.equal(r.ok, false);
  assert.match(r.reason, /missing a destination/i);
});

test('parsePayTagFromLocation supports the /handle path form', () => {
  const r = core.parsePayTagFromLocation('/alice', '?to=' + VALID_ADDRESS);
  assert.equal(r.ok, true);
  assert.equal(r.handle, 'alice');

  const root = core.parsePayTagFromLocation('/', '?tag=bob&to=' + VALID_ADDRESS);
  assert.equal(root.ok, true);
  assert.equal(root.handle, 'bob');
});

test('buildShareUrl produces a canonical link that parses back', () => {
  const url = core.buildShareUrl('https://pay.example/', 'Alice', VALID_ADDRESS);
  assert.equal(url, 'https://pay.example/?tag=alice&to=' + VALID_ADDRESS);

  const round = core.parsePayTagFromLocation(
    new URL(url).pathname,
    new URL(url).search
  );
  assert.equal(round.ok, true);
  assert.equal(round.handle, 'alice');
  assert.equal(round.address, VALID_ADDRESS);
});

test('buildShareUrl omits an empty handle rather than emitting a bad one', () => {
  const url = core.buildShareUrl('https://pay.example', '!!', VALID_ADDRESS);
  assert.ok(url.includes('?to='), url);
  assert.ok(!url.includes('tag='), url);
});

test('explorer links target the right cluster', () => {
  const dev = core.explorerTxUrl('SIG', 'devnet');
  assert.ok(dev.includes('cluster=devnet'), dev);
  assert.ok(dev.endsWith('/tx/SIG'), dev);

  const live = core.explorerTxUrl('SIG', 'mainnet-beta');
  assert.ok(!live.includes('cluster='), live);
  assert.ok(live.startsWith('https://explorer.solana.com'), live);
});

test('networkLabel and isLiveNetwork', () => {
  assert.equal(core.networkLabel('devnet'), 'Devnet');
  assert.equal(core.networkLabel('mainnet-beta'), 'Mainnet');
  assert.equal(core.networkLabel('testnet'), 'Testnet');
  assert.equal(core.isLiveNetwork('mainnet-beta'), true);
  assert.equal(core.isLiveNetwork('devnet'), false);
});