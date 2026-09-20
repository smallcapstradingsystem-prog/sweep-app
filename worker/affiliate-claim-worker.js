/**
 * affiliate-claim-worker.js — Cloudflare Worker
 * =====================================================================
 * Claims accumulated deBridge affiliate fees on Solana.
 *
 * Runs on a cron schedule. For each unclaimed fee:
 *   1. Enumerates orders via the deBridge stats API (orderStates=ClaimedUnlock)
 *   2. Builds withdrawAffiliateFee instructions manually
 *   3. Only marks the order as claimed after on-chain confirmation
 *
 * Uses only @solana/web3.js and @solana/spl-token — no deBridge SDK,
 * no web3@1.8.0, no window ReferenceError.
 *
 * Program ID and PDA seeds verified against:
 *   - deBridge official reference implementation (dln-taker-withdrawal script)
 *   - Real DLN source program on Solana mainnet:
 *     src5qyZHqTqecJV4aY6Cb6zDZLMDzrDKKezs22MPHr4
 *   - Seeds: "give_order_state" + orderId, "give_order_wallet" + orderId
 *
 * Required secrets:
 *   HELIUS_KEY              — for Solana RPC
 *   SOLANA_CLAIMER_KEY      — base58 private key of FEE_WALLET_SOLANA
 *   OPERATOR_SECRET         — required for the manual /claim endpoint
 *
 * Required KV namespace:
 *   CLAIM_STATE             — dedup: which orderIds have been claimed
 */

import {
  Connection,
  Keypair,
  PublicKey,
  TransactionInstruction,
  VersionedTransaction,
  MessageV0,
  ComputeBudgetProgram,
} from '@solana/web3.js';
import { getAssociatedTokenAddress } from '@solana/spl-token';
import bs58 from 'bs58';

// =====================================================================
// CONFIG
// =====================================================================

const FEE_WALLET_SOLANA = '6vJg5hV5fjvmnawcvhB5ihtfdegnRjgzWuDXdYYMDzS5';

// DlnSource program on Solana — owns withdrawAffiliateFee.
// Verified against the real mainnet program (from deBridge SDK
// `programs.dlnSrc` and confirmed by the DLN source program ID).
const DLN_SOURCE_PROGRAM = new PublicKey('src5qyZHqTqecJV4aY6Cb6zDZLMDzrDKKezs22MPHr4');

// Anchor instruction discriminator for withdrawAffiliateFee.
// Taken verbatim from the deBridge reference implementation:
//   const discriminator = [143, 79, 158, 208, 125, 51, 86, 85];
const WITHDRAW_AFFILIATE_FEE_DISCRIMINATOR = Buffer.from([143, 79, 158, 208, 125, 51, 86, 85]);

// deBridge stats API for enumerating claimable orders.
const DEBRIDGE_STATS_API = 'https://stats-api.dln.trade/api/Orders/filteredList';

// Chain ID for Solana in deBridge's numbering.
const CHAIN_ID_SOLANA = 7565164;

// Token program IDs.
const TOKEN_PROGRAM = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
const TOKEN_2022_PROGRAM = new PublicKey('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb');
const ASSOCIATED_TOKEN_PROGRAM = new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');

// Max orders per API page.
const API_PAGE_SIZE = 100;

// =====================================================================
// HANDLER
// =====================================================================

export default {
  async scheduled(controller, env, ctx) {
    ctx.waitUntil(runClaim(env));
  },

  // ─── TONIGHT: manual /claim is now gated behind OPERATOR_SECRET.
  // Previously anyone who knew the worker URL could trigger an on-chain
  // claim run with the hot Solana key. The cron path is unaffected.
  //
  // Log every attempt (authorized or not) so probing is visible.
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === '/claim') {
      const provided = request.headers.get('X-Operator-Secret') || '';
      const expected = env.OPERATOR_SECRET || '';

      if (!expected) {
        console.error('OPERATOR_SECRET not configured — refusing /claim');
        return new Response('OPERATOR_SECRET not configured', { status: 500 });
      }

      if (provided !== expected) {
        console.warn(JSON.stringify({
          ts: new Date().toISOString(),
          event: 'unauthorized_claim_attempt',
          ip: request.headers.get('cf-connecting-ip') || 'unknown',
          ua: request.headers.get('user-agent') || '',
        }));
        return new Response('unauthorized', { status: 401 });
      }

      const result = await runClaim(env);
      return Response.json(result);
    }

    return new Response('affiliate-claim-worker', { status: 200 });
  },
};

