// Inspect the devnet transactions for a given address.
const RPC = 'https://api.devnet.solana.com';
const ADDR = process.argv[2];

async function rpc(method, params) {
  const r = await fetch(RPC, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params })
  });
  return r.json();
}

const LAMPORTS = 1e9;
const sol = (l) => (l / LAMPORTS).toFixed(9).replace(/0+$/, '').replace(/\.$/, '');

(async () => {
  const sigs = await rpc('getSignaturesForAddress', [ADDR, { limit: 25 }]);
  if (sigs.error) { console.error(sigs.error); process.exit(1); }

  console.log(`Found ${sigs.result.length} signature(s) for ${ADDR}\n`);

  for (const s of sigs.result) {
    const tx = await rpc('getTransaction', [
      s.signature,
      { encoding: 'jsonParsed', maxSupportedTransactionVersion: 0 }
    ]);
    if (tx.error || !tx.result) {
      console.log(`--- ${s.signature}\n    (unavailable: ${JSON.stringify(tx.error)})`);
      continue;
    }
    const t = tx.result;
    const msg = t.transaction.message;
    const keys = msg.accountKeys.map((k) => (typeof k === 'string' ? k : k.pubkey));
    const when = s.blockTime ? new Date(s.blockTime * 1000).toISOString() : 'unknown time';

    console.log(`--- ${s.signature}`);
    console.log(`    slot ${s.slot}   ${when}   err=${JSON.stringify(s.err)}`);

    // Solana native transfers show up in the parsed instructions.
    const ixs = [];
    for (const ix of msg.instructions) {
      ixs.push(ix);
    }
    // also look at inner instructions
    for (const inner of t.meta.innerInstructions || []) {
      for (const ix of inner.instructions) ixs.push(ix);
    }

    let found = false;
    for (const ix of ixs) {
      const p = ix.parsed;
      if (p && p.type === 'transfer' && p.info && p.info.lamports !== undefined) {
        found = true;
        console.log(`    TRANSFER ${sol(p.info.lamports)} SOL`);
        console.log(`      from ${p.info.source}`);
        console.log(`      to   ${p.info.destination}`);
      }
    }
    if (!found) {
      console.log(`    (no parsed SOL transfer; program=${msg.instructions.map(i=>i.program).join(',')})`);
    }

    // Balance deltas are the ground truth.
    const pre = t.meta.preBalances, post = t.meta.postBalances;
    for (let i = 0; i < keys.length; i++) {
      const d = post[i] - pre[i];
      if (d !== 0) {
        const tag = keys[i] === ADDR ? '  <-- YOUR ADDRESS' : '';
        console.log(`    delta ${d > 0 ? '+' : ''}${sol(d)} SOL  ${keys[i]}${tag}`);
      }
    }
    console.log(`    fee ${sol(t.meta.fee)} SOL   status ${t.meta.err ? 'FAILED' : 'SUCCESS'}`);
    console.log('');
  }
})();
