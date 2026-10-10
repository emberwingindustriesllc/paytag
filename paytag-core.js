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
  var PARAM_AMOUNT = 'amount';
  var PARAM_TOKEN = 'token';

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

  /*
   * Supported tokens.
   *
   * USDC here is the SPL token Circle issues natively ON SOLANA — not an
   * Ethereum asset and not a bridge. Everything stays on one chain. Each
   * cluster has its own mint, so the mint must be selected by cluster; a
   * mainnet mint referenced on devnet simply does not exist.
   *
   * Decimals matter: SOL has 9, USDC has 6. Getting that wrong is a 1000x
   * error in the amount, so the value is data, not a magic number.
   */
  var TOKENS = {
    SOL: {
      symbol: 'SOL',
      name: 'Solana',
      decimals: 9,
      native: true,
      mints: {}
    },
    USDC: {
      symbol: 'USDC',
      name: 'USD Coin',
      decimals: 6,
      native: false,
      mints: {
        'mainnet-beta': 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
        devnet: '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU'
      }
    }
  };

  /** The token record for a symbol, or null. Case-insensitive. */
  function tokenInfo(symbol) {
    var key = String(symbol || '').trim().toUpperCase();
    return TOKENS[key] || null;
  }

  /** Mint address for a token on a cluster, or '' when unsupported there. */
  function tokenMint(symbol, network) {
    var t = tokenInfo(symbol);
    if (!t || t.native) return '';
    return t.mints[network] || '';
  }

  /**
   * Amount (human units) -> base units for a token, or null when unusable.
   * Uses string maths on the decimal expansion so 0.1 USDC never becomes
   * 0.09999999 through floating point.
   */
  function baseUnitsFromAmount(amount, decimals) {
    var n = typeof amount === 'number' ? String(amount) : String(amount || '').trim();
    if (!n || !/^\d*\.?\d*$/.test(n)) return null;
    var parts = n.split('.');
    var whole = parts[0] || '0';
    var frac = (parts[1] || '').slice(0, decimals);
    while (frac.length < decimals) frac += '0';
    var digits = (whole + frac).replace(/^0+/, '');
    if (!digits) return null;
    var value = Number(digits);
    if (!isFinite(value) || value <= 0) return null;
    return value;
  }

  /** base units -> human string, trimmed of trailing zeros. */
  function amountFromBaseUnits(units, decimals) {
    var n = typeof units === 'number' ? units : parseFloat(units);
    if (!isFinite(n) || n < 0) return '0';
    var s = n.toFixed(0).padStart(decimals + 1, '0');
    var whole = s.slice(0, s.length - decimals) || '0';
    var frac = s.slice(s.length - decimals).replace(/0+$/, '');
    return frac ? whole + '.' + frac : whole;
  }

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

  /**
   * Normalise an amount that arrived in a link, or was typed by a user.
   *
   * Returns a plain decimal string ('4', '0.25') or '' when the value is
   * absent or unusable. Callers must treat '' as "no amount requested" — the
   * point is that a malformed amount can never reach the send path as NaN.
   */
  function normalizeAmount(value) {
    if (value === null || value === undefined || value === '') return '';
    var lamports = lamportsFromSol(value);
    return lamports === null ? '' : solFromLamports(lamports);
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
      var params = new URLSearchParams(search || '');
      return validatePayTagParts(
        params.get(PARAM_HANDLE) || params.get(LEGACY.handle),
        params.get(PARAM_ADDRESS) || params.get(LEGACY.address),
        params.get(PARAM_AMOUNT),
        params.get(PARAM_TOKEN)
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
  function buildShareUrl(origin, handle, address, amount, token) {
    var h = normalizeHandle(handle);
    var a = String(address || '').trim();
    var amt = normalizeAmount(amount);
    var tok = normalizeTokenSymbol(token);
    var base = String(origin || '').replace(/\/+$/, '');
    var qs = PARAM_ADDRESS + '=' + encodeURIComponent(a);
    if (h) qs = PARAM_HANDLE + '=' + encodeURIComponent(h) + '&' + qs;
    // Amount and token are appended only when present, so a plain link keeps
    // its original byte-for-byte form.
    if (amt) qs += '&' + PARAM_AMOUNT + '=' + encodeURIComponent(amt);
    if (tok) qs += '&' + PARAM_TOKEN + '=' + encodeURIComponent(tok);
    return base + '/?' + qs;
  }

  /** Canonical token symbol, or '' for the default (SOL). */
  function normalizeTokenSymbol(symbol) {
    var t = tokenInfo(symbol);
    if (!t) return '';
    return t.symbol === 'SOL' ? '' : t.symbol;
  }

  /**
   * Parse a PayTag from a full location.
   *
   * Supports the canonical query-string form (?tag=alice&to=ADDR) and the
   * optional /alice?to=ADDR path form.
   *
   * IMPORTANT: the path form is only honoured when an actual destination
   * address is present. A site deployed under a sub-path (GitHub Pages serves
   * this one at /paytag/) would otherwise have its OWN deployment prefix
   * mistaken for a handle, which broke the bare root URL.
   * A handle with no address cannot be paid anyway, so nothing is lost.
   *
   * @param {string} pathname e.g. '/alice'
   * @param {string} search    e.g. '?to=ADDR'
   */
  function parsePayTagFromLocation(pathname, search) {
    var params = new URLSearchParams(search || '');
    var address = params.get(PARAM_ADDRESS) || params.get(LEGACY.address) || '';
    var queryHandle = params.get(PARAM_HANDLE) || params.get(LEGACY.handle) || '';

    // Only look at the path when the URL actually carries an address.
    var handle = queryHandle;
    if (address && !handle) {
      var p = String(pathname || '');
      var m = p.match(/^\/([^/?#]+)\/?$/);
      if (m && m[1] && m[1].toLowerCase() !== 'index.html') {
        handle = decodeURIComponent(m[1]);
      }
    }

    return validatePayTagParts(handle, address, params.get(PARAM_AMOUNT),
      params.get(PARAM_TOKEN));
  }

  function validatePayTagParts(rawHandle, rawAddress, rawAmount, rawToken) {
    var handle = normalizeHandle(rawHandle);
    var address = typeof rawAddress === 'string' ? rawAddress.trim() : '';
    var amount = normalizeAmount(rawAmount);
    var token = normalizeTokenSymbol(rawToken) || 'SOL';

    if (!handle && !address) return { ok: false, reason: 'empty' };
    if (!address) {
      return { ok: false, reason: 'This PayTag link is missing a destination address.' };
    }
    if (!looksLikeAddress(address)) {
      return { ok: false, reason: 'This PayTag link has an invalid Solana address.' };
    }
    // A bad amount or token is DROPPED rather than fatal: the link is still
    // payable, and the payer simply gets to choose. Anything else would turn a
    // typo in an optional parameter into an unusable link.
    return { ok: true, handle: handle, address: address, amount: amount, token: token };
  }

  /**
   * Build a Solana Pay transfer-request URI (the `solana:` scheme).
   *
   * This is the wallet-native path: a wallet that has registered the scheme
   * opens with the recipient and amount already filled in, so paying is one
   * tap instead of a web page plus a hand-typed amount. The web page remains
   * the fallback for anyone whose browser has no handler — which is the whole
   * reason PayTag still exists alongside the standard.
   *
   * Returns '' when the address is unusable, so callers can fall back cleanly.
   */
  function buildSolanaPayUrl(address, amount, label, token, network) {
    var a = typeof address === 'string' ? address.trim() : '';
    if (!looksLikeAddress(a)) return '';
    var parts = [];
    var amt = normalizeAmount(amount);
    if (amt) parts.push('amount=' + encodeURIComponent(amt));
    // SPL tokens are identified by MINT in the standard, not by symbol, and the
    // mint differs per cluster — so a USDC request on devnet must carry the
    // devnet mint or the wallet will look for a token that does not exist.
    var mint = tokenMint(token, network);
    if (mint) parts.push('spl-token=' + encodeURIComponent(mint));
    var lbl = normalizeHandle(label);
    if (lbl) parts.push('label=' + encodeURIComponent('@' + lbl));
    return 'solana:' + a + (parts.length ? '?' + parts.join('&') : '');
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
    PARAM_AMOUNT: PARAM_AMOUNT,
    PARAM_TOKEN: PARAM_TOKEN,
    TOKENS: TOKENS,
    tokenInfo: tokenInfo,
    tokenMint: tokenMint,
    normalizeTokenSymbol: normalizeTokenSymbol,
    baseUnitsFromAmount: baseUnitsFromAmount,
    amountFromBaseUnits: amountFromBaseUnits,
    HANDLE_MIN: HANDLE_MIN,
    HANDLE_MAX: HANDLE_MAX,
    normalizeHandle: normalizeHandle,
    handleProblem: handleProblem,
    isValidHandle: isValidHandle,
    lamportsFromSol: lamportsFromSol,
    solFromLamports: solFromLamports,
    normalizeAmount: normalizeAmount,
    looksLikeAddress: looksLikeAddress,
    truncateAddress: truncateAddress,
    parsePayTag: parsePayTag,
    parsePayTagFromLocation: parsePayTagFromLocation,
    buildShareUrl: buildShareUrl,
    buildSolanaPayUrl: buildSolanaPayUrl,
    explorerTxUrl: explorerTxUrl,
    explorerAddressUrl: explorerAddressUrl,
    networkLabel: networkLabel,
    isLiveNetwork: isLiveNetwork
  };
});