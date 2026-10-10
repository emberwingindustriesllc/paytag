// Build the EXACT transaction app.js builds for a USDC send and simulate it
// against devnet. This is decisive: a successful simulation means the
// construction is correct and any failure in the browser is environmental
// (wrong wallet network, Phantom refusing, etc). A failure returns the real
// program error instead of a guess.
import fs from 'node:fs';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';

const BUNDLE = process.argv[2];
const RPC = 'https://api.devnet.solana.com';
const USDC = '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU';
const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const ATA_PROGRAM = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL';
const PAYER = '5y5Peuhq2FvYCC4WLVKM6tirDSRJ4KHa4oACaFb6Xp3d';
const WIFE = '5Uw4H6Bs6Bp7AAVCywVsMNequrmgfU79tZCu9sGk8iyY';
const AMOUNT = 4000000; // 4 USDC, 6 decimals

// Load the real browser bundle.
const src = fs.readFileSync(BUNDLE, 'utf8');
// Run in the MAIN realm so Buffer is the real one. Loading the bundle inside
// a vm context gives it a different Buffer constructor, and web3.js then fails
// with "Expected Buffer" deep inside transaction serialization.
globalThis.self = globalThis;
if (!globalThis.crypto) { globalThis.crypto = webcrypto; }
vm.runInThisContext(src, { filename: 'web3.iife.min.js' });
const web3 = globalThis.solanaWeb3;

const IX_TRANSFER_CHECKED = 12;
const IX_ATA_CREATE_IDEMPOTENT = 1;

function deriveAta(owner, mint) {
  const tp = new web3.PublicKey(TOKEN_PROGRAM);
  const ap = new web3.PublicKey(ATA_PROGRAM);
  return web3.PublicKey.findProgramAddressSync(
    [owner.toBuffer(), tp.toBuffer(), mint.toBuffer()], ap
  )[0];
}

(async () => {
  const connection = new web3.Connection(RPC, 'confirmed');
  const payer = new web3.PublicKey(PAYER);
  const wife = new web3.PublicKey(WIFE);
  const mint = new web3.PublicKey(USDC);

  const sourceAta = deriveAta(payer, mint);
  const destAta = deriveAta(wife, mint);
  console.log('source ATA (payer):', sourceAta.toString());
  console.log('dest ATA   (wife) :', destAta.toString());

  const destInfo = await connection.getAccountInfo(destAta);
  console.log('dest ATA exists   :', !!destInfo);

  const tx = new web3.Transaction();

  if (!destInfo) {
    tx.add(new web3.TransactionInstruction({
      programId: new web3.PublicKey(ATA_PROGRAM),
      keys: [
        { pubkey: payer, isSigner: true, isWritable: true },
        { pubkey: destAta, isSigner: false, isWritable: true },
        { pubkey: wife, isSigner: false, isWritable: false },
        { pubkey: mint, isSigner: false, isWritable: false },
        { pubkey: web3.SystemProgram.programId, isSigner: false, isWritable: false },
        { pubkey: new web3.PublicKey(TOKEN_PROGRAM), isSigner: false, isWritable: false }
      ],
      data: Uint8Array.from([IX_ATA_CREATE_IDEMPOTENT])
    }));
  }

  const data = new Uint8Array(10);
  data[0] = IX_TRANSFER_CHECKED;
  let rem = AMOUNT;
  for (let i = 0; i < 8; i++) { data[1 + i] = rem & 0xff; rem = Math.floor(rem / 256); }
  data[9] = 6;
  tx.add(new web3.TransactionInstruction({
    programId: new web3.PublicKey(TOKEN_PROGRAM),
    keys: [
      { pubkey: sourceAta, isSigner: false, isWritable: true },
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: destAta, isSigner: false, isWritable: true },
      { pubkey: payer, isSigner: true, isWritable: false }
    ],
    data
  }));

  const latest = await connection.getLatestBlockhash();
  tx.recentBlockhash = latest.blockhash;
  tx.feePayer = payer;

  console.log('\ninstruction count :', tx.instructions.length);
  console.log('feePayer          :', tx.feePayer.toString());

  // Simulate. sigVerify:false lets an unsigned transaction be checked for
  // correctness (the runtime skips signature checks but still runs every
  // program), which is exactly what we want.
  try {
    const sim = await connection.simulateTransaction(tx, undefined, 'confirmed');
    console.log('\n=== SIMULATION ===');
    console.log('err  :', JSON.stringify(sim.value.err));
    console.log('logs :');
    (sim.value.logs || []).forEach((l) => console.log('   ' + l));
    console.log('\nunits consumed:', sim.value.unitsConsumed);
  } catch (e) {
    console.log('\nsimulation threw:', e.message);
    if (e.logs) e.logs.forEach((l) => console.log('   ' + l));
  }
})();
