/*
 * PayTag — Pay anyone, anywhere.
 *
 * Zero-backend crypto payments on Solana. A PayTag is a shareable link that
 * carries the destination address, so nothing needs to be hosted or registered.
 *
 * Responsibilities split as:
 *   paytag-core.js  pure logic (handles, amounts, link parsing) — unit tested
 *   app.js          DOM + wallet wiring (this file)
 *
 * Design notes worth keeping:
 *  - No innerHTML is used with external data anywhere. Link parameters are
 *    attacker-controlled, so anything derived from them goes in via
 *    textContent / createElement only.
 *  - The cluster is shown to the user and is requested from the wallet where
 *    supported. Getting devnet/mainnet wrong is the single most expensive
 *    mistake in this app, so it is surfaced loudly rather than assumed.
 *  - web3.js 1.98.x still expects `transaction.recentBlockhash = ...` /
 *    `transaction.feePayer = ...`. The newer setRecentBlockhash()/setFeePayer()
 *    methods DO NOT EXIST in that version — do not "modernise" this.
 */
(function () {
  'use strict';

  // ── configuration ─────────────────────────────────────────────────────────

  var NETWORK = 'devnet'; // 'devnet' | 'testnet' | 'mainnet-beta'

  var RPC = {
    'mainnet-beta': 'https://api.mainnet-beta.solana.com',
    devnet: 'https://api.devnet.solana.com',
    testnet: 'https://api.testnet.solana.com'
  };

  var STORAGE_KEY = 'paytag.savedTags.v1';
  var CONFIRM_TIMEOUT_MS = 45000;
  var FEE_BUFFER_LAMPORTS = 10000;

  // ── dependencies ──────────────────────────────────────────────────────────

  var core = window.PayTagCore;
  if (!core) {
    window.addEventListener('load', function () {
      fatal('paytag-core.js failed to load. Reload the page.');
    });
    return;
  }

  if (typeof window.solanaWeb3 === 'undefined') {
    window.addEventListener('load', function () {
      fatal('Could not load the Solana library. Check your connection and reload.');
    });
    return;
  }

  var Connection = window.solanaWeb3.Connection;
  var PublicKey = window.solanaWeb3.PublicKey;
  var SystemProgram = window.solanaWeb3.SystemProgram;
  var Transaction = window.solanaWeb3.Transaction;

  var connection = new Connection(RPC[NETWORK] || RPC.devnet, 'confirmed');

  // ── state ─────────────────────────────────────────────────────────────────

  var ownerKey = null;   // connected wallet creating a PayTag
  var payerKey = null;   // connected wallet paying someone
  var paytag = null;     // { handle, address } when visiting a PayTag
  var savedTags = loadSavedTags();

  // ── small helpers ─────────────────────────────────────────────────────────

  function $(id) {
    return document.getElementById(id);
  }

  function fatal(msg) {
    var s = $('status');
    if (s) {
      s.textContent = msg;
      s.className = 'status status--error';
    }
  }

  function setStatus(node, msg, kind) {
    if (!node) return;
    node.textContent = msg || '';
    node.className = 'status' + (kind ? ' status--' + kind : '');
  }

  function show(node, visible) {
    if (!node) return;
    node.classList.toggle('hidden', !visible);
  }

  /** Copy with a fallback for insecure contexts (http://, file://). */
  async function copyText(text) {
    if (navigator.clipboard && window.isSecureContext) {
      try {
        await navigator.clipboard.writeText(text);
        return true;
      } catch (e) {
        /* fall through to the legacy path */
      }
    }
    try {
      var ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      var ok = document.execCommand('copy');
      document.body.removeChild(ta);
      return ok;
    } catch (e) {
      return false;
    }
  }

  /** Replace a container's contents with plain text plus one safe link. */
  function renderStatus(container, prefix, link) {
    container.textContent = '';
    if (prefix) {
      container.appendChild(document.createTextNode(prefix));
    }
    if (link && link.href && link.label) {
      var a = document.createElement('a');
      a.href = link.href;
      a.textContent = link.label;
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      container.appendChild(document.createTextNode(' '));
      container.appendChild(a);
    }
  }

  // ── saved tags (local only, never leaves the device) ──────────────────────

  function loadSavedTags() {
    try {
      var raw = window.localStorage.getItem(STORAGE_KEY);
      var parsed = raw ? JSON.parse(raw) : [];
      return Array.isArray(parsed) ? parsed.filter(isUsableTag) : [];
    } catch (e) {
      return [];
    }
  }

  function isUsableTag(t) {
    return !!(t && core.looksLikeAddress(t.address) && core.isValidHandle(t.handle));
  }

  function saveTag(handle, address) {
    var entry = { handle: handle, address: address, savedAt: Date.now() };
    savedTags = [entry].concat(savedTags.filter(function (t) {
      return t.handle !== handle;
    })).slice(0, 5);
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(savedTags));
    } catch (e) {
      /* private mode / quota — non-fatal */
    }
    renderSavedTags();
  }

  function renderSavedTags() {
    var list = $('savedTags');
    if (!list) return;
    list.textContent = '';
    show(list, savedTags.length > 0);
    if (!savedTags.length) return;

    var heading = document.createElement('p');
    heading.className = 'saved-tags__heading';
    heading.textContent = 'Your PayTags';
    list.appendChild(heading);

    savedTags.forEach(function (tag) {
      var row = document.createElement('div');
      row.className = 'saved-tag';

      var link = document.createElement('a');
      link.className = 'saved-tag__link';
      link.href = core.buildShareUrl(window.location.origin + window.location.pathname, tag.handle, tag.address);
      // textContent, never innerHTML — handles come from user input
      link.textContent = '@' + tag.handle;

      var addr = document.createElement('span');
      addr.className = 'saved-tag__addr';
      addr.textContent = core.truncateAddress(tag.address);

      row.appendChild(link);
      row.appendChild(addr);
      list.appendChild(row);
    });
  }

  // ── wallet ────────────────────────────────────────────────────────────────

  function getWallet() {
    var w = window.solana;
    if (!w) return null;
    if (w.isPhantom) return w;
    // Tolerate other injected Solana wallets that do not set isPhantom.
    if (typeof w.connect === 'function' && typeof w.signTransaction === 'function') return w;
    return null;
  }

  /**
   * Connect, asking for the app's cluster when the wallet supports it.
   * Older wallets reject the options object, so fall back to a bare connect().
   */
  async function connectWallet() {
    var wallet = getWallet();
    if (!wallet) throw new Error('NO_WALLET');

    try {
      return await wallet.connect({ network: NETWORK });
    } catch (e) {
      var msg = String((e && e.message) || '');
      if (/network|unsupported|argument|options/i.test(msg)) {
        return await wallet.connect();
      }
      throw e;
    }
  }

  /** True when the connected wallet is reachable on the configured cluster. */
  async function probeCluster(pubkey) {
    try {
      await connection.getBalance(new PublicKey(pubkey));
      return { ok: true };
    } catch (e) {
      return { ok: false, error: String((e && e.message) || e) };
    }
  }

  // ── owner flow: create a PayTag ───────────────────────────────────────────

  function initOwner() {
    $('connectButton').addEventListener('click', async function () {
      var status = $('status');
      var btn = this;
      setStatus(status, 'Connecting…');
      btn.disabled = true;

      try {
        var response = await connectWallet();
        ownerKey = response.publicKey;

        var probe = await probeCluster(ownerKey);
        if (!probe.ok) {
          setStatus(
            status,
            'Connected, but your wallet is not reachable on ' +
              core.networkLabel(NETWORK) + '. Switch networks in your wallet.',
            'error'
          );
          btn.disabled = false;
          return;
        }

        setStatus(status, '');
        $('connectedWallet').textContent =
          'Connected: ' + core.truncateAddress(ownerKey.toString(), 6, 6);
        show($('walletDisconnected'), false);
        show($('walletConnected'), true);
        $('username').focus();
      } catch (e) {
        btn.disabled = false;
        if (e && e.message === 'NO_WALLET') {
          setStatus(status, 'No Solana wallet found. Install Phantom, then reload.', 'error');
        } else if (e && /reject/i.test(String(e.message || ''))) {
          setStatus(status, 'Connection cancelled.');
        } else {
          console.error(e);
          setStatus(status, 'Could not connect. ' + (e && e.message ? e.message : ''), 'error');
        }
      }
    });

    var input = $('username');
    input.addEventListener('input', function () {
      var handle = core.normalizeHandle(input.value);
      var problem = core.handleProblem(handle);
      var hint = $('handleHint');
      if (!hint) return;
      hint.textContent = problem || ('Your PayTag will be @' + handle);
      hint.className = 'handle-hint' + (problem ? ' handle-hint--error' : '');
    });

    $('saveButton').addEventListener('click', function () {
      var status = $('status');
      if (!ownerKey) {
        setStatus(status, 'Connect your wallet first.', 'error');
        return;
      }

      var handle = core.normalizeHandle(input.value);
      var problem = core.handleProblem(handle);
      if (problem) {
        setStatus(status, problem, 'error');
        input.focus();
        return;
      }

      var address = ownerKey.toString();
      var url = core.buildShareUrl(window.location.origin + window.location.pathname, handle, address);

      saveTag(handle, address);

      $('paytagUrl').textContent = url;
      $('paytagHandle').textContent = '@' + handle;
      show($('paytagResult'), true);
      setStatus(status, 'PayTag ready.', 'ok');
    });

    $('copyButton').addEventListener('click', async function () {
      var btn = this;
      var url = $('paytagUrl').textContent;
      var ok = await copyText(url);
      btn.textContent = ok ? 'Copied!' : 'Select and copy';
      window.setTimeout(function () {
        btn.textContent = 'Copy link';
      }, 2000);
      if (!ok) {
        var range = document.createRange();
        range.selectNodeContents($('paytagUrl'));
        var sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(range);
      }
    });

    renderSavedTags();
  }

  // ── visitor flow: pay a PayTag ────────────────────────────────────────────

  function initPayer(paytagData) {
    paytag = paytagData;

    $('recipientName').textContent = paytag.handle
      ? 'Pay @' + paytag.handle
      : 'Pay this address';

    var addrEl = $('recipientAddress');
    addrEl.textContent = core.truncateAddress(paytag.address);
    addrEl.href = core.explorerAddressUrl(paytag.address, NETWORK);

    $('paymentConnectButton').addEventListener('click', async function () {
      var status = $('paymentStatus');
      var btn = this;
      setStatus(status, 'Connecting…');
      btn.disabled = true;

      try {
        var response = await connectWallet();
        payerKey = response.publicKey;

        var probe = await probeCluster(payerKey);
        if (!probe.ok) {
          setStatus(
            status,
            'Your wallet is not reachable on ' + core.networkLabel(NETWORK) +
              '. Switch networks in your wallet and try again.',
            'error'
          );
          btn.disabled = false;
          return;
        }

        btn.textContent = 'Wallet connected';
        show($('paymentForm'), true);
        setStatus(status, '');
        $('customAmount').focus();
      } catch (e) {
        btn.disabled = false;
        if (e && e.message === 'NO_WALLET') {
          setStatus(status, 'No Solana wallet found. Install Phantom, then reload.', 'error');
        } else if (e && /reject/i.test(String(e.message || ''))) {
          setStatus(status, 'Connection cancelled.');
        } else {
          console.error(e);
          setStatus(status, 'Could not connect. ' + (e && e.message ? e.message : ''), 'error');
        }
      }
    });

    Array.prototype.forEach.call(
      document.querySelectorAll('.amount-button'),
      function (btn) {
        btn.addEventListener('click', function () {
          $('customAmount').value = btn.dataset.amount;
          Array.prototype.forEach.call(
            document.querySelectorAll('.amount-button'),
            function (b) {
              var on = b === btn;
              b.classList.toggle('is-selected', on);
              b.setAttribute('aria-pressed', on ? 'true' : 'false');
            }
          );
        });
      }
    );

    $('sendButton').addEventListener('click', sendPayment);
  }

  async function sendPayment() {
    var status = $('paymentStatus');
    var btn = $('sendButton');
    var lamports = core.lamportsFromSol($('customAmount').value);

    if (!lamports) {
      setStatus(status, 'Enter an amount greater than zero.', 'error');
      return;
    }

    var wallet = getWallet();
    if (!wallet || !payerKey) {
      setStatus(status, 'Connect your wallet first.', 'error');
      return;
    }

    if (core.isLiveNetwork(NETWORK)) {
      var proceed = window.confirm(
        'About to send ' + core.solFromLamports(lamports) + ' SOL on MAINNET to\n' +
          paytag.address + '\n\nMainnet transactions cannot be reversed. Continue?'
      );
      if (!proceed) return;
    }

    btn.disabled = true;
    btn.setAttribute('aria-busy', 'true');
    var originalLabel = btn.textContent;

    try {
      setStatus(status, 'Checking balance…');

      var balance = await connection.getBalance(payerKey);
      if (lamports + FEE_BUFFER_LAMPORTS > balance) {
        // A zero balance on the configured cluster almost always means the
        // wallet is pointed at a DIFFERENT cluster than this app, not that the
        // user is actually out of SOL. Say so, or the message is a dead end.
        var hint = balance === 0
          ? ' Your wallet may be on a different network — switch it to ' +
            core.networkLabel(NETWORK) + ' and reload.'
          : '';
        setStatus(
          status,
          'Not enough SOL on ' + core.networkLabel(NETWORK) + '. You have ' +
            core.solFromLamports(balance) + ' SOL available.' + hint,
          'error'
        );
        return;
      }

      setStatus(status, 'Preparing transaction…');

      var transaction = new Transaction().add(
        SystemProgram.transfer({
          fromPubkey: payerKey,
          toPubkey: new PublicKey(paytag.address),
          lamports: lamports
        })
      );

      // web3.js 1.98.x still uses these property assignments.
      var latest = await connection.getLatestBlockhash();
      transaction.recentBlockhash = latest.blockhash;
      transaction.feePayer = payerKey;

      setStatus(status, 'Approve in your wallet…');
      var signed = await wallet.signTransaction(transaction);

      setStatus(status, 'Sending…');
      var signature = await connection.sendRawTransaction(signed.serialize());

      var explorer = {
        href: core.explorerTxUrl(signature, NETWORK),
        label: 'View transaction'
      };

      setStatus(status, 'Waiting for confirmation…');

      // Bounded wait: if it does not confirm in time we still hand back the
      // signature and an explorer link rather than hanging forever.
      var confirmed = await confirmWithTimeout(signature, CONFIRM_TIMEOUT_MS);

      if (confirmed) {
        renderStatus(status, 'Payment sent — ' + core.solFromLamports(lamports) + ' SOL.', explorer);
      } else {
        renderStatus(status, 'Submitted, not confirmed yet. It may still land —', explorer);
      }
    } catch (e) {
      console.error(e);
      var msg = String((e && e.message) || e);
      if (/reject|declin|cancel/i.test(msg)) {
        setStatus(status, 'Cancelled in your wallet.', 'error');
      } else {
        setStatus(status, 'Payment failed: ' + msg, 'error');
      }
    } finally {
      btn.disabled = false;
      btn.removeAttribute('aria-busy');
      btn.textContent = originalLabel;
    }
  }

  /** Promise.race between confirmation and a timeout. Never rejects. */
  function confirmWithTimeout(signature, ms) {
    var timeoutId;
    var timeoutPromise = new Promise(function (resolve) {
      timeoutId = window.setTimeout(function () {
        resolve(false);
      }, ms);
    });
    return Promise.race([
      connection
        .confirmTransaction(signature, 'confirmed')
        .then(function (res) {
          window.clearTimeout(timeoutId);
          return !!(res && res.value && res.value.err === null);
        })
        .catch(function () {
          window.clearTimeout(timeoutId);
          return false;
        }),
      timeoutPromise
    ]);
  }

  // ── invalid link state ────────────────────────────────────────────────────

  function initInvalidLink(reason) {
    show($('walletDisconnected'), false);
    show($('walletConnected'), false);
    show($('paymentSection'), false);
    $('invalidReason').textContent = reason;
    show($('invalidCard'), true);
  }

  // ── boot ──────────────────────────────────────────────────────────────────

  function boot() {
    // Badge is driven by NETWORK so it can never contradict the code.
    var badge = $('networkBadge');
    badge.textContent = core.networkLabel(NETWORK);
    badge.classList.toggle('network-badge--live', core.isLiveNetwork(NETWORK));

    var result = core.parsePayTagFromLocation(
      window.location.pathname,
      window.location.search
    );

    if (result.ok) {
      // Payer view: the owner-facing cards must be hidden, otherwise a
      // visitor sees "Get your PayTag" above someone else's payment form.
      show($('walletDisconnected'), false);
      show($('walletConnected'), false);
      show($('savedTags'), false);
      show($('paymentSection'), true);
      initPayer(result);
    } else if (result.reason !== 'empty') {
      initInvalidLink(result.reason);
    } else {
      initOwner();
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();