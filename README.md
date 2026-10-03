# PayTag

**Pay anyone, anywhere.** Create a shareable link and get paid in SOL.

PayTag is a zero-backend Solana payment link. There is no account, no server,
and no database — a PayTag *is* a URL that carries the destination address.

```text
https://emberwingindustriesllc.github.io/paytag/?tag=yourname&to=YOUR_SOLANA_ADDRESS
```

Share it anywhere. Anyone who opens it can pay you. Nothing to host, nothing to
maintain, nothing to sign up for.

---

## Quick start

```bash
git clone https://github.com/emberwingindustriesllc/paytag.git
cd paytag
npm start            # http://localhost:4321
```

There is no build step and no runtime dependencies. `npm install` is not needed
to run or test the app.

```bash
npm test             # unit tests (node:test)
npm run lint         # structural + safety checks
npm run check        # both
```

## How it works

| Step | What happens |
|------|--------------|
| 1 | You connect a Solana wallet (Phantom or any injected Solana wallet) |
| 2 | You pick a handle — `@alice` |
| 3 | PayTag generates a link containing your handle and your wallet address |
| 4 | You share the link; saved locally so you can re-share without reconnecting |
| 5 | Someone opens it, connects their own wallet, picks an amount, and signs |

The handle is a **display label, not a registry entry.** Two people can both be
`@alice`; the address in the link is what actually receives the payment. That is
the trade for having no backend — and it means a PayTag link can never break,
because there is nothing to break.

## Repository layout

```text
index.html            markup, no inline script
style.css             styling, light + dark, no framework
paytag-core.js        PURE logic: handles, amounts, link parsing  (unit tested)
app.js                DOM + wallet wiring
test/core.test.js     unit tests for paytag-core.js
scripts/serve.js      zero-dependency dev server
scripts/lint.js       structural + XSS + id-wiring checks
404.html              Pages fallback for the /handle link form
```

`paytag-core.js` has no DOM and no wallet dependency, which is what lets the
real logic be unit tested while the app still ships with no build step.

## Switching networks

The cluster lives in one place, at the top of `app.js`:

```js
var NETWORK = 'devnet'; // 'devnet' | 'testnet' | 'mainnet-beta'
```

The on-screen network badge is written from that constant, so the badge can
never contradict the cluster the app is actually using.

**Before going to mainnet, read the checklist below.** Getting devnet and
mainnet confused is the single most expensive mistake possible in this app.

### Mainnet go-live checklist

- [ ] `NETWORK = 'mainnet-beta'` in `app.js`
- [ ] Badge renders red with the text `Mainnet` (driven automatically)
- [ ] Send a real transaction to a wallet you control and confirm it on the
      explorer — verify the address on the explorer matches, do not trust the UI
- [ ] Confirm the confirm-dialog appears on send (it triggers only on mainnet)
- [ ] Re-read [Security notes](#security-notes)

## Security notes

This app moves money. Treat it accordingly.

- **Verify the address, not the handle.** Anyone can create a PayTag called
  `@alice`. Always confirm the destination address before signing.
- **The link is public.** Anyone with a PayTag URL knows the address and handle.
- **No `innerHTML` with external data.** Link parameters are attacker-controlled,
  so everything derived from them goes into the DOM via `textContent` or
  `createElement`. `npm run lint` fails the build if an `innerHTML` assignment
  appears.
- **Network mismatches are surfaced, not assumed.** PayTag requests the right
  cluster from the wallet, probes that the wallet is actually reachable on it,
  and refuses to proceed with a clear message if not.
- **Mainnet sends get an explicit confirmation** showing the full destination
  address and amount before signing.
- **Balance is checked before sending**, so a transfer that cannot cover its own
  fee fails with a clear message instead of an opaque wallet error.
- **Confirmation waits are bounded.** If a transaction does not confirm within
  45 seconds you are given the signature and an explorer link rather than an
  endless spinner.
- **Saved PayTags never leave the device** — they are stored in `localStorage`.
- **Third-party code.** `web3.js` is loaded from unpkg and pinned to `1.98.4`.
  For a payments app you should consider self-hosting that dependency so your
  supply chain is entirely yours.
- This software is provided as-is with no warranty. It has not been audited.

## Dependencies

Runtime, loaded in the browser:

- [`@solana/web3.js@1.98.4`](https://unpkg.com/@solana/web3.js@1.98.4/lib/index.iife.min.js)

Nothing else. No bundler, no framework, no npm runtime dependencies.

> **Note for maintainers:** web3.js 1.98.x still requires
> `transaction.recentBlockhash = …` and `transaction.feePayer = …`.
> `setRecentBlockhash()` / `setFeePayer()` **do not exist** in that version.
> Verified against the installed package — do not "modernise" this.

## Deploying

Pushes to `main` deploy automatically via GitHub Actions
(`.github/workflows/pages.yml`) to:

```text
https://emberwingindustriesllc.github.io/paytag/
```

Set **Settings → Pages → Source** to **GitHub Actions** if it is not already.

## Legacy links

Links in the old `?user=…&wallet=…` format keep working. New links use
`?tag=…&to=…`. The shorter `/handle?to=…` path form is accepted on read and
redirected by `404.html`.

## License

MIT — see [LICENSE](LICENSE).

Copyright © 2026 EmberWing Industries LLC.