async function runClaim(env) {
  const log = [];
  const t0 = Date.now();

  try {
    // 1. Set up Solana connection and keypair
    const rpcUrl = `https://mainnet.helius-rpc.com/?api-key=${env.HELIUS_KEY}`;
    const connection = new Connection(rpcUrl, 'confirmed');

    if (!env.SOLANA_CLAIMER_KEY) {
      throw new Error('SOLANA_CLAIMER_KEY is not configured');
    }
    const secretKey = bs58.decode(env.SOLANA_CLAIMER_KEY);
    const keypair = Keypair.fromSecretKey(secretKey);
    const beneficiary = keypair.publicKey;
    const claimerAddress = beneficiary.toBase58();

    if (claimerAddress !== FEE_WALLET_SOLANA) {
      throw new Error(
        `SOLANA_CLAIMER_KEY does not match FEE_WALLET_SOLANA. ` +
        `Key is for ${claimerAddress}, expected ${FEE_WALLET_SOLANA}`
      );
    }

    log.push(`Claimer: ${claimerAddress}`);

    // 2. Load the set of orderIds we've already claimed.
    const claimedRaw = await env.CLAIM_STATE.get('claimed_order_ids');
    const claimed = new Set(claimedRaw ? JSON.parse(claimedRaw) : []);

    // 3. Enumerate unlocked orders from the deBridge stats API.
    log.push(`Enumerating orders from stats API...`);
    const orders = await getUnlockedOrders(beneficiary);
    log.push(`Unclaimed orders: ${orders.length}`);

    // 4. Filter out already-claimed orderIds.
    const toProcess = orders.filter((o) => !claimed.has(o.orderIdString));
    log.push(`After dedup filter: ${toProcess.length}`);

    let claimedCount = 0;
    let failedCount = 0;
    let skippedCount = 0;

    // 5. Build instructions for each order.
    for (const order of toProcess) {
      try {
        const orderIdBytes = order.orderIdBytes;
        if (orderIdBytes.length !== 32) {
          log.push(`SKIP ${order.orderIdString}: orderId is ${orderIdBytes.length} bytes, expected 32`);
          skippedCount++;
          continue;
        }

        // Derive the order state and wallet PDAs.
        const orderStatePda = getGiveOrderStateAccount(orderIdBytes);
        const orderWalletPda = getGiveOrderWalletAddress(orderIdBytes);

        // Check the wallet has a balance — skip empty ones.
        const walletAccount = await connection.getAccountInfo(orderWalletPda);
        if (!walletAccount || walletAccount.data.length < 72) {
          log.push(`SKIP ${order.orderIdString}: no order wallet data`);
          skippedCount++;
          continue;
        }
        const amount = readSplTokenAmount(walletAccount.data);
        if (amount === 0n) {
          log.push(`SKIP ${order.orderIdString}: empty wallet`);
          skippedCount++;
          continue;
        }

        // Determine which token program owns this wallet (Token or Token-2022).
        const tokenProgram = walletAccount.owner.equals(TOKEN_2022_PROGRAM)
          ? TOKEN_2022_PROGRAM
          : TOKEN_PROGRAM;

        // Derive the associated token account for the beneficiary.
        const associatedTokenAddress = await getAssociatedTokenAddress(
          order.tokenMint,
          beneficiary,
          false,
          tokenProgram,
          ASSOCIATED_TOKEN_PROGRAM
        );

        // Build the withdrawAffiliateFee instruction.
        const instruction = buildWithdrawAffiliateFeeIx(
          beneficiary,
          associatedTokenAddress,
          orderStatePda,
          orderWalletPda,
          order.tokenMint,
          tokenProgram,
          orderIdBytes
        );

        // Build a versioned transaction with compute budget.
        const { blockhash } = await connection.getLatestBlockhash('confirmed');
        const tx = new VersionedTransaction(
          MessageV0.compile({
            payerKey: beneficiary,
            recentBlockhash: blockhash,
            instructions: [
              ComputeBudgetProgram.setComputeUnitLimit({ units: 300_000 }),
              ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 30_000 }),
              instruction,
            ],
          })
        );
        tx.sign([keypair]);

        const sig = await connection.sendRawTransaction(tx.serialize(), {
          maxRetries: 3,
          skipPreflight: false,
        });
        await connection.confirmTransaction(sig, 'confirmed');

        // ONLY mark as claimed after successful on-chain confirmation.
        claimed.add(order.orderIdString);
        claimedCount++;
        log.push(`CLAIMED ${order.orderIdString}: ${sig}`);
      } catch (e) {
        log.push(`FAILED ${order.orderIdString}: ${e.message}`);
        failedCount++;
        // Do NOT add to claimed — it will be retried next run.
      }
    }

    // 6. Persist claimed set (cap at 5000 entries).
    const claimedArray = Array.from(claimed).slice(-5000);
    await env.CLAIM_STATE.put('claimed_order_ids', JSON.stringify(claimedArray));

    log.push(
      `Done. claimed=${claimedCount} skipped=${skippedCount} failed=${failedCount} ` +
      `durationMs=${Date.now() - t0}`
    );

    return { ok: true, log };
  } catch (e) {
    log.push(`FATAL: ${e.message}`);
    return { ok: false, log, error: e.message };
  }
}

