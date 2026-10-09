/*
 * Headless boot test for app.js.
 *
 * PayTag has no build step and no jsdom dependency, so we hand app.js a
 * minimal DOM stub built from the REAL ids in index.html. That means this
 * test fails if app.js ever references an element the markup does not have —
 * the same class of bug as a broken $('foo') that returns null at runtime.
 *
 * It exercises the three real routing outcomes: owner, payer, and bad link.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const coreSrc = fs.readFileSync(path.join(ROOT, 'paytag-core.js'), 'utf8');
const appSrc = fs.readFileSync(path.join(ROOT, 'app.js'), 'utf8');

const VALID_ADDRESS = '9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin';

function makeEl(id) {
  const classes = new Set();
  return {
    id,
    textContent: '',
    innerHTML: '',
    value: '',
    href: '',
    dataset: {},
    disabled: false,
    style: {},
    attributes: {},
    classList: {
      add: (c) => classes.add(c),
      remove: (c) => classes.delete(c),
      contains: (c) => classes.has(c),
      toggle: (c, on) => (on ? classes.add(c) : classes.delete(c))
    },
    classes,
    listeners: {},
    addEventListener: function (type, fn) {
      (this.listeners[type] = this.listeners[type] || []).push(fn);
    },
    removeAttribute: function (k) { delete this.attributes[k]; },
    setAttribute: function (k, v) { this.attributes[k] = v; },
    getAttribute: function (k) { return this.attributes[k]; },
    focus: function () {},
    select: function () {},
    appendChild: function (child) { this.children.push(child); return child; },
    /** flat text of everything appended to this node (for assertions) */
    get deepText() {
      return this.textContent + this.children.map((c) => c.deepText || '').join('');
    },
    children: [],
    blur: function () {}
  };
}

/** Build a sandbox in which app.js can run to completion. */
function boot({ pathname = '/', search = '', withWallet = false } = {}) {
  // Seed the element map from the real markup so id wiring is genuinely
  // tested, INCLUDING each element's starting class list (so "starts hidden"
  // is a real assertion rather than an artefact of the stub).
  const els = {};
  for (const tagMatch of html.matchAll(/<[a-zA-Z][^>]*>/g)) {
    const tag = tagMatch[0];
    const idm = tag.match(/\bid="([^"]+)"/);
    if (!idm) continue;
    const el = makeEl(idm[1]);
    const cm = tag.match(/\bclass="([^"]*)"/);
    if (cm) cm[1].trim().split(/\s+/).filter(Boolean).forEach((c) => el.classes.add(c));
    els[idm[1]] = el;
  }

  const amountButtons = [makeEl('amt0'), makeEl('amt1'), makeEl('amt2')];
  amountButtons[0].dataset.amount = '0.01';
  amountButtons[1].dataset.amount = '0.05';
  amountButtons[2].dataset.amount = '0.1';

  const store = {};
  const sandbox = {
    console,
    URLSearchParams,
    URL,
    Promise,
    setTimeout: () => 0,
    clearTimeout: () => {},
    document: {
      readyState: 'complete',
      body: makeEl('body'),
      title: '',
      getElementById: (id) => els[id] || null,
      createElement: (tag) => makeEl('<' + tag + '>'),
      createTextNode: (t) => ({ deepText: t, textContent: t }),
      querySelectorAll: (sel) =>
        sel === '.amount-button' ? amountButtons : [],
      addEventListener: () => {}
    },
    navigator: {},
    localStorage: {
      getItem: (k) => (k in store ? store[k] : null),
      setItem: (k, v) => { store[k] = v; },
      removeItem: (k) => { delete store[k]; }
    },
    location: {
      pathname,
      search,
      origin: 'https://paytag.test'
    },
    window: null
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  sandbox.self = sandbox;

  if (withWallet) {
    sandbox.solana = {
      isPhantom: true,
      connect: async () => ({ publicKey: { toString: () => VALID_ADDRESS } }),
      // app.js calls signed.serialize() on whatever this returns
      signTransaction: async (t) => ({ serialize: () => new Uint8Array([1, 2, 3]), tx: t })
    };
  }

  // solanaWeb3 stub — app.js only touches these at call time, except
  // Connection which is constructed during evaluation.
  let balance = 5_000_000_000; // 5 SOL
  sandbox.solanaWeb3 = {
    Connection: function () {
      return {
        getBalance: async () => balance,
        getLatestBlockhash: async () => ({ blockhash: '11111111111111111111111111111111' }),
        sendRawTransaction: async () => 'SIG',
        confirmTransaction: async () => ({ value: { err: null } })
      };
    },
    PublicKey: function (v) { this.value = v; this.toString = () => v; },
    SystemProgram: { transfer: (o) => ({ kind: 'transfer', ...o }) },
    Transaction: function () {
      this.add = (i) => i;
      this.recentBlockhash = null;
      this.feePayer = null;
    }
  };

  vm.createContext(sandbox);
  vm.runInContext(coreSrc, sandbox, { filename: 'paytag-core.js' });
  vm.runInContext(appSrc, sandbox, { filename: 'app.js' });

  return { els, sandbox, amountButtons };
}

