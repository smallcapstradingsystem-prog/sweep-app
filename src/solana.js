import { Connection, PublicKey, VersionedTransaction } from '@solana/web3.js';
import { getAssociatedTokenAddress, getAccount, TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID } from '@solana/spl-token';
import { FEE_WALLET_EVM, FEE_WALLET_SOLANA } from './config.js';

// =====================================================================
// CONSTANTS
// =====================================================================

const SOL_MINT     = 'So11111111111111111111111111111111111111112';
const SOLANA_CHAIN = 7565164;   // deBridge internal chain id for Solana
const ETH_CHAIN    = 1;
const ETH_USDC     = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48';

const DEBRIDGE_API = 'https://dln.debridge.finance/v1.0';

const MIN_DEBRIDGE_OUT_USDC = 1_000_000n;  // 1.00 USDC

// Reserve kept behind on Solana after a sweep.
// Per-order cost ≈ 0.0056 SOL (rent + tx + priority).
// Reserve of 0.015 SOL leaves enough for one more order.
const SOL_RESERVE_LAMPORTS = 15_000_000n;   // 0.015 SOL

// Skip SOL sweeps below this — the SOL itself would be eaten by fees.
const SOL_MIN_SWEEP_LAMPORTS = 10_000_000n; // 0.01 SOL

// Affiliate fee: 10% of gross = 1/9 of net output. Not part of the
// on-chain transaction; accrues inside the DLN program and is claimed
// separately by affiliate-claim-worker.
const AFFILIATE_FEE_BPS = 1000n;
const BPS_DENOMINATOR = 10000n;

const SOLANA_RPC_PROXY = 'https://poolport-liquifi-rpc.smallcapstradingsystem.workers.dev/rpc/solana';

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
// DERIVATION SELECTION
// =====================================================================

export async function selectSolanaKeypair(connection, candidates, logLine) {
  const withActivity = [];
  let anyCallSucceeded = false;

  for (const c of candidates) {
    try {
      const sigs = await connection.getSignaturesForAddress(
        new PublicKey(c.address),
        { limit: 1 }
      );
      anyCallSucceeded = true;
      if (sigs.length > 0) {
        withActivity.push({ ...c, lastSeen: sigs[0].blockTime || 0 });
      }
    } catch (e) {
      // RPC failure — don't treat as "no activity"
    }
  }

  if (withActivity.length === 1) {
    const picked = withActivity[0];
    if (logLine) {
      logLine(`  Auto-selected ${picked.name} derivation (${picked.address.slice(0, 8)}... has on-chain history)`);
    }
    return picked;
  }

  if (withActivity.length > 1) {
    withActivity.sort((a, b) => b.lastSeen - a.lastSeen);
    const phantom = withActivity.find((c) => c.name === 'phantom');
    const picked = phantom || withActivity[0];
    if (logLine) {
      logLine(`  Multiple derivations have activity; using ${picked.name} (${picked.address.slice(0, 8)}...)`);
    }
    return picked;
  }

  const phantom = candidates.find((c) => c.name === 'phantom') || candidates[0];

  if (!anyCallSucceeded) {
    if (logLine) {
      logLine(`  WARN: RPC unavailable for derivation selection; using ${phantom.name} default (${phantom.address.slice(0, 8)}...)`);
    }
    return phantom;
  }

  if (logLine) {
    logLine(`  No on-chain activity found; defaulting to ${phantom.name} derivation (${phantom.address.slice(0, 8)}...)`);
  }
  return phantom;
}

// =====================================================================
// DEBRIDGE — create cross-chain order
// =====================================================================

async function createDebridgeOrder({ srcMint, amountRaw, srcAuthority, userDestination }) {
  const params = new URLSearchParams({
    srcChainId: String(SOLANA_CHAIN),
    srcChainTokenIn: srcMint,
    srcChainTokenInAmount: amountRaw.toString(),
    dstChainId: String(ETH_CHAIN),
    dstChainTokenOut: ETH_USDC,
    dstChainTokenOutAmount: 'auto',
    dstChainTokenOutRecipient: userDestination,
    srcChainOrderAuthorityAddress: srcAuthority,
    dstChainOrderAuthorityAddress: userDestination,
    affiliateFeePercent: '10',
    affiliateFeeRecipient: FEE_WALLET_SOLANA,
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

async function signAndSendDebridgeTx(connection, keypair, order) {
  const txBytes = Buffer.from(order.tx.data.replace(/^0x/, ''), 'hex');
  const tx = VersionedTransaction.deserialize(txBytes);

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
    recipient: FEE_WALLET_EVM,
    userDestination: opts.userDestination || null,
    swaps: [],
    transfers: [],
    errors: [],
    // deBridge reports these figures as estimates. The user's actual
    // USDC arrives minutes later, settled by a solver, and may vary
    // slightly. The affiliate fee is not on-chain — it accrues inside
    // the DLN program and is claimed by the affiliate-claim-worker.
    usdcReceivedRaw: '0',
    userReceivedRaw: '0',
    feeReceivedRaw: '0',
    estimates: true,
  };
  const dryRun = !!opts.dryRun;
  const userDestination = opts.userDestination;
  if (!userDestination) {
    results.errors.push('userDestination is required for the direct-to-user model');
    return results;
  }

  let usdcReceived = 0n;

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
        userDestination,
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
          userDestination,
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

  // The user receives usdcReceived in full. The affiliate fee accrues
  // on the input side of the deBridge order, so from the client's view
  // it's 1/9 of the net output (10% of gross).
  const userNet = usdcReceived;
  const feeEstimate = (userNet * AFFILIATE_FEE_BPS) / (BPS_DENOMINATOR - AFFILIATE_FEE_BPS);
  results.userReceivedRaw = userNet.toString();
  results.feeReceivedRaw = feeEstimate.toString();
  results.usdcReceivedRaw = userNet.toString();
  return results;
}