// =====================================================================
// INSTRUCTION BUILDER
// =====================================================================
//
// Direct port of the deBridge reference implementation:
//
//   const discriminator = [143, 79, 158, 208, 125, 51, 86, 85];
//
//   keys: [
//     { isSigner: true,  isWritable: true,  pubkey: beneficiary },
//     { isSigner: false, isWritable: true,  pubkey: associatedTokenAddress },
//     { isSigner: false, isWritable: true,  pubkey: orderStatePda },
//     { isSigner: false, isWritable: true,  pubkey: orderWalletPda },
//     { isSigner: false, isWritable: false, pubkey: tokenMint },
//     { isSigner: false, isWritable: false, pubkey: tokenProgram },
//   ]
//
//   data: discriminator ++ orderIdBytes (32 raw bytes)
// =====================================================================

function buildWithdrawAffiliateFeeIx(
  beneficiary,
  associatedTokenAddress,
  orderStatePda,
  orderWalletPda,
  tokenMint,
  tokenProgram,
  orderIdBytes
) {
  return new TransactionInstruction({
    programId: DLN_SOURCE_PROGRAM,
    keys: [
      { isSigner: true,  isWritable: true,  pubkey: beneficiary },
      { isSigner: false, isWritable: true,  pubkey: associatedTokenAddress },
      { isSigner: false, isWritable: true,  pubkey: orderStatePda },
      { isSigner: false, isWritable: true,  pubkey: orderWalletPda },
      { isSigner: false, isWritable: false, pubkey: tokenMint },
      { isSigner: false, isWritable: false, pubkey: tokenProgram },
    ],
    data: Buffer.concat([WITHDRAW_AFFILIATE_FEE_DISCRIMINATOR, orderIdBytes]),
  });
}

// =====================================================================
// PDA DERIVATIONS
// =====================================================================
//
// Verified against the deBridge reference implementation:
//
//   orderState  = ["give_order_state",  orderId] on DlnSource program
//   orderWallet = ["give_order_wallet", orderId] on DlnSource program
// =====================================================================

function getGiveOrderStateAccount(orderIdBytes) {
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from('give_order_state'), orderIdBytes],
    DLN_SOURCE_PROGRAM
  );
  return pda;
}

function getGiveOrderWalletAddress(orderIdBytes) {
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from('give_order_wallet'), orderIdBytes],
    DLN_SOURCE_PROGRAM
  );
  return pda;
}

// =====================================================================
// SPL TOKEN ACCOUNT DECODE
// =====================================================================
//
// Raw SPL token account layout: 165 bytes.
//   offset 0:  mint (32 bytes)
//   offset 32: owner (32 bytes)
//   offset 64: amount (u64, little-endian)
// =====================================================================

function readSplTokenAmount(data) {
  if (data.length < 72) return 0n;
  const view = new DataView(data.buffer, data.byteOffset + 64, 8);
  return view.getBigUint64(0, true);
}

// =====================================================================
// ORDER ENUMERATION
// =====================================================================
//
// Queries the deBridge stats API for ClaimedUnlock orders where our
// beneficiary is the affiliate fee recipient.
//
// Endpoint and request shape taken from the deBridge reference
// implementation (dln-taker-withdrawal):
//   https://stats-api.dln.trade/api/Orders/filteredList
//   body: { giveChainIds, takeChainIds, orderStates: ['ClaimedUnlock'],
//           filter, referralCode, skip, take }
// =====================================================================

async function getUnlockedOrders(beneficiary) {
  const all = [];
  let skip = 0;

  for (let n = 0; n < 100; n++) {  // Safety cap: 100 pages = 10,000 orders
    const resp = await fetch(DEBRIDGE_STATS_API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        giveChainIds: [CHAIN_ID_SOLANA],
        takeChainIds: [],
        orderStates: ['ClaimedUnlock'],
        filter: beneficiary.toBase58(),
        skip: skip * API_PAGE_SIZE,
        take: API_PAGE_SIZE,
      }),
    });

    if (!resp.ok) break;
    const json = await resp.json();
    const page = json.orders || [];
    if (page.length === 0) break;

    all.push(...page);
    skip++;

    if (page.length < API_PAGE_SIZE) break;
  }

  // Filter to orders where we're the affiliate fee beneficiary.
  return all
    .filter((o) => {
      const beneficiarySrc = o.affiliateFee?.beneficiarySrc?.stringValue;
      return beneficiarySrc === beneficiary.toBase58();
    })
    .map((o) => {
      // orderId comes as { stringValue, bytesArrayValue }
      const bytesArray = JSON.parse(o.orderId.bytesArrayValue);
      const orderIdBytes = Buffer.from(bytesArray);
      return {
        orderIdString: o.orderId.stringValue,
        orderIdBytes,
        tokenMint: new PublicKey(o.giveOfferWithMetadata.tokenAddress.stringValue),
      };
    });
}