test('owner flow: bare URL shows the create-PayTag card', () => {
  const { els } = boot();
  assert.equal(els.walletDisconnected.classes.has('hidden'), false,
    'owner card should be visible');
  assert.equal(els.paymentSection.classes.has('hidden'), true,
    'payment section must stay hidden on the owner page');
  assert.equal(els.invalidCard.classes.has('hidden'), true,
    'invalid-link card must stay hidden');
});

test('network badge is written from the NETWORK constant', () => {
  const { els } = boot();
  assert.equal(els.networkBadge.textContent, 'Testnet');
  assert.equal(els.networkBadge.classes.has('network-badge--live'), false);
});

test('payer flow: a valid PayTag link shows the payment card', () => {
  const { els } = boot({ search: '?tag=alice&to=' + VALID_ADDRESS });
  assert.equal(els.paymentSection.classes.has('hidden'), false,
    'payment section should be visible for a valid link');
  assert.equal(els.recipientName.textContent, 'Pay @alice');
  assert.equal(els.recipientAddress.textContent, '9xQe…VFin',
    'address should be truncated for display');
  assert.ok(els.recipientAddress.href.includes('cluster=testnet'),
    'explorer link should target the configured cluster');
  assert.equal(els.walletDisconnected.classes.has('hidden'), true,
    'owner card must be hidden when visiting someone else');
});

test('payer flow: legacy ?user=/?wallet= links still work', () => {
  const { els } = boot({ search: '?user=bob&wallet=' + VALID_ADDRESS });
  assert.equal(els.paymentSection.classes.has('hidden'), false);
  assert.equal(els.recipientName.textContent, 'Pay @bob');
});

test('bad link: an invalid address shows a clear error, not a dead end', () => {
  const { els } = boot({ search: '?tag=alice&to=not-a-real-address' });
  assert.equal(els.invalidCard.classes.has('hidden'), false,
    'invalid card should be shown');
  assert.match(els.invalidReason.textContent, /invalid Solana address/i);
  assert.equal(els.paymentSection.classes.has('hidden'), true);
  assert.equal(els.walletDisconnected.classes.has('hidden'), true);
});

test('bad link: a missing address is reported specifically', () => {
  const { els } = boot({ search: '?tag=alice' });
  assert.equal(els.invalidCard.classes.has('hidden'), false);
  assert.match(els.invalidReason.textContent, /missing a destination/i);
});

test('REGRESSION: owner page renders under a /paytag/ deployment prefix', () => {
  // This is the exact path GitHub Pages serves. The live site showed the
  // error card here because "paytag" was parsed as a handle.
  const { els } = boot({ pathname: '/paytag/', search: '' });
  assert.equal(els.invalidCard.classes.has('hidden'), true,
    'bare /paytag/ must NOT show the error card');
  assert.equal(els.walletDisconnected.classes.has('hidden'), false,
    'bare /paytag/ must show the create-PayTag card');
  assert.equal(els.paymentSection.classes.has('hidden'), true);
});

test('REGRESSION: a PayTag link still pays under the /paytag/ prefix', () => {
  const { els } = boot({
    pathname: '/paytag/',
    search: '?tag=alice&to=' + VALID_ADDRESS
  });
  assert.equal(els.paymentSection.classes.has('hidden'), false);
  assert.equal(els.recipientName.textContent, 'Pay @alice');
});

