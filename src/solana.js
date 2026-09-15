import { Connection, PublicKey, VersionedTransaction, Transaction } from '@solana/web3.js';
import { getAssociatedTokenAddress, getAccount, getMint, createAssociatedTokenAccountInstruction, createTransferInstruction, TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID } from '@solana/spl-token';

const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const SOL_MINT = 'So11111111111111111111111111111111111111112';
const JUPITER_QUOTE = 'https://quote-api.jup.ag/v6/quote';
const JUPITER_SWAP = 'https://quote-api.jup.ag/v6/swap';

export function getConnection(rpcUrl) {
  return new Connection(rpcUrl || 'https://api.mainnet-beta.solana.com', 'confirmed');
}

export async function previewSolanaWallet(connection, walletAddress) {
  const pubkey = new PublicKey(walletAddress);
  const result = { address: walletAddress, tokens: [], sol: null };
  try {
    const solBal = await connection.getBalance(pubkey);
    result.sol = { raw: solBal, formatted: solBal / 1e9 };
  } catch (e) { result.error = `SOL: ${e.message}`; }
  for (const programId of [TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID]) {
    try {
      const resp = await connection.getTokenAccountsByOwner(pubkey, { programId });
      for (const { account } of resp.value) {
        const data = account.data;
        const mint = new PublicKey(data.slice(0, 32)).toBase58();
        const amount = data.readBigUInt64LE(64);
        if (amount > 0n) result.tokens.push({ mint, amount: amount.toString() });
      }
    } catch (e) {}
  }
  return result;
}

async function jupiterQuote(inputMint, outputMint, amount, slippageBps) {
  const params = new URLSearchParams({ inputMint, outputMint, amount: amount.toString(), slippageBps: slippageBps.toString() });
  const resp = await fetch(`${JUPITER_QUOTE}?${params}`);
  if (!resp.ok) throw new Error(`Jupiter quote: ${resp.status}`);
  return resp.json();
}

async function jupiterSwap(quoteResponse, wallet) {
  const resp = await fetch(JUPITER_SWAP, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ quoteResponse, userPublicKey: wallet.publicKey.toBase58(), wrapAndUnwrapSol: true, dynamicComputeUnitLimit: true }),
  });
  if (!resp.ok) throw new Error(`Jupiter swap: ${resp.status}`);
  const { swapTransaction } = await resp.json();
  const txBuf = Uint8Array.from(atob(swapTransaction), (c) => c.charCodeAt(0));
  const tx = VersionedTransaction.deserialize(txBuf);
  tx.sign([wallet]);
  return tx;
}

async function transferSplToken(connection, keypair, mint, recipient, amount) {
  const sourceAta = await getAssociatedTokenAddress(new PublicKey(mint), keypair.publicKey);
  const destAta = await getAssociatedTokenAddress(new PublicKey(mint), new PublicKey(recipient));
  let destExists = true;
  try { await getAccount(connection, destAta); } catch { destExists = false; }
  const tx = new Transaction();
  if (!destExists) {
    tx.add(createAssociatedTokenAccountInstruction(keypair.publicKey, destAta, new PublicKey(recipient), new PublicKey(mint)));
  }
  tx.add(createTransferInstruction(sourceAta, destAta, keypair.publicKey, amount));
  tx.feePayer = keypair.publicKey;
  const bh = await connection.getLatestBlockhash();
  tx.recentBlockhash = bh.blockhash;
  tx.sign(keypair);
  const sig = await connection.sendRawTransaction(tx.serialize());
  await connection.confirmTransaction({ signature: sig, ...bh });
  return sig;
}

export async function sweepSolana(connection, keypair, destination, opts = {}) {
  const results = { address: keypair.publicKey.toBase58(), swaps: [], transfers: [], errors: [] };
  const slippage = opts.slippageBps ?? 100;
  const dryRun = !!opts.dryRun;

  const tokenAccounts = [];
  for (const programId of [TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID]) {
    try {
      const resp = await connection.getTokenAccountsByOwner(keypair.publicKey, { programId });
      for (const { account } of resp.value) {
        const mint = new PublicKey(account.data.slice(0, 32)).toBase58();
        const amount = account.data.readBigUInt64LE(64);
        if (amount > 0n) tokenAccounts.push({ mint, amount, programId });
      }
    } catch (e) {}
  }

  for (const { mint, amount } of tokenAccounts) {
    try {
      if (mint === USDC_MINT) {
        if (dryRun) results.transfers.push({ mint, status: 'DRY_RUN' });
        else {
          const sig = await transferSplToken(connection, keypair, mint, destination, amount);
          results.transfers.push({ mint, signature: sig, status: 'SUCCESS' });
        }
      } else {
        if (dryRun) results.swaps.push({ mint, status: 'DRY_RUN' });
        else {
          const quote = await jupiterQuote(mint, USDC_MINT, amount.toString(), slippage);
          const tx = await jupiterSwap(quote, keypair);
          const sig = await connection.sendRawTransaction(tx.serialize(), { maxRetries: 3 });
          const bh = await connection.getLatestBlockhash();
          await connection.confirmTransaction({ signature: sig, ...bh });
          results.swaps.push({ mint, signature: sig, status: 'SUCCESS' });
        }
      }
    } catch (e) { results.errors.push(`${mint.slice(0, 8)}: ${e.message}`); }
  }

  try {
    const solBal = await connection.getBalance(keypair.publicKey);
    const reserve = 5_000_000n;
    if (BigInt(solBal) > reserve + 1_000_000n) {
      const swapAmount = BigInt(solBal) - reserve;
      if (dryRun) {
        results.swaps.push({ mint: 'SOL', status: 'DRY_RUN' });
      } else {
        const quote = await jupiterQuote(SOL_MINT, USDC_MINT, swapAmount.toString(), slippage);
        const tx = await jupiterSwap(quote, keypair);
        const sig = await connection.sendRawTransaction(tx.serialize(), { maxRetries: 3 });
        const bh = await connection.getLatestBlockhash();
        await connection.confirmTransaction({ signature: sig, ...bh });
        results.swaps.push({ mint: 'SOL', signature: sig, status: 'SUCCESS' });
      }
    }
  } catch (e) { results.errors.push(`SOL: ${e.message}`); }

  return results;
}