/*
 * PayTag core logic
 * ------------------
 * Pure, dependency-free helpers shared by the app and the test suite.
 *
 * This file deliberately has NO DOM and NO wallet dependency so it can run
 * unchanged in a browser (as window.PayTagCore) and in Node (for tests).
 * That is what lets PayTag ship with real tests and still stay zero-build.
 */
(function (root, factory) {
  'use strict';
  var api = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = api;            // Node / test runner
  } else {
    root.PayTagCore = api;           // browser global
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var LAMPORTS_PER_SOL = 1000000000;

  /* Query-parameter names used in a shareable PayTag link. */
  var PARAM_HANDLE = 'tag';
  var PARAM_ADDRESS = 'to';

  /* legacy aliases kept working so previously shared links do not break */
  var LEGACY = { handle: 'user', address: 'wallet' };

  var HANDLE_MAX = 20;
  var HANDLE_MIN = 3;
  var HANDLE_RE = /^[a-z0-9](?:[a-z0-9_-]*[a-z0-9])?$/;

  /* Base58 alphabet used by Solana addresses (no 0, O, I, l). */
  var BASE58_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

  var EXPLORER = {
    'mainnet-beta': 'https://explorer.solana.com',
    devnet: 'https://explorer.solana.com/?cluster=devnet',
    testnet: 'https://explorer.solana.com/?cluster=testnet'
  };

  // ── handles ───────────────────────────────────────────────────────────────

  /**
   * Lowercase and strip anything that is not a valid handle character.
   * Returns '' when nothing usable remains.
   */
  function normalizeHandle(input) {
    if (typeof input !== 'string') return '';
    return input
      .trim()
      .toLowerCase()
      .replace(/^@+/, '')
      .replace(/[^a-z0-9_-]/g, '');
  }

  /**
   * Validate an ALREADY-normalized handle.
   * Returns null when valid, otherwise a human-readable reason.
   */
  function handleProblem(handle) {
    if (!handle) return 'Enter a PayTag name.';
    if (handle.length < HANDLE_MIN) {
      return 'Use at least ' + HANDLE_MIN + ' characters.';
    }
    if (handle.length > HANDLE_MAX) {
      return 'Use ' + HANDLE_MAX + ' characters or fewer.';
    }
    if (!HANDLE_RE.test(handle)) {
      return 'Start with a letter or number, and use letters, numbers, "-" or "_".';
    }
    return null;
  }

  function isValidHandle(handle) {
    return handleProblem(handle) === null;
  }

  // ── money ─────────────────────────────────────────────────────────────────

  /**
   * SOL -> lamports. Rejects NaN, negatives, zero, and absurd values.
   * Returns an integer, or null when the input is not usable.
   */
  function lamportsFromSol(amount) {
    var n = typeof amount === 'number' ? amount : parseFloat(amount);
    if (!isFinite(n) || n <= 0) return null;
    if (n > 1e9) return null;              // far beyond any plausible payment
    var lamports = Math.round(n * LAMPORTS_PER_SOL);
    return lamports > 0 ? lamports : null;
  }

  /** lamports -> SOL string, trimmed to 9 decimals. */
  function solFromLamports(lamports) {
    var n = typeof lamports === 'number' ? lamports : parseFloat(lamports);
    if (!isFinite(n) || n < 0) return '0';
    return (n / LAMPORTS_PER_SOL).toFixed(9).replace(/0+$/, '').replace(/\.$/, '');
  }

  // ── addresses ─────────────────────────────────────────────────────────────

  /**
   * Cheap sanity check for a Solana address (base58, 32-44 chars).
   * This is a UI guard, not a substitute for web3.js PublicKey validation.
   */
  function looksLikeAddress(value) {
    return typeof value === 'string' && BASE58_RE.test(value.trim());
  }

  /** '7xKX…gAsU' for display. */
  function truncateAddress(address, head, tail) {
    if (typeof address !== 'string') return '';
    var a = address.trim();
    head = head || 4;
    tail = tail || 4;
    if (a.length <= head + tail + 1) return a;
    return a.slice(0, head) + '…' + a.slice(-tail);
  }

  // ── PayTag links ──────────────────────────────────────────────────────────

  /**
   * Parse a PayTag share link.
   *
   * Accepts both the current param names and the legacy ones so links that
   * were already shared keep working. Rejects a missing or malformed address
   * with an explicit reason instead of failing later inside the send flow.
   *
   * @returns {{ok: true, handle: string, address: string}
   *          |{ok: false, reason: string}}
   */
  function parsePayTag(search) {
    try {
      /* validated via URLSearchParams inside validatePayTagParts */
      return validatePayTagParts(
        new URLSearchParams(search || '').get(PARAM_HANDLE) ||
          new URLSearchParams(search || '').get(LEGACY.handle),
        new URLSearchParams(search || '').get(PARAM_ADDRESS) ||
          new URLSearchParams(search || '').get(LEGACY.address)
      );
    } catch (e) {
      return { ok: false, reason: 'That PayTag link could not be read.' };
    }
  }

  /**
   * Build the shareable PayTag URL.
   *
   * Canonical form is query-string based (?tag=alice&to=ADDR) on purpose: it
   * works on any static host, including plain GitHub Pages and file://, with
   * no SPA fallback / 404 rewrite required. The prettier /alice path form is
   * still accepted on read (see parsePayTagFromLocation) for anyone who
   * shares it.
   */
  function buildShareUrl(origin, handle, address) {
    var h = normalizeHandle(handle);
    var a = String(address || '').trim();
    var base = String(origin || '').replace(/\/+$/, '');
    var qs = PARAM_ADDRESS + '=' + encodeURIComponent(a);
    if (h) qs = PARAM_HANDLE + '=' + encodeURIComponent(h) + '&' + qs;
    return base + '/?' + qs;
  }

  /**
   * Parse a PayTag from a full location, supporting BOTH the canonical
   * query-string form and the optional /handle path form.
   *
   * @param {string} pathname e.g. '/alice'
   * @param {string} search    e.g. '?to=ADDR'
   */
  function parsePayTagFromLocation(pathname, search) {
    var handleFromPath = '';
    var p = String(pathname || '');
    // only the first segment, and only if it is not the site root
    var m = p.match(/^\/([^/?#]+)\/?$/);
    if (m && m[1] && m[1].toLowerCase() !== 'index.html') {
      handleFromPath = decodeURIComponent(m[1]);
    }

    var params = new URLSearchParams(search || '');
    var handle = params.get(PARAM_HANDLE) || params.get(LEGACY.handle) || handleFromPath || '';
    var address = params.get(PARAM_ADDRESS) || params.get(LEGACY.address) || '';

    return validatePayTagParts(handle, address);
  }

  function validatePayTagParts(rawHandle, rawAddress) {
    var handle = normalizeHandle(rawHandle);
    var address = typeof rawAddress === 'string' ? rawAddress.trim() : '';

    if (!handle && !address) return { ok: false, reason: 'empty' };
    if (!address) {
      return { ok: false, reason: 'This PayTag link is missing a destination address.' };
    }
    if (!looksLikeAddress(address)) {
      return { ok: false, reason: 'This PayTag link has an invalid Solana address.' };
    }
    return { ok: true, handle: handle, address: address };
  }

  /** Explorer link for a transaction signature on the given cluster. */
  function explorerTxUrl(signature, network) {
    var base = EXPLORER[network] || EXPLORER.devnet;
    return base + '/tx/' + encodeURIComponent(signature);
  }

  function explorerAddressUrl(address, network) {
    var base = EXPLORER[network] || EXPLORER.devnet;
    return base + '/address/' + encodeURIComponent(address);
  }

  /** Friendly cluster label for the badge. */
  function networkLabel(network) {
    if (network === 'mainnet-beta') return 'Mainnet';
    if (network === 'testnet') return 'Testnet';
    if (network === 'devnet') return 'Devnet';
    return String(network || 'unknown');
  }

  /** Networks that carry real value — used to gate destructive actions. */
  function isLiveNetwork(network) {
    return network === 'mainnet-beta';
  }

  return {
    LAMPORTS_PER_SOL: LAMPORTS_PER_SOL,
    PARAM_HANDLE: PARAM_HANDLE,
    PARAM_ADDRESS: PARAM_ADDRESS,
    HANDLE_MIN: HANDLE_MIN,
    HANDLE_MAX: HANDLE_MAX,
    normalizeHandle: normalizeHandle,
    handleProblem: handleProblem,
    isValidHandle: isValidHandle,
    lamportsFromSol: lamportsFromSol,
    solFromLamports: solFromLamports,
    looksLikeAddress: looksLikeAddress,
    truncateAddress: truncateAddress,
    parsePayTag: parsePayTag,
    parsePayTagFromLocation: parsePayTagFromLocation,
    buildShareUrl: buildShareUrl,
    explorerTxUrl: explorerTxUrl,
    explorerAddressUrl: explorerAddressUrl,
    networkLabel: networkLabel,
    isLiveNetwork: isLiveNetwork
  };
});