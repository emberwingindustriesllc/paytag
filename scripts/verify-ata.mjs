// Verify ATA derivation against the real on-chain token account, using the
// ACTUAL web3.js bundle the browser loads (not a stub).
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';

const BUNDLE = process.argv[2];
const RPC = 'https://api.devnet.solana.com';
const USDC_DEVNET = '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU';
const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const ATA_PROGRAM = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL';
const OWNER = '5y5Peuhq2FvYCC4WLVKM6tirDSRJ4KHa4oACaFb6Xp3d';

async function rpc(method, params) {
  const r = await fetch(RPC, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params })
  });
  return r.json();
}

(async () => {
  // 1. The REAL token account address, straight from the chain.
  const accts = await rpc('getTokenAccountsByOwner', [
    OWNER, { mint: USDC_DEVNET }, { encoding: 'jsonParsed' }
  ]);
  if (accts.error) { console.log('rpc error', accts.error); return; }
  const real = accts.result.value.map((a) => a.pubkey);
  console.log('ON-CHAIN USDC token account(s) for the owner:');
  real.forEach((a) => console.log('  ' + a));

  // 2. Load the real web3.js IIFE bundle the browser uses.
  const src = fs.readFileSync(BUNDLE, 'utf8');
  const sandbox = { console, setTimeout, clearTimeout, TextEncoder, TextDecoder, Buffer,
                    fetch, AbortController, URL, URLSearchParams, Promise, Math, Date, JSON };
  sandbox.self = sandbox;
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox, { filename: 'web3.iife.min.js' });

  const web3 = sandbox.solanaWeb3;
  if (!web3) { console.log('no solanaWeb3 global; keys:', Object.keys(sandbox).slice(0, 40)); return; }
  console.log('\nbundle exposes PublicKey.findProgramAddressSync:', typeof web3.PublicKey.findProgramAddressSync);

  // 3. Derive the ATA exactly the way app.js does.
  const owner = new web3.PublicKey(OWNER);
  const tokenProgram = new web3.PublicKey(TOKEN_PROGRAM);
  const ataProgram = new web3.PublicKey(ATA_PROGRAM);
  const mint = new web3.PublicKey(USDC_DEVNET);

  const found = web3.PublicKey.findProgramAddressSync(
    [owner.toBuffer(), tokenProgram.toBuffer(), mint.toBuffer()],
    ataProgram
  );
  const derived = found[0].toString();

  console.log('\nDERIVED (app.js seeds):', derived);
  console.log('MATCHES CHAIN        :', real.includes(derived) ? 'YES' : 'NO  <-- BUG HERE');

  // 4. Sanity: does the derived account exist and hold the balance?
  const bal = await rpc('getTokenAccountBalance', [derived]);
  console.log('\ngetTokenAccountBalance(derived):', JSON.stringify(bal.result || bal.error));

  // 5. Also check owner.toBuffer() really is 32 bytes (a wrong-length seed
  //    silently derives a different address).
  console.log('\nowner.toBuffer().length :', owner.toBuffer().length);
  console.log('mint.toBuffer().length  :', mint.toBuffer().length);
})();
