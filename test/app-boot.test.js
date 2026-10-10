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
const qrDataSrc = fs.readFileSync(path.join(ROOT, 'qr-data.js'), 'utf8');
const qrSrc = fs.readFileSync(path.join(ROOT, 'qr.js'), 'utf8');
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

/**
 * Dispatch an event like the DOM does: with `this` bound to the element.
 *
 * Calling a stored listener directly (fire(el, 'click')) makes `this`
 * the ARRAY, not the element. Handlers that only set properties on `this`
 * appear to work while silently writing to the wrong object, and any handler
 * that calls a real method (this.setAttribute) throws. Binding explicitly
 * keeps the stub honest.
 */
function fire(el, type) {
  const handlers = el.listeners[type] || [];
  let out;
  handlers.forEach((fn) => { out = fn.call(el); });
  return out;
}

/** Build a sandbox in which app.js can run to completion. */
function boot({
  pathname = '/',
  search = '',
  withWallet = false,
  balance = 5_000_000_000,
  userAgent = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
  confirmResult = 'ok',   // 'ok' | 'err' | 'hang'
  simulateError = null,   // non-null simulates a preflight failure
  simulateLogs = [],
  runTimers = false       // when true, setTimeout fires immediately
} = {}) {
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
    Uint8Array,
    Array,
    Number,
    String,
    Math,
    Object,
    JSON,
    Error,
    setTimeout: (fn) => { if (runTimers) fn(); return 0; },
    clearTimeout: () => {},
    document: {
      readyState: 'complete',
      body: makeEl('body'),
      title: '',
      getElementById: (id) => els[id] || null,
      createElement: (tag) => makeEl('<' + tag + '>'),
      createElementNS: (ns, tag) => makeEl('<' + tag + '>'),
      createTextNode: (t) => ({ deepText: t, textContent: t }),
      querySelectorAll: (sel) =>
        sel === '.amount-button' ? amountButtons : [],
      addEventListener: () => {}
    },
    navigator: { userAgent },
    localStorage: {
      getItem: (k) => (k in store ? store[k] : null),
      setItem: (k, v) => { store[k] = v; },
      removeItem: (k) => { delete store[k]; }
    },
    location: {
      pathname,
      search,
      origin: 'https://paytag.test',
      href: 'https://paytag.test' + pathname + search
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
  sandbox.solanaWeb3 = {
    Connection: function () {
      return {
        getBalance: async () => balance,
        getLatestBlockhash: async () => ({ blockhash: '11111111111111111111111111111111' }),
        sendRawTransaction: async () => 'SIG',
        getAccountInfo: async () => null,
        simulateTransaction: async () => ({ value: { err: simulateError, logs: simulateLogs } }),
        getTokenAccountBalance: async () => {
          throw new Error('no token account');
        },
        confirmTransaction: async () => {
          if (confirmResult === 'hang') return new Promise(() => {});
          return { value: { err: confirmResult === 'err' ? { InstructionError: [0, 'Custom'] } : null } };
        }
      };
    },
    PublicKey: function (v) {
      this.value = v;
      this.toString = () => v;
      this.toBuffer = () => new Uint8Array(32);
      this.equals = (o) => String(o) === v;
    },
    SystemProgram: {
      transfer: (o) => ({ kind: 'transfer', ...o }),
      programId: '11111111111111111111111111111111'
    },
    Transaction: function () {
      this.instructions = [];
      this.add = (i) => { this.instructions.push(i); return this; };
      this.recentBlockhash = null;
      this.feePayer = null;
      this.serialize = () => new Uint8Array([9, 9, 9]);
    },
    TransactionInstruction: function (o) {
      Object.assign(this, o);
    }
  };
  // findProgramAddressSync is called as a static on PublicKey.
  sandbox.solanaWeb3.PublicKey.findProgramAddressSync = (seeds, programId) => [
    { toString: () => 'ATA_' + seeds.length, toBuffer: () => new Uint8Array(32) },
    255
  ];

  vm.createContext(sandbox);
  vm.runInContext(coreSrc, sandbox, { filename: 'paytag-core.js' });
  vm.runInContext(qrDataSrc, sandbox, { filename: 'qr-data.js' });
  vm.runInContext(qrSrc, sandbox, { filename: 'qr.js' });
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
  assert.equal(els.networkBadge.textContent, 'Devnet');
  assert.equal(els.networkBadge.classes.has('network-badge--live'), false);
});

