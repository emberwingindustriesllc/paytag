// Resolve the destination address and the quoted slot across clusters.
const CLUSTERS = {
  devnet: 'https://api.devnet.solana.com',
  'mainnet-beta': 'https://api.mainnet-beta.solana.com'
};
const WIFE = '5Uw4H6Bs6Bp7AAVCywVsMNequrmgfU79tZCu9sGk8iyY';
const MINE = '5y5Peuhq2FvYCC4WLVKM6tirDSRJ4KHa4oACaFb6Xp3d';
const QUOTED_SLOT = 455052568;

async function rpc(url, method, params) {
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params })
  });
  return r.json();
}
const sol = (l) => (l / 1e9).toFixed(9).replace(/0+$/, '').replace(/\.$/, '');

(async () => {
  for (const [name, url] of Object.entries(CLUSTERS)) {
    console.log(`\n=== ${name} ===`);
    for (const [label, addr] of [['mine', MINE], ['destination 5Uw4', WIFE]]) {
      const b = await rpc(url, 'getBalance', [addr]);
      console.log(`  ${label.padEnd(18)} ${b.result ? sol(b.result.value) + ' SOL' : JSON.stringify(b.error)}`);
    }
    // Does the slot the user quoted exist on this cluster?
    const blk = await rpc(url, 'getBlock', [QUOTED_SLOT, { encoding: 'json', maxSupportedTransactionVersion: 0, transactionDetails: 'none', rewards: false }]);
    if (blk.result) {
      console.log(`  slot ${QUOTED_SLOT} EXISTS (parent ${blk.result.parentSlot}, ${blk.result.blockTime ? new Date(blk.result.blockTime*1000).toISOString() : '?'})`);
    } else {
      console.log(`  slot ${QUOTED_SLOT} -> ${blk.error ? blk.error.message : 'not found'}`);
    }
  }
})();
