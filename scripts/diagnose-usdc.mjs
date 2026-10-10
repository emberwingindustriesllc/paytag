// Diagnose why a devnet USDC transfer would fail.
const RPC = 'https://api.devnet.solana.com';
const USDC_DEVNET = '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU';
const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';

const PAYER = '5y5Peuhq2FvYCC4WLVKM6tirDSRJ4KHa4oACaFb6Xp3d';   // Paul
const WIFE  = '5Uw4H6Bs6Bp7AAVCywVsMNequrmgfU79tZCu9sGk8iyY';   // recipient of the 4 SOL

const LAMPORTS = 1e9;
const sol = (l) => (l / LAMPORTS).toFixed(9).replace(/0+$/, '').replace(/\.$/, '');
// SPL token accounts cost this much rent to create (165 bytes, exempt).
const ATA_RENT = 2039280;

async function rpc(method, params) {
  const r = await fetch(RPC, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params })
  });
  return r.json();
}

async function report(label, addr) {
  console.log(`\n=== ${label}  ${addr} ===`);

  const bal = await rpc('getBalance', [addr]);
  const lamports = bal.result ? bal.result.value : -1;
  console.log(`  SOL balance        : ${sol(lamports)} SOL (${lamports} lamports)`);

  // All token accounts owned by this wallet.
  const accts = await rpc('getTokenAccountsByOwner', [
    addr, { programId: TOKEN_PROGRAM }, { encoding: 'jsonParsed' }
  ]);
  if (accts.error) {
    console.log(`  token accounts     : ERROR ${JSON.stringify(accts.error)}`);
    return { lamports, usdc: null, hasAta: false };
  }
  const list = accts.result.value;
  console.log(`  token accounts     : ${list.length}`);
  let usdc = null;
  let hasAta = false;
  for (const a of list) {
    const info = a.account.data.parsed.info;
    const mint = info.mint;
    const amt = info.tokenAmount.uiAmountString;
    const tag = mint === USDC_DEVNET ? '  <-- DEVNET USDC' : '';
    console.log(`    mint ${mint}  amount ${amt}${tag}`);
    if (mint === USDC_DEVNET) { usdc = amt; hasAta = true; }
  }
  if (usdc === null) console.log('    (no USDC token account at all)');
  return { lamports, usdc, hasAta };
}

(async () => {
  const p = await report('PAYER (sender)', PAYER);
  const w = await report('RECIPIENT (wife)', WIFE);

  console.log('\n=== what a USDC send actually requires ===');
  const fee = 5000;
  const needAta = !w.hasAta;
  const rent = needAta ? ATA_RENT : 0;
  console.log(`  fee for the transaction        : ${sol(fee)} SOL`);
  console.log(`  recipient ATA rent             : ${needAta ? sol(rent) + ' SOL (ATA missing)' : '0 (ATA already exists)'}`);
  const totalSol = fee + rent;
  console.log(`  TOTAL SOL the sender needs     : ${sol(totalSol)} SOL`);
  console.log(`  sender has                     : ${sol(p.lamports)} SOL`);
  console.log(`  => SOL sufficient?             : ${p.lamports >= totalSol ? 'YES' : 'NO  <-- WOULD FAIL'}`);
  console.log(`  sender USDC                    : ${p.usdc === null ? 'none' : p.usdc + ' USDC'}`);
  console.log(`  => has USDC to send?           : ${p.usdc && Number(p.usdc) > 0 ? 'YES' : 'NO  <-- WOULD FAIL'}`);
})();