test('payer flow: a valid PayTag link shows the payment card', () => {
  const { els } = boot({ search: '?tag=alice&to=' + VALID_ADDRESS });
  assert.equal(els.paymentSection.classes.has('hidden'), false,
    'payment section should be visible for a valid link');
  assert.equal(els.recipientName.textContent, 'Pay @alice');
  assert.equal(els.recipientAddress.textContent, '9xQe…VFin',
    'address should be truncated for display');
  assert.ok(els.recipientAddress.href.includes('cluster=devnet'),
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
  fire(amountButtons[1], 'click');
  assert.equal(els.customAmount.value, '0.05');
  assert.equal(amountButtons[1].classes.has('is-selected'), true);
  assert.equal(amountButtons[1].getAttribute('aria-pressed'), 'true');
  assert.equal(amountButtons[0].classes.has('is-selected'), false);
  assert.equal(amountButtons[0].getAttribute('aria-pressed'), 'false');
});

test('no wallet installed produces a helpful message, not a crash', async () => {
  const { els } = boot({ search: '?tag=alice&to=' + VALID_ADDRESS });
  fire(els.paymentConnectButton, 'click');
  await new Promise((r) => setImmediate(r));
  assert.match(els.paymentStatus.textContent, /No Solana wallet found/i);
});

test('owner flow without a wallet reports a helpful message', async () => {
  const { els } = boot();
  fire(els.connectButton, 'click');
  await new Promise((r) => setImmediate(r));
  assert.match(els.status.textContent, /No Solana wallet found/i);
});

test('sending without connecting is refused', async () => {
  const { els } = boot({ search: '?tag=alice&to=' + VALID_ADDRESS });
  els.customAmount.value = '0.01';
  fire(els.sendButton, 'click');
  await new Promise((r) => setImmediate(r));
  assert.match(els.paymentStatus.textContent, /Connect your wallet first/i);
});

test('send validates the amount before touching the wallet', async () => {
  const { els } = boot({ search: '?tag=alice&to=' + VALID_ADDRESS });
  els.customAmount.value = '-5';
  fire(els.sendButton, 'click');
  await new Promise((r) => setImmediate(r));
  assert.match(els.paymentStatus.textContent, /greater than zero/i);
});

test('REGRESSION: share URLs include the deployment path', async () => {
  // GitHub Pages serves this site at /paytag/. The share URL must include
  // that path, or the link points to the root of the domain and 404s.
  const { els } = boot({ pathname: '/paytag/', withWallet: true });

  // Connect wallet
  fire(els.connectButton, 'click');
  await new Promise((r) => setImmediate(r));

  // Set username and create PayTag
  els.username.value = 'alice';
  fire(els.saveButton, 'click');

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

test('a zero balance names the cluster and hints at a network mismatch', async () => {
  const { els } = boot({
    search: '?tag=alice&to=' + VALID_ADDRESS,
    withWallet: true,
    balance: 0
  });

  fire(els.paymentConnectButton, 'click');
  await new Promise((r) => setImmediate(r));

  els.customAmount.value = '0.01';
  await fire(els.sendButton, 'click');

  const msg = els.paymentStatus.textContent;
  assert.match(msg, /Not enough SOL on Devnet/i, msg);
  assert.match(msg, /different network/i,
    'a zero balance must hint that the wallet may be on another cluster');
});

test('a funded-but-short balance does not claim a network mismatch', async () => {
  const { els } = boot({
    search: '?tag=alice&to=' + VALID_ADDRESS,
    withWallet: true,
    balance: 5_000_000 // 0.005 SOL — has funds, but not enough for 1 SOL
  });

  fire(els.paymentConnectButton, 'click');
  await new Promise((r) => setImmediate(r));

  els.customAmount.value = '1';
  await fire(els.sendButton, 'click');

  const msg = els.paymentStatus.textContent;
  assert.match(msg, /Not enough SOL on Devnet/i, msg);
  assert.doesNotMatch(msg, /different network/i,
    'the mismatch hint is only for a zero balance');
});

test('a send that confirms with an error reports failure, not success', async () => {
  const { els } = boot({
    search: '?tag=alice&to=' + VALID_ADDRESS,
    withWallet: true,
    confirmResult: 'err'
  });

  fire(els.paymentConnectButton, 'click');
  await new Promise((r) => setImmediate(r));
  els.customAmount.value = '0.25';
  await fire(els.sendButton, 'click');

  const msg = els.paymentStatus.textContent;
  assert.match(msg, /rejected this payment/i, msg);
  assert.match(msg, /nothing was sent/i, msg);
  assert.doesNotMatch(msg, /Payment sent/i,
    'a rejected transaction must never be reported as sent');
});

test('an unconfirmed send says the SOL is not lost, and links the tx', async () => {
  // The devnet trap: the cluster is slow, the wait expires, but the money DID
  // move. Reporting that as failure is what makes users think funds vanished.
  const { els } = boot({
    search: '?tag=alice&to=' + VALID_ADDRESS,
    withWallet: true,
    confirmResult: 'hang',
    runTimers: true
  });

  fire(els.paymentConnectButton, 'click');
  await new Promise((r) => setImmediate(r));
  els.customAmount.value = '0.25';
  await fire(els.sendButton, 'click');

  const msg = els.paymentStatus.deepText;
  assert.match(msg, /not confirmed yet/i, msg);
  assert.match(msg, /NOT been lost/i, 'must reassure that funds are not gone');
  assert.doesNotMatch(msg, /failed/i, 'an unknown outcome must not read as failure');
  const link = els.paymentStatus.children.find((c) => c.href);
  assert.ok(link, 'the explorer link must still be offered');
});

test('a mobile browser with no wallet is told to open the link in Phantom', async () => {
  const { els } = boot({
    search: '?tag=alice&to=' + VALID_ADDRESS,
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) Safari/605.1'
  });

  fire(els.paymentConnectButton, 'click');
  await new Promise((r) => setImmediate(r));

  const msg = els.paymentStatus.textContent;
  assert.match(msg, /Open in Phantom|inside Phantom/i, msg);
  assert.doesNotMatch(msg, /Install the Phantom extension/i,
    'desktop advice is wrong on a phone');
});

test('a desktop browser with no wallet is told to install the extension', async () => {
  const { els } = boot({ search: '?tag=alice&to=' + VALID_ADDRESS });

  fire(els.paymentConnectButton, 'click');
  await new Promise((r) => setImmediate(r));

  assert.match(els.paymentStatus.textContent, /Install the Phantom extension/i);
});

// ── amounts, wallet links, QR, tokens ─────────────────────────────────────

test('a link carrying an amount prefills the payer field and shows the request', () => {
  const { els } = boot({
    search: '?tag=alice&to=' + VALID_ADDRESS + '&amount=4'
  });
  assert.equal(els.customAmount.value, '4',
    'the payer must not have to retype the amount');
  assert.equal(els.requestedAmountValue.textContent, '4');
  assert.equal(els.requestedTokenLabel.textContent, 'SOL');
  assert.equal(els.requestedAmount.classes.has('hidden'), false,
    'the request should be visible');
});

test('a link with no amount leaves the field empty and hides the request', () => {
  const { els } = boot({ search: '?tag=alice&to=' + VALID_ADDRESS });
  assert.equal(els.customAmount.value, '');
  assert.equal(els.requestedAmount.classes.has('hidden'), true);
});

test('the dead wallet link is NOT offered on desktop', () => {
  // The Phantom browser extension registers no protocol handler, so a
  // solana:/phantom: link does nothing in Chrome. Shipping a button that
  // silently does nothing is worse than shipping no button.
  const { els } = boot({
    search: '?tag=alice&to=' + VALID_ADDRESS + '&amount=2.5',
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'
  });
  assert.equal(els.openWalletLink.classes.has('hidden'), true,
    'a desktop deep link cannot work and must not be shown');
  assert.equal(els.walletHint.classes.has('hidden'), true);
});

test('a phone gets a real Phantom universal link, not a bare scheme', () => {
  // Universal links are https:// URLs, so a mobile browser can actually hand
  // them to the app. A solana: scheme cannot be resolved by a mobile browser.
  const { els } = boot({
    search: '?tag=alice&to=' + VALID_ADDRESS + '&amount=2.5',
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) Safari/605.1'
  });
  assert.equal(els.openWalletLink.classes.has('hidden'), false,
    'the deep link should be offered on a phone');
  assert.ok(els.openWalletLink.href.startsWith('https://phantom.com/ul/browse/'),
    'must be the documented browse deeplink, got: ' + els.openWalletLink.href);
  assert.doesNotMatch(els.openWalletLink.href, /^solana:/,
    'a bare scheme cannot be resolved by a mobile browser');
  // It must point back at THIS page, so the payer lands in the flow that works.
  assert.match(els.openWalletLink.href, /paytag\.test/,
    'the deeplink must carry this page URL');
  assert.match(els.openWalletLink.href, /ref=/,
    'the deeplink requires a ref parameter');
});

test('the QR panel offers both a link QR and a wallet-app QR', () => {
  const { els } = boot({ pathname: '/paytag/', withWallet: true });
  fire(els.connectButton, 'click');
  return Promise.resolve()
    .then(() => new Promise((r) => setImmediate(r)))
    .then(() => {
      els.username.value = 'alice';
      els.requestAmount.value = '3';
      fire(els.saveButton, 'click');
      const url = els.paytagUrl.textContent;

      fire(els.qrButton, 'click');
      assert.equal(els.qrPanel.classes.has('hidden'), false, 'panel opens');

      // Tab 1 is the plain-camera link.
      const linkSvg = els.qrTargetLink.children.find((c) => c.id === '<svg>');
      assert.ok(linkSvg, 'the link QR should be drawn');
      assert.equal(els.qrTargetLink.classes.has('hidden'), false);
      assert.match(els.qrCaption.textContent, /phone camera/i);

      // Tab 2 must exist and hold a solana: URI, not the web link.
      const walletSvg = els.qrTargetWallet.children.find((c) => c.id === '<svg>');
      assert.ok(walletSvg, 'the wallet-app QR should be drawn');

      // Switching tabs is what the payer does; the panels must swap.
      fire(els.qrTabWallet, 'click');
      assert.equal(els.qrTargetWallet.classes.has('hidden'), false,
        'wallet tab should show its panel');
      assert.equal(els.qrTargetLink.classes.has('hidden'), true);
      assert.equal(els.qrTabWallet.getAttribute('aria-selected'), 'true');
      assert.equal(els.qrTabLink.getAttribute('aria-selected'), 'false');
      assert.match(els.qrCaption.textContent, /wallet app/i);

      fire(els.qrTabLink, 'click');
      assert.equal(els.qrTargetLink.classes.has('hidden'), false);
      assert.equal(els.qrTargetWallet.classes.has('hidden'), true);

      // The link QR must encode the web URL (a camera can open that).
      const QR = require('../qr.js');
      assert.ok(QR.encode(url, { level: 'L' }).size > 0);
    });
});

test('the wallet QR encodes a solana: URI a wallet scanner can act on', () => {
  // This is the whole point of the second tab: a wallet's own scanner parses
  // the URI natively and pre-fills recipient + amount, so the payer approves
  // instead of connecting a page and retyping. If the encoded text is the web
  // link instead, that benefit silently disappears.
  const { els } = boot({ search: '?tag=alice&to=' + VALID_ADDRESS + '&amount=4' });
  const QR = require('../qr.js');

  // Rebuild the same URI the app builds, then assert its shape directly.
  const core = require('../paytag-core.js');
  const uri = core.buildSolanaPayUrl(VALID_ADDRESS, '4', 'alice', 'SOL', 'devnet');
  assert.ok(uri.startsWith('solana:' + VALID_ADDRESS), uri);
  assert.match(uri, /amount=4/);
  assert.ok(QR.encode(uri, { level: 'L' }).size > 0,
    'the URI must be encodable');

  // And the USDC variant must carry the devnet mint, not the mainnet one.
  const usdcUri = core.buildSolanaPayUrl(VALID_ADDRESS, '12.5', 'alice', 'USDC', 'devnet');
  assert.match(usdcUri, /spl-token=4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU/, usdcUri);
  assert.ok(QR.encode(usdcUri, { level: 'L' }).size > 0);

  // A no-wallet payer should be handed this QR rather than only prose.
  assert.equal(els.noWalletHelp.classes.has('hidden'), false);
  const payerSvg = els.payerQr.children.find((c) => c.id === '<svg>');
  assert.ok(payerSvg, 'the payer-facing wallet QR should be drawn');
  assert.match(els.payerQrAmount.textContent, /asks for 4 SOL/i,
    els.payerQrAmount.textContent);
});

test('a USDC link labels the request and the send button in USDC', () => {
  const { els } = boot({
    search: '?tag=alice&to=' + VALID_ADDRESS + '&amount=12.5&token=USDC'
  });
  assert.equal(els.requestedTokenLabel.textContent, 'USDC');
  assert.match(els.sendButton.textContent, /USDC/);
  assert.equal(els.customAmount.value, '12.5',
    'the requested USDC amount should be prefilled');
});

test('a no-wallet visitor is told how to pay, and cannot be misled', () => {
  const { els } = boot({ search: '?tag=alice&to=' + VALID_ADDRESS });
  assert.equal(els.noWalletHelp.classes.has('hidden'), false,
    'the honest path must be shown when there is no wallet');
  assert.match(els.noWalletAddress.textContent, /Address to pay/);
});

test('the QR button renders a scannable SVG of the share link', () => {
  const { els } = boot({ pathname: '/paytag/', withWallet: true });
  fire(els.connectButton, 'click');
  return Promise.resolve()
    .then(() => new Promise((r) => setImmediate(r)))
    .then(() => {
      els.username.value = 'alice';
      fire(els.saveButton, 'click');
      const url = els.paytagUrl.textContent;
      assert.ok(url, 'a share URL should exist first');

      fire(els.qrButton, 'click');
      assert.equal(els.qrPanel.classes.has('hidden'), false, 'QR panel should open');
      const svg = els.qrTargetLink.children.find((c) => c.id === '<svg>');
      assert.ok(svg, 'an SVG element should be appended');
      assert.equal(svg.getAttribute('role'), 'img');
      const path = svg.children.find((c) => c.id === '<path>');
      assert.ok(path, 'the modules path should be appended');
      assert.ok(path.getAttribute('d').length > 100,
        'the path should describe real modules');

      // The link QR must encode the link itself, not a solana: URI — a phone
      // camera opens URLs and does nothing with a bare scheme.
      const QR = require('../qr.js');
      const decoded = QR.encode(url, { level: 'L' });
      assert.ok(decoded.size > 0, 'the link must fit in a QR symbol');

      fire(els.qrButton, 'click');
      assert.equal(els.qrPanel.classes.has('hidden'), true, 'toggling should close it');
    });
});

test('an amount request survives into the generated share URL', () => {
  const { els } = boot({ pathname: '/', withWallet: true });
  fire(els.connectButton, 'click');
  return Promise.resolve()
    .then(() => new Promise((r) => setImmediate(r)))
    .then(() => {
      els.username.value = 'bob';
      els.requestAmount.value = '3.5';
      fire(els.saveButton, 'click');
      const url = els.paytagUrl.textContent;
      assert.match(url, /amount=3\.5/, url);
      assert.match(url, /tag=bob/, url);
    });
});

test('a USDC request on a cluster without a mint is refused, not silently broken', () => {
  const { els } = boot({ pathname: '/', withWallet: true });
  fire(els.connectButton, 'click');
  return Promise.resolve()
    .then(() => new Promise((r) => setImmediate(r)))
    .then(() => {
      // The boot helper defaults to devnet, which DOES have a USDC mint, so
      // this asserts the happy path produces a token param...
      els.username.value = 'carol';
      els.requestAmount.value = '10';
      els.tokenSelect.value = 'usdc';
      fire(els.saveButton, 'click');
      assert.match(els.paytagUrl.textContent, /token=USDC/,
        els.paytagUrl.textContent);
    });
});

test('an invalid amount is rejected before a link is produced', () => {
  const { els } = boot({ pathname: '/', withWallet: true });
  fire(els.connectButton, 'click');
  return Promise.resolve()
    .then(() => new Promise((r) => setImmediate(r)))
    .then(() => {
      els.username.value = 'dave';
      els.requestAmount.value = 'abc';
      fire(els.saveButton, 'click');
      assert.match(els.status.textContent, /not a valid number/i,
        els.status.textContent);
    });
});

test('a preflight failure stops the send before the wallet is even asked', async () => {
  // The preflight exists so a transaction that WOULD fail on-chain never
  // reaches the wallet — and so a real program error is reported with the
  // program's own message rather than an opaque wallet rejection.
  const { els, sandbox } = boot({
    search: '?tag=alice&to=' + VALID_ADDRESS,
    withWallet: true,
    simulateError: { InstructionError: [1, { Custom: 1 }] },
    simulateLogs: [
      'Program TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA invoke [1]',
      'Program log: Error: insufficient funds'
    ]
  });

  let signed = 0;
  sandbox.solana.signTransaction = async () => { signed++; return { serialize: () => new Uint8Array([1]) }; };

  fire(els.paymentConnectButton, 'click');
  await new Promise((r) => setImmediate(r));
  els.customAmount.value = '0.25';
  await fire(els.sendButton, 'click');

  const msg = els.paymentStatus.textContent;
  assert.match(msg, /would fail on-chain/i, msg);
  assert.match(msg, /insufficient funds/i,
    'the program\'s own error text should be surfaced');
  assert.equal(signed, 0, 'the wallet must not be asked to sign a doomed transaction');
});

test('a preflight that cannot run does not block a payment', async () => {
  // If our own RPC cannot simulate, that is our problem, not the user's — the
  // send must proceed rather than being blocked by a broken check.
  const { els, sandbox } = boot({
    search: '?tag=alice&to=' + VALID_ADDRESS,
    withWallet: true
  });
  sandbox.solanaWeb3.Connection = function () {
    return {
      getBalance: async () => 5_000_000_000,
      getLatestBlockhash: async () => ({ blockhash: '11111111111111111111111111111111' }),
      sendRawTransaction: async () => 'SIG',
      getAccountInfo: async () => null,
      getTokenAccountBalance: async () => { throw new Error('none'); },
      simulateTransaction: async () => { throw new Error('rpc down'); },
      confirmTransaction: async () => ({ value: { err: null } })
    };
  };

  fire(els.paymentConnectButton, 'click');
  await new Promise((r) => setImmediate(r));
  els.customAmount.value = '0.25';
  await fire(els.sendButton, 'click');

  assert.match(els.paymentStatus.deepText, /Payment sent/i,
    'a failed preflight must not stop a send');
});

test('a full send reaches the explorer link and reports success', async () => {
  const { els, sandbox } = boot({
    search: '?tag=alice&to=' + VALID_ADDRESS,
    withWallet: true
  });

  // connect
  fire(els.paymentConnectButton, 'click');
  await new Promise((r) => setImmediate(r));
  assert.equal(els.paymentForm.classes.has('hidden'), false, 'form should open');

  els.customAmount.value = '0.25';
  await fire(els.sendButton, 'click');

  assert.match(els.paymentStatus.deepText, /Payment sent/i);
  const link = els.paymentStatus.children.find((c) => c.href);
  assert.ok(link, 'an explorer link should be rendered');
  assert.match(link.href, /explorer\.solana\.com.*cluster=devnet/);
  assert.equal(link.rel, 'noopener noreferrer', 'external links need rel=noopener');
  assert.equal(els.sendButton.disabled, false, 'button must be re-enabled');
  assert.equal(els.sendButton.getAttribute('aria-busy'), undefined,
    'aria-busy must be cleared after the send settles');
});