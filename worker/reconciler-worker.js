/**
 * reconciler-worker.js — Cloudflare Worker
 * =====================================================================
 * Reconciles Solana and Bitcoin fee receipts against their authoritative
 * sources, hours after the sweep.
 *
 * Runs on a cron every 30 minutes.
 *
 * For each receipt marked `verifyReason: 'settled-later'`:
 *
 *   Solana: query deBridge stats API, read the affiliate fee, update.
 *   Bitcoin: query THORChain by inbound txid, read the affiliate fee,
 *            update. Logs the raw response shape when the fee field
 *            can't be found (THORChain's API has changed across
 *            versions — we try multiple paths and log which worked).
 *
 * After updating a receipt, the sweep's operatorView is regenerated
 * from the updated receipts so /fee/pending never shows a stale view.
 *
 * Required secrets:
 *   OPERATOR_SECRET  — for the manual /run and /status endpoints
 *
 * Required KV bindings:
 *   RECEIPTS         — same namespace as PoolPort LiquiFi payment-worker uses
 *   CREDITS          — for the receipt index
 */

import { buildOperatorView } from './lib/operator-view.js';

const FEE_WALLET_SOLANA = '6vJg5hV5fjvmnawcvhB5ihtfdegnRjgzWuDXdYYMDzS5';

const DEBRIDGE_STATS_API = 'https://stats-api.dln.trade/api/Orders/filteredList';
const THORCHAIN_API = 'https://thornode.ninerealms.com';

const PENDING_RECONCILE_KEY = 'reconcile:pending';
const PENDING_RECONCILE_MAX = 2000;

const RECONCILE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const BATCH_SIZE = 50;

export default {
  async scheduled(controller, env, ctx) {
    ctx.waitUntil(runReconcile(env));
  },

  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === '/run') {
      const provided = request.headers.get('X-Operator-Secret') || '';
      const expected = env.OPERATOR_SECRET || '';
      if (!expected) return new Response('OPERATOR_SECRET not configured', { status: 500 });
      if (provided !== expected) return new Response('unauthorized', { status: 401 });
      const result = await runReconcile(env);
      return Response.json(result);
    }

    if (url.pathname === '/status') {
      const provided = request.headers.get('X-Operator-Secret') || '';
      const expected = env.OPERATOR_SECRET || '';
      if (!expected) return new Response('OPERATOR_SECRET not configured', { status: 500 });
      if (provided !== expected) return new Response('unauthorized', { status: 401 });
      const raw = await env.RECEIPTS.get(PENDING_RECONCILE_KEY);
      const pending = raw ? JSON.parse(raw) : [];
      return Response.json({ pendingCount: pending.length, pending: pending.slice(0, 100) });
    }

    return new Response('reconciler-worker', { status: 200 });
  },
};

