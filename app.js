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
  // Devnet is not a production-grade cluster and regularly takes far longer
  // than mainnet to finalise a transaction. A 45s cap reported "not confirmed"
  // for transactions that DID land, which reads as "your money vanished".
  var CONFIRM_TIMEOUT_MS = 90000;
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
  var TransactionInstruction = window.solanaWeb3.TransactionInstruction;

  // SPL programs. These IDs are fixed protocol constants, not configuration.
  var TOKEN_PROGRAM_ID = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
  var ASSOCIATED_TOKEN_PROGRAM_ID = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL';
  // SPL Token instruction discriminators (u8 prefix on the instruction data).
  var IX_TRANSFER_CHECKED = 12;
  var IX_ATA_CREATE_IDEMPOTENT = 1;

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

  function saveTag(handle, address, amount, token) {
    var entry = {
      handle: handle,
      address: address,
      amount: core.normalizeAmount(amount),
      token: core.normalizeTokenSymbol(token),
      savedAt: Date.now()
    };
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
      link.href = core.buildShareUrl(
        window.location.origin + window.location.pathname,
        tag.handle, tag.address, tag.amount, tag.token
      );
      // textContent, never innerHTML — handles come from user input
      link.textContent = '@' + tag.handle;

      var addr = document.createElement('span');
      addr.className = 'saved-tag__addr';
      var label = core.truncateAddress(tag.address);
      if (tag.amount) {
        label = tag.amount + ' ' + (tag.token || 'SOL') + ' · ' + label;
      }
      addr.textContent = label;

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

  /** True when running on a phone/tablet, where wallets do not inject. */
  function isMobile() {
    return /Android|iPhone|iPad|iPod/i.test(navigator.userAgent || '');
  }

  // ── SPL token plumbing (USDC and friends) ─────────────────────────────────

  /**
   * The Associated Token Account for (owner, mint).
   *
   * An SPL token is never held directly by a wallet — it lives in a token
   * account whose address is derived, not chosen. Same seeds every wallet
   * uses, so both sides agree on the address without any coordination.
   */
  function deriveAta(ownerKey, mintKey) {
    var tokenProgram = new PublicKey(TOKEN_PROGRAM_ID);
    var ataProgram = new PublicKey(ASSOCIATED_TOKEN_PROGRAM_ID);
    var found = PublicKey.findProgramAddressSync(
      [ownerKey.toBuffer(), tokenProgram.toBuffer(), mintKey.toBuffer()],
      ataProgram
    );
    return found[0];
  }

  /** Associated Token Account program: CreateIdempotent. */
  function createAtaInstruction(funder, ata, owner, mint) {
    return new TransactionInstruction({
      programId: new PublicKey(ASSOCIATED_TOKEN_PROGRAM_ID),
      keys: [
        { pubkey: funder, isSigner: true, isWritable: true },
        { pubkey: ata, isSigner: false, isWritable: true },
        { pubkey: owner, isSigner: false, isWritable: false },
        { pubkey: mint, isSigner: false, isWritable: false },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        { pubkey: new PublicKey(TOKEN_PROGRAM_ID), isSigner: false, isWritable: false }
      ],
      data: Uint8Array.from([IX_ATA_CREATE_IDEMPOTENT])
    });
  }

  /**
   * SPL Token program: TransferChecked.
   *
   * The Checked variant is used deliberately: it passes the mint and decimals
   * so the program itself rejects a decimals mismatch. Plain Transfer (3) does
   * not, and a wrong decimals value silently moves 1000x the intended amount.
   */
  function transferCheckedInstruction(source, mint, destination, owner, amount, decimals) {
    var data = new Uint8Array(10);
    data[0] = IX_TRANSFER_CHECKED;
    // u64 little-endian. Amounts here are well under 2^53 so plain division is
    // exact; the byte loop avoids relying on BigInt for one field.
    var remaining = amount;
    for (var i = 0; i < 8; i++) {
      data[1 + i] = remaining & 0xff;
      remaining = Math.floor(remaining / 256);
    }
    data[9] = decimals;
    return new TransactionInstruction({
      programId: new PublicKey(TOKEN_PROGRAM_ID),
      keys: [
        { pubkey: source, isSigner: false, isWritable: true },
        { pubkey: mint, isSigner: false, isWritable: false },
        { pubkey: destination, isSigner: false, isWritable: true },
        { pubkey: owner, isSigner: true, isWritable: false }
      ],
      data: data
    });
  }

  /** Live SPL balance for (owner, mint), in base units. 0 when no account. */
  async function getTokenBalance(ownerKey, mintKey) {
    try {
      var res = await connection.getTokenAccountBalance(deriveAta(ownerKey, mintKey));
      return Number(res.value.amount);
    } catch (e) {
      // No token account yet is the normal "zero balance" case.
      return 0;
    }
  }

  /** True when an account exists on the current cluster. */
  async function accountExists(pubkey) {
    try {
      var info = await connection.getAccountInfo(pubkey);
      return !!(info && info.data);
    } catch (e) {
      // If we cannot tell, assume it exists: skipping the create instruction
      // fails loudly if we are wrong, whereas adding it unnecessarily makes
      // the payer fund rent the recipient does not need.
      return true;
    }
  }

  /**
   * Insufficient-balance message that names the cluster and, at a zero
   * balance, points at the likely cause — a wallet on a different network.
   */
  function insufficientMessage(balance, unit) {
    var msg = 'Not enough ' + unit + ' on ' + core.networkLabel(NETWORK) +
      '. You have ' + core.solFromLamports(balance) + ' ' + unit + ' available.';
    if (balance === 0) {
      msg += ' Your wallet may be on a different network — switch it to ' +
        core.networkLabel(NETWORK) + ' and reload.';
    }
    return msg;
  }

  /**
   * Why there is no wallet, phrased for the device.
   *
   * On desktop the extension injects window.solana. On a phone no browser
   * injects a wallet, so "install Phantom" is the wrong advice — the user
   * almost certainly HAS Phantom; they just have to open the link inside it.
   * Getting this wrong looks like the button silently doing nothing.
   */
  function noWalletMessage() {
    if (isMobile()) {
      return 'No wallet detected in this browser. On a phone you must open ' +
        'this link inside Phantom: tap the ⋯ menu → "Open in Phantom", or ' +
        'paste the link into Phantom\'s built-in browser.';
    }
    return 'No Solana wallet found. Install the Phantom extension, then reload.';
  }

  /**
   * Build a Phantom `browse` deeplink for the current page.
   *
   * This is the documented way to get a link into the Phantom app on a phone,
   * and it is the ONLY form that helps here. Phantom exposes no transfer
   * deeplink — the supported "other methods" are just `browse` — so there is
   * no way to hand Phantom a pre-filled payment. What we CAN do is open this
   * very PayTag page inside Phantom's in-app browser, where the wallet IS
   * injected, so "Connect Wallet to Pay" then works normally.
   *
   * A bare `solana:` URI is deliberately not used: no mobile browser resolves
   * an unregistered scheme, and the Phantom desktop extension registers no
   * handler either, so it silently does nothing in both places.
   */
  function buildPhantomBrowseLink(pageUrl, ref) {
    if (!pageUrl) return '';
    return 'https://phantom.com/ul/browse/' + encodeURIComponent(pageUrl) +
      '?ref=' + encodeURIComponent(ref || '');
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
          setStatus(status, noWalletMessage(), 'error');
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

      var token = $('tokenSelect').value === 'usdc' ? 'USDC' : 'SOL';
      var amountInput = $('requestAmount').value;
      var amount = core.normalizeAmount(amountInput);

      if (String(amountInput).trim() && !amount) {
        setStatus(status, 'That amount is not a valid number.', 'error');
        $('requestAmount').focus();
        return;
      }
      if (token === 'USDC' && !core.tokenMint('USDC', NETWORK)) {
        setStatus(
          status,
          'USDC is not available on ' + core.networkLabel(NETWORK) +
            ' — this app is on ' + core.networkLabel(NETWORK) +
            ', which has no USDC mint. Use SOL, or switch the app to mainnet.',
          'error'
        );
        return;
      }

      var address = ownerKey.toString();
      var url = core.buildShareUrl(
        window.location.origin + window.location.pathname,
        handle, address, amount, token
      );

      saveTag(handle, address, amount, token);

      $('paytagUrl').textContent = url;
      $('paytagHandle').textContent = '@' + handle;
      show($('paytagResult'), true);
      hideQr();
      setStatus(status, 'PayTag ready.', 'ok');
    });

    var requestInput = $('requestAmount');
    if (requestInput) {
      requestInput.addEventListener('input', function () {
        var hint = $('amountHint');
        if (!hint) return;
        var v = core.normalizeAmount(requestInput.value);
        var unit = $('tokenSelect').value === 'usdc' ? 'USDC' : 'SOL';
        hint.textContent = v
          ? 'The link will ask for ' + v + ' ' + unit + '.'
          : 'Set an amount and the link asks for it, so the payer never types it.';
        hint.className = 'handle-hint';
      });
    }
    var tokenSel = $('tokenSelect');
    if (tokenSel) {
      tokenSel.addEventListener('change', function () {
        if (requestInput) requestInput.dispatchEvent(new Event('input'));
      });
    }

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

    $('qrButton').addEventListener('click', function () {
      var panel = $('qrPanel');
      var btn = this;
      if (!panel.classList.contains('hidden')) {
        hideQr();
        return;
      }
      var target = $('qrTarget');
      var url = $('paytagUrl').textContent;
      if (!target || !url) return;
      // The QR encodes the share LINK, not a solana: URI — a phone camera
      // opens a URL but does nothing with a bare scheme, and the link also
      // carries the handle and amount for whoever scans it.
      target.textContent = '';
      try {
        target.appendChild(window.QR.toDom(document, url, { scale: 4, border: 4 }));
      } catch (e) {
        console.error(e);
        setStatus($('status'), 'Could not draw the QR code: ' + e.message, 'error');
        return;
      }
      show(panel, true);
      btn.textContent = 'Hide QR code';
      btn.setAttribute('aria-expanded', 'true');
    });

    renderSavedTags();
  }

  function hideQr() {
    var panel = $('qrPanel');
    var btn = $('qrButton');
    if (panel) show(panel, false);
    if (btn) {
      btn.textContent = 'Show QR code';
      btn.setAttribute('aria-expanded', 'false');
    }
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

    var token = paytag.token || 'SOL';
    var unit = token === 'USDC' ? 'USDC' : 'SOL';

    // A requested amount is the whole point of an amount-bearing link: show it
    // and prefill the field so the payer never retypes it.
    if (paytag.amount) {
      $('requestedAmountValue').textContent = paytag.amount;
      $('requestedTokenLabel').textContent = unit;
      show($('requestedAmount'), true);
      $('customAmount').value = paytag.amount;
    }

    var unitLabel = $('amountUnitLabel');
    if (unitLabel) unitLabel.textContent = 'Amount (' + unit + ')';
    var sendBtn = $('sendButton');
    if (sendBtn) sendBtn.textContent = 'Send ' + unit;

    // Mobile handoff, MOBILE ONLY.
    //
    // On a phone the wallet lives in the Phantom app, so the useful action is
    // to reopen this page inside Phantom's in-app browser, where the provider
    // IS injected and the normal connect flow works. Phantom exposes no
    // transfer deeplink, so a pre-filled payment cannot be handed over — the
    // browse deeplink is the documented mechanism and it is what we use.
    //
    // On desktop this is not offered at all: the extension is already injected
    // into the page, so there is nothing to hand off, and a scheme-based link
    // would silently do nothing.
    var walletLink = $('openWalletLink');
    var hint = $('walletHint');
    var browseLink = isMobile()
      ? buildPhantomBrowseLink(window.location.href, window.location.origin)
      : '';
    if (browseLink && walletLink) {
      walletLink.href = browseLink;
      walletLink.textContent = 'Open in Phantom';
      show(walletLink, true);
      if (hint) {
        hint.textContent =
          'Opens this page inside Phantom, where you can pay with your wallet.';
        show(hint, true);
      }
    } else {
      show(walletLink, false);
      if (hint) show(hint, false);
    }

    // No wallet detected: explain the real path instead of offering a button
    // that cannot work. PayTag cannot create funds — only a wallet can hold and
    // send them — so pretending otherwise would be a lie.
    if (!getWallet()) {
      show($('noWalletHelp'), true);
      $('noWalletAddress').textContent =
        'Address to pay: ' + paytag.address;
    }

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
        show($('noWalletHelp'), false);
        show($('paymentForm'), true);
        setStatus(status, '');
        $('customAmount').focus();
      } catch (e) {
        btn.disabled = false;
        if (e && e.message === 'NO_WALLET') {
          setStatus(status, noWalletMessage(), 'error');
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
    var token = (paytag && paytag.token) || 'SOL';
    var info = core.tokenInfo(token) || core.tokenInfo('SOL');
    var unit = info.symbol;
    var rawAmount = $('customAmount').value;

    var baseUnits = core.baseUnitsFromAmount(rawAmount, info.decimals);
    if (!baseUnits) {
      setStatus(status, 'Enter an amount greater than zero.', 'error');
      return;
    }

    var wallet = getWallet();
    if (!wallet || !payerKey) {
      setStatus(status, 'Connect your wallet first.', 'error');
      return;
    }

    var display = core.amountFromBaseUnits(baseUnits, info.decimals) + ' ' + unit;

    if (core.isLiveNetwork(NETWORK)) {
      var proceed = window.confirm(
        'About to send ' + display + ' on MAINNET to\n' +
          paytag.address + '\n\nMainnet transactions cannot be reversed. Continue?'
      );
      if (!proceed) return;
    }

    btn.disabled = true;
    btn.setAttribute('aria-busy', 'true');
    var originalLabel = btn.textContent;

    try {
      var transaction = new Transaction();

      if (info.native) {
        setStatus(status, 'Checking balance…');
        var balance = await connection.getBalance(payerKey);
        if (baseUnits + FEE_BUFFER_LAMPORTS > balance) {
          setStatus(status, insufficientMessage(balance, 'SOL'), 'error');
          return;
        }
        transaction.add(
          SystemProgram.transfer({
            fromPubkey: payerKey,
            toPubkey: new PublicKey(paytag.address),
            lamports: baseUnits
          })
        );
      } else {
        // SPL path: the token lives in a derived account, and the recipient may
        // not have one yet. Creating it costs a little rent that the SENDER
        // pays and cannot recover, so it is only added when it is missing —
        // never unconditionally.
        var mintAddress = core.tokenMint(info.symbol, NETWORK);
        if (!mintAddress) {
          setStatus(
            status,
            unit + ' is not available on ' + core.networkLabel(NETWORK) + '.',
            'error'
          );
          return;
        }
        var mintKey = new PublicKey(mintAddress);
        var recipientKey = new PublicKey(paytag.address);

        setStatus(status, 'Checking balance…');
        var tokenBalance = await getTokenBalance(payerKey, mintKey);
        if (baseUnits > tokenBalance) {
          setStatus(
            status,
            'Not enough ' + unit + ' on ' + core.networkLabel(NETWORK) +
              '. You have ' + core.amountFromBaseUnits(tokenBalance, info.decimals) +
              ' ' + unit + ' available.' +
              (tokenBalance === 0
                ? ' Your wallet may be on a different network, or may not hold ' +
                  unit + ' yet.'
                : ''),
            'error'
          );
          return;
        }

        setStatus(status, 'Preparing transaction…');
        var sourceAta = deriveAta(payerKey, mintKey);
        var destAta = deriveAta(recipientKey, mintKey);

        var destExists = await accountExists(destAta);
        if (!destExists) {
          transaction.add(
            createAtaInstruction(payerKey, destAta, recipientKey, mintKey)
          );
        }
        transaction.add(
          transferCheckedInstruction(
            sourceAta, mintKey, destAta, payerKey, baseUnits, info.decimals
          )
        );
      }

      // web3.js 1.98.x still uses these property assignments.
      var latest = await connection.getLatestBlockhash();
      transaction.recentBlockhash = latest.blockhash;
      transaction.feePayer = payerKey;

      // Preflight with our OWN devnet RPC before handing anything to the
      // wallet. Phantom's devnet simulator is known to report "transaction
      // reverted during simulation" for transactions that are in fact fine
      // (it uses the mainnet simulator against a devnet transaction), so
      // trusting it alone produces false failures and a scary red warning.
      // Simulating here means we either catch a REAL error with the program's
      // own log line, or we can tell the user the transaction is valid.
      setStatus(status, 'Checking the transaction…');
      var preflight = await simulateSafely(transaction);
      if (preflight && preflight.err) {
        setStatus(
          status,
          'This payment would fail on-chain, so it was not sent: ' +
            preflight.reason,
          'error'
        );
        return;
      }

      setStatus(status, 'Approve in your wallet…');
      var signed = await wallet.signTransaction(transaction);

      setStatus(status, 'Sending…');
      var signature = await connection.sendRawTransaction(signed.serialize());

      var explorer = {
        href: core.explorerTxUrl(signature, NETWORK),
        label: 'View transaction'
      };

      setStatus(status, 'Waiting for confirmation…');

      // Bounded wait. If it has not confirmed in time we say so plainly and
      // hand back the signature + explorer link — never "failed", because we
      // do not actually know that, and the transfer may well have landed.
      var outcome = await confirmWithTimeout(signature, CONFIRM_TIMEOUT_MS);

      if (outcome === 'confirmed') {
        renderStatus(status, 'Payment sent — ' + display + '.', explorer);
      } else if (outcome === 'failed') {
        setStatus(
          status,
          'The network rejected this payment, so nothing was sent. Check the ' +
            'details, then try again.',
          'error'
        );
      } else {
        renderStatus(
          status,
          'Sent, but not confirmed yet. This usually just means the network is ' +
            'slow — your ' + unit + ' has NOT been lost. Check the transaction ' +
            'before retrying:',
          explorer
        );
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

  /**
   * Simulate a transaction with our own RPC and turn the result into a
   * readable reason. Never throws.
    *
    * Why this exists: Phantom's simulator is unreliable on devnet — it reports
    * "transaction reverted during simulation" for transactions that execute
    * perfectly, because it simulates against the wrong cluster. A false failure
    * there is indistinguishable from a real one in the UI, so the app checks
    * for itself and can tell the user which it is.
    */
   async function simulateSafely(transaction) {
     try {
       var sim = await connection.simulateTransaction(transaction);
       if (!sim || !sim.value || !sim.value.err) return { err: null };

       // Surface the program's own error text when there is one — "custom
       // program error: 0x1" is useless on its own.
       var logs = sim.value.logs || [];
       var detail = '';
       for (var i = logs.length - 1; i >= 0; i--) {
         if (/Error|failed|insufficient/i.test(logs[i])) { detail = logs[i]; break; }
       }
       return {
         err: sim.value.err,
         reason: detail || JSON.stringify(sim.value.err)
       };
     } catch (e) {
       // A preflight we cannot run must NOT block a payment that might be fine.
       return { err: null, skipped: true };
     }
   }

   /**
    * Promise.race between confirmation and a timeout. Never rejects.
    *
    * Three outcomes, not two:
   *   'confirmed'    the cluster confirmed it
   *   'failed'       the cluster confirmed it with an error
   *   'unconfirmed'  the wait ran out, or the confirmation call errored, so we
   *                  genuinely do not know. Callers must not treat this as a
   *                  failure — the transaction may still land.
   */
  function confirmWithTimeout(signature, ms) {
    var timeoutId;
    var timeoutPromise = new Promise(function (resolve) {
      timeoutId = window.setTimeout(function () {
        resolve('unconfirmed');
      }, ms);
    });
    return Promise.race([
      connection
        .confirmTransaction(signature, 'confirmed')
        .then(function (res) {
          window.clearTimeout(timeoutId);
          if (!res || !res.value) return 'unconfirmed';
          return res.value.err ? 'failed' : 'confirmed';
        })
        .catch(function () {
          window.clearTimeout(timeoutId);
          return 'unconfirmed';
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
      // Owner view. The payer-only blocks live inside paymentSection and are
      // hidden with it, but hide them explicitly too so nothing can leak if a
      // future change shows that section for another reason.
      show($('requestedAmount'), false);
      show($('noWalletHelp'), false);
      show($('openWalletLink'), false);
      initOwner();
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();