test('short /handle path form is accepted', () => {
  const { els } = boot({ pathname: '/alice', search: '?to=' + VALID_ADDRESS });
  assert.equal(els.paymentSection.classes.has('hidden'), false);
  assert.equal(els.recipientName.textContent, 'Pay @alice');
});

test('amount presets write into the custom amount field and mark selection', () => {
  const { els, amountButtons } = boot({ search: '?tag=alice&to=' + VALID_ADDRESS });
  amountButtons[1].listeners.click[0]();
  assert.equal(els.customAmount.value, '0.05');
  assert.equal(amountButtons[1].classes.has('is-selected'), true);
  assert.equal(amountButtons[1].getAttribute('aria-pressed'), 'true');
  assert.equal(amountButtons[0].classes.has('is-selected'), false);
  assert.equal(amountButtons[0].getAttribute('aria-pressed'), 'false');
});

test('no wallet installed produces a helpful message, not a crash', async () => {
  const { els } = boot({ search: '?tag=alice&to=' + VALID_ADDRESS });
  els.paymentConnectButton.listeners.click[0]();
  await new Promise((r) => setImmediate(r));
  assert.match(els.paymentStatus.textContent, /No Solana wallet found/i);
});

test('owner flow without a wallet reports a helpful message', async () => {
  const { els } = boot();
  els.connectButton.listeners.click[0]();
  await new Promise((r) => setImmediate(r));
  assert.match(els.status.textContent, /No Solana wallet found/i);
});

test('sending without connecting is refused', async () => {
  const { els } = boot({ search: '?tag=alice&to=' + VALID_ADDRESS });
  els.customAmount.value = '0.01';
  els.sendButton.listeners.click[0]();
  await new Promise((r) => setImmediate(r));
  assert.match(els.paymentStatus.textContent, /Connect your wallet first/i);
});

test('send validates the amount before touching the wallet', async () => {
  const { els } = boot({ search: '?tag=alice&to=' + VALID_ADDRESS });
  els.customAmount.value = '-5';
  els.sendButton.listeners.click[0]();
  await new Promise((r) => setImmediate(r));
  assert.match(els.paymentStatus.textContent, /greater than zero/i);
});

test('REGRESSION: share URLs include the deployment path', async () => {
  // GitHub Pages serves this site at /paytag/. The share URL must include
  // that path, or the link points to the root of the domain and 404s.
  const { els } = boot({ pathname: '/paytag/', withWallet: true });

  // Connect wallet
  els.connectButton.listeners.click[0]();
  await new Promise((r) => setImmediate(r));

  // Set username and create PayTag
  els.username.value = 'alice';
  els.saveButton.listeners.click[0]();

  // The generated URL should include the /paytag/ path
  assert.ok(els.paytagUrl.textContent.includes('/paytag/'),
    'share URL should include the deployment path');
  assert.ok(els.paytagUrl.textContent.includes('?tag=alice&to='),
    'share URL should have the correct query string');

  // The saved tag link should also include the path
  const savedLink = els.savedTags.children[1].children[0];
  assert.ok(savedLink.href.includes('/paytag/'),
    'saved tag link should include the deployment path');
});

test('a full send reaches the explorer link and reports success', async () => {
  const { els, sandbox } = boot({
    search: '?tag=alice&to=' + VALID_ADDRESS,
    withWallet: true
  });

  // connect
  els.paymentConnectButton.listeners.click[0]();
  await new Promise((r) => setImmediate(r));
  assert.equal(els.paymentForm.classes.has('hidden'), false, 'form should open');

  els.customAmount.value = '0.25';
  await els.sendButton.listeners.click[0]();

  assert.match(els.paymentStatus.deepText, /Payment sent/i);
  const link = els.paymentStatus.children.find((c) => c.href);
  assert.ok(link, 'an explorer link should be rendered');
  assert.match(link.href, /explorer\.solana\.com.*cluster=testnet/);
  assert.equal(link.rel, 'noopener noreferrer', 'external links need rel=noopener');
  assert.equal(els.sendButton.disabled, false, 'button must be re-enabled');
  assert.equal(els.sendButton.getAttribute('aria-busy'), undefined,
    'aria-busy must be cleared after the send settles');
});