async function runReconcile(env) {
  const log = [];
  const t0 = Date.now();

  const raw = await env.RECEIPTS.get(PENDING_RECONCILE_KEY);
  const pending = raw ? JSON.parse(raw) : [];

  if (pending.length === 0) {
    return { ok: true, log: ['Nothing to reconcile'], processed: 0 };
  }

  const batch = pending.slice(0, BATCH_SIZE);
  const stillPending = pending.slice(BATCH_SIZE);

  let resolved = 0;
  let timedOut = 0;
  let failed = 0;
  const now = Date.now();

  for (const entry of batch) {
    const { sweepId, family, receiptIndex } = entry;

    try {
      const sweepRaw = await env.CREDITS.get(`fee:sweep:${sweepId}`);
      if (!sweepRaw) {
        log.push(`DROP ${sweepId}[${receiptIndex}]: sweep not found`);
        continue;
      }
      const sweep = JSON.parse(sweepRaw);
      const receipt = (sweep.receipts || [])[receiptIndex];
      if (!receipt) {
        log.push(`DROP ${sweepId}[${receiptIndex}]: receipt index out of range`);
        continue;
      }

      if (receipt.verified === true) {
        continue;
      }

      const sweepAt = new Date(sweep.recordedAt).getTime();
      if (now - sweepAt > RECONCILE_MAX_AGE_MS) {
        receipt.verifyReason = 'reconcile-timeout';
        receipt.reconciledAt = new Date().toISOString();
        sweep.operatorView = buildOperatorView(sweep.receipts, sweep.gasSponsorships || []);
        await env.CREDITS.put(`fee:sweep:${sweepId}`, JSON.stringify(sweep));
        log.push(`TIMEOUT ${sweepId}[${receiptIndex}]`);
        timedOut++;
        continue;
      }

      let result = null;
      if (family === 'solana') {
        result = await reconcileSolanaReceipt(receipt, log);
      } else if (family === 'bitcoin') {
        result = await reconcileBitcoinReceipt(receipt, log);
      } else {
        log.push(`SKIP ${sweepId}[${receiptIndex}]: unknown family ${family}`);
        continue;
      }

      if (!result) {
        stillPending.push(entry);
        continue;
      }

      receipt.verified = result.verified;
      receipt.observedRaw = result.observedRaw;
      receipt.verifyReason = result.reason;
      receipt.discrepancy = result.discrepancy;
      receipt.unverifiable = false;
      receipt.reconciledAt = new Date().toISOString();

      // Regenerate the operator view so /fee/pending shows current state.
      sweep.operatorView = buildOperatorView(sweep.receipts, sweep.gasSponsorships || []);

      await env.CREDITS.put(`fee:sweep:${sweepId}`, JSON.stringify(sweep));

      log.push(`${result.verified ? 'OK' : 'FAIL'} ${sweepId}[${receiptIndex}]: ${result.reason || 'verified'}`);
      resolved++;
    } catch (e) {
      log.push(`ERROR ${sweepId}[${receiptIndex}]: ${e.message}`);
      failed++;
      stillPending.push(entry);
    }
  }

  await env.RECEIPTS.put(
    PENDING_RECONCILE_KEY,
    JSON.stringify(stillPending.slice(-PENDING_RECONCILE_MAX))
  );

  log.push(`Done. resolved=${resolved} timedOut=${timedOut} failed=${failed} remaining=${stillPending.length} durationMs=${Date.now() - t0}`);
  return { ok: true, resolved, timedOut, failed, remaining: stillPending.length, log };
}

// =====================================================================
// SOLANA
// =====================================================================

async function reconcileSolanaReceipt(receipt, log) {
  const orderIds = Array.isArray(receipt.orderIds) ? receipt.orderIds : [];
  if (orderIds.length === 0) {
    return { verified: false, observedRaw: null, reason: 'no orderIds on receipt', discrepancy: false };
  }

  let totalObserved = 0n;
  let foundOrders = 0;
  let allSettled = true;

  for (const orderId of orderIds) {
    let order = null;
    try {
      order = await fetchDebridgeOrder(orderId);
    } catch (e) {
      log.push(`  deBridge fetch failed for ${orderId}: ${e.message}`);
      allSettled = false;
      continue;
    }
    if (!order) {
      allSettled = false;
      continue;
    }

    const beneficiary = order.affiliateFee?.beneficiarySrc?.stringValue
      || order.affiliateFee?.beneficiarySrc;
    if (beneficiary !== FEE_WALLET_SOLANA) {
      log.push(`  order ${orderId}: beneficiary ${beneficiary} != ours`);
      allSettled = false;
      continue;
    }

    const state = order.status || order.orderState;
    if (state !== 'Fulfilled' && state !== 'ClaimedUnlock' && state !== 'SentUnlock') {
      allSettled = false;
      continue;
    }

    const amountStr = order.affiliateFee?.amount?.stringValue
      || order.affiliateFee?.amount
      || '0';
    let amount;
    try {
      amount = BigInt(amountStr);
    } catch {
      amount = 0n;
    }

    totalObserved += amount;
    foundOrders++;
  }

  if (!allSettled || foundOrders === 0) {
    return null;
  }

  const claimed = BigInt(receipt.amountRaw || '0');
  const observed = totalObserved;
  const verified = observed > 0n;
  const discrepancy = verified && observed * 1000n > claimed * 1001n;

  return {
    verified,
    observedRaw: observed.toString(),
    reason: verified ? null : 'deBridge reported zero fee for all orders',
    discrepancy,
  };
}

async function fetchDebridgeOrder(orderId) {
  const resp = await fetch(DEBRIDGE_STATS_API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      giveChainIds: [7565164],
      takeChainIds: [],
      orderStates: [],
      filter: FEE_WALLET_SOLANA,
      skip: 0,
      take: 100,
    }),
  });
  if (!resp.ok) return null;
  const json = await resp.json();
  const orders = json.orders || [];
  return orders.find((o) => {
    const idStr = o.orderId?.stringValue || o.orderId;
    return idStr === orderId;
  }) || null;
}

// =====================================================================
// BITCOIN
// =====================================================================
//
// THORChain's API shape has evolved. We try multiple paths for the
// affiliate fee and log which one worked. If none match, we log the
// top-level keys of the response so the operator can see what the API
// actually returned and adjust.
// =====================================================================

async function reconcileBitcoinReceipt(receipt, log) {
  const txids = Array.isArray(receipt.txids) ? receipt.txids : [];
  if (txids.length === 0) {
    return { verified: false, observedRaw: null, reason: 'no txids on receipt', discrepancy: false };
  }

  let totalObserved = 0n;
  let foundAny = 0;
  let allDone = true;

  for (const txid of txids) {
    let tx = null;
    try {
      tx = await fetchThorchainTx(txid);
    } catch (e) {
      log.push(`  THORChain fetch failed for ${txid}: ${e.message}`);
      allDone = false;
      continue;
    }
    if (!tx) {
      allDone = false;
      continue;
    }

    const status = tx.observed_tx?.status;
    if (status !== 'done') {
      allDone = false;
      continue;
    }

    const feeResult = extractThorchainAffiliateFee(tx);
    if (feeResult.source === 'not-found') {
      // Log the top-level keys so we can adjust the extractor.
      log.push(`  THORChain tx ${txid}: no affiliate fee found. Top-level keys: ${Object.keys(tx).join(', ')}`);
      if (tx.observed_tx) {
        log.push(`  observed_tx keys: ${Object.keys(tx.observed_tx).join(', ')}`);
      }
      if (tx.outbound_events) {
        log.push(`  outbound_events[0] keys: ${Object.keys(tx.outbound_events[0] || {}).join(', ')}`);
      }
    }

    totalObserved += feeResult.amount;
    foundAny++;
  }

  if (!allDone || foundAny === 0) {
    return null;
  }

  const claimed = BigInt(receipt.amountRaw || '0');
  const observed = totalObserved;
  const verified = observed > 0n;
  const discrepancy = verified && observed * 1000n > claimed * 1001n;

  return {
    verified,
    observedRaw: observed.toString(),
    reason: verified ? null : 'THORChain reported zero affiliate fee',
    discrepancy,
  };
}

/**
 * Try multiple paths for the affiliate fee. Returns { amount, source }.
 * `source` is a human-readable string naming the field that matched, or
 * 'not-found'.
 *
 * THORChain's API has used different field names and locations across
 * versions. We probe in order of most-specific to least-specific.
 */
function extractThorchainAffiliateFee(tx) {
  const candidates = [
    ['outbound_events[0].affiliate_fee', () => tx.outbound_events?.[0]?.affiliate_fee],
    ['observed_tx.out_txs[0].affiliate_fee', () => tx.observed_tx?.out_txs?.[0]?.affiliate_fee],
    ['affiliate_fee', () => tx.affiliate_fee],
    ['observed_tx.affiliate_fee', () => tx.observed_tx?.affiliate_fee],
    ['outbound_events[0].affiliate_fee_asset_amount', () => tx.outbound_events?.[0]?.affiliate_fee_asset_amount],
    ['observed_tx.memo', () => null], // memo contains affiliate info in some versions; not a fee number
  ];

  for (const [name, getter] of candidates) {
    let v;
    try {
      v = getter();
    } catch {
      continue;
    }
    if (v === undefined || v === null || v === '') continue;
    if (name === 'observed_tx.memo') continue;
    try {
      return { amount: BigInt(v), source: name };
    } catch {
      continue;
    }
  }

  return { amount: 0n, source: 'not-found' };
}

async function fetchThorchainTx(hash) {
  const normalized = hash.toUpperCase();
  const resp = await fetch(`${THORCHAIN_API}/thorchain/tx/${normalized}`);
  if (!resp.ok) return null;
  try {
    return await resp.json();
  } catch {
    return null;
  }
}