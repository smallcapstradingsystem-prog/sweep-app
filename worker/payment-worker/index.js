/**
 * payment-worker.js — Crypto payments + fee tracking for Sweeper
 * =====================================================================
 * Handles:
 *   - Crypto payments for sweep credits
 *   - Fee receipt tracking (manual forward workflow)
 *
 * Endpoints:
 *   POST /credits/balance          — get credit balance for a client ID
 *   POST /credits/consume          — consume one credit
 *   POST /crypto/quote             — generate a payment quote
 *   POST /crypto/verify            — verify a payment arrived
 *   POST /fee/record               — record a sweep's fee receipt (called by client)
 *   GET  /fee/pending              — list unforwarded fee receipts
 *   POST /fee/mark-forwarded       — mark a receipt as forwarded (called by operator)
 *   GET  /fee/summary              — aggregate totals (called by operator)
 *   GET  /health                   — health check
 *
 * Required secrets:
 *   CRYPTO_ADDRESS_BASE, CRYPTO_ADDRESS_ETH, CRYPTO_ADDRESS_SOL, CRYPTO_ADDRESS_BTC
 *   BASESCAN_API_KEY, ETHERSCAN_API_KEY, HELIUS_API_KEY
 *   OPERATOR_SECRET                — a shared secret for /fee/mark-forwarded and /fee/summary
 *
 * KV namespaces:
 *   CREDITS           — client_id → { balance, history }
 *   PENDING_PAYMENTS  — payment_id → { expected, address, credits, ... }
 */

const PRICE_USD_CENTS = 500;

const BUNDLES = {
  'pack-1':  { credits: 1,  priceCents: 1000 },
  'pack-5':  { credits: 5,  priceCents: 2000 },
  'pack-10': { credits: 10, priceCents: 4000 },
  'pack-25': { credits: 25, priceCents: 8000 },
  'pack-50': { credits: 50, priceCents: 15000 },
};

const USDC_ADDRESSES = {
  base:     '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
  ethereum: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
};

const METHODS = {
  'usdc-base':     { chain: 'base',     token: 'USDC', decimals: 6, envAddress: 'CRYPTO_ADDRESS_BASE' },
  'eth-base':      { chain: 'base',     token: 'ETH',  decimals: 18, envAddress: 'CRYPTO_ADDRESS_BASE' },
  'usdc-ethereum': { chain: 'ethereum', token: 'USDC', decimals: 6, envAddress: 'CRYPTO_ADDRESS_ETH' },
  'sol':           { chain: 'solana',   token: 'SOL',  decimals: 9, envAddress: 'CRYPTO_ADDRESS_SOL' },
  'btc':           { chain: 'bitcoin',  token: 'BTC',  decimals: 8, envAddress: 'CRYPTO_ADDRESS_BTC' },
};

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, X-Operator-Secret',
};

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: CORS });
    }

    try {
      if (url.pathname === '/health') {
        return json({ ok: true, time: new Date().toISOString() });
      }

      // ---- Credits ----
      if (url.pathname === '/credits/balance' && request.method === 'POST') {
        return await handleBalance(request, env);
      }
      if (url.pathname === '/credits/consume' && request.method === 'POST') {
        return await handleConsume(request, env);
      }

      // ---- Crypto payments ----
      if (url.pathname === '/crypto/quote' && request.method === 'POST') {
        return await handleQuote(request, env);
      }
      if (url.pathname === '/crypto/verify' && request.method === 'POST') {
        return await handleVerify(request, env);
      }

      // ---- Fee tracking ----
      if (url.pathname === '/fee/record' && request.method === 'POST') {
        return await handleFeeRecord(request, env);
      }
      if (url.pathname === '/fee/pending' && request.method === 'GET') {
        return await handleFeePending(request, env);
      }
      if (url.pathname === '/fee/mark-forwarded' && request.method === 'POST') {
        return await handleFeeMarkForwarded(request, env);
      }
      if (url.pathname === '/fee/summary' && request.method === 'GET') {
        return await handleFeeSummary(request, env);
      }

      return json({ error: 'not found' }, 404);
    } catch (err) {
      console.error('Worker error:', err);
      return json({ error: err.message || 'internal error' }, 500);
    }
  },
};

// =====================================================================
// CREDITS
// =====================================================================

async function handleBalance(request, env) {
  const { clientId } = await request.json();
  if (!clientId) return json({ error: 'clientId required' }, 400);
  const balance = await getBalance(env, clientId);
  return json({ clientId, balance });
}

async function handleConsume(request, env) {
  const { clientId, reason } = await request.json();
  if (!clientId) return json({ error: 'clientId required' }, 400);

  const balance = await getBalance(env, clientId);
  if (balance < 1) return json({ error: 'insufficient credits', balance }, 402);

  const newBalance = await addCredits(env, clientId, -1, {
    type: 'consume',
    reason: reason || 'sweep',
  });

  return json({ ok: true, consumed: 1, newBalance });
}

async function getBalance(env, clientId) {
  const raw = await env.CREDITS.get(`balance:${clientId}`);
  return raw ? parseInt(raw, 10) : 0;
}

async function addCredits(env, clientId, delta, metadata = {}) {
  const current = await getBalance(env, clientId);
  const next = current + delta;

  await env.CREDITS.put(`balance:${clientId}`, next.toString());

  const historyRaw = await env.CREDITS.get(`history:${clientId}`);
  const history = historyRaw ? JSON.parse(historyRaw) : [];
  history.unshift({ delta, balance: next, at: new Date().toISOString(), ...metadata });
  await env.CREDITS.put(`history:${clientId}`, JSON.stringify(history.slice(0, 50)));

  return next;
}

// =====================================================================
// CRYPTO — QUOTE
// =====================================================================

async function handleQuote(request, env) {
  const { clientId, bundle = 'pack-5', method = 'usdc-base' } = await request.json();

  if (!clientId || typeof clientId !== 'string' || clientId.length < 16) {
    return json({ error: 'clientId required (min 16 chars)' }, 400);
  }
  const bundleConfig = BUNDLES[bundle];
  if (!bundleConfig) return json({ error: `unknown bundle: ${bundle}` }, 400);

  const methodConfig = METHODS[method];
  if (!methodConfig) return json({ error: `unknown method: ${method}` }, 400);

  const address = env[methodConfig.envAddress];
  if (!address) return json({ error: `address not configured for ${method}` }, 500);

  const rate = await getRate(methodConfig);
  if (!rate) return json({ error: 'could not fetch exchange rate' }, 502);

  const usdAmount = bundleConfig.priceCents / 100;
  const cryptoAmount = usdAmount / rate.price;
  const cryptoAmountRaw = BigInt(Math.round(cryptoAmount * Math.pow(10, rate.decimals)));

  const uniqueSuffix = BigInt(Math.floor(Math.random() * 10000));
  const finalRaw = cryptoAmountRaw + uniqueSuffix;

  const paymentId = crypto.randomUUID();
  const expiresAt = new Date(Date.now() + 30 * 60 * 1000).toISOString();

  await env.PENDING_PAYMENTS.put(
    `crypto:${paymentId}`,
    JSON.stringify({
      method,
      chain: methodConfig.chain,
      token: methodConfig.token,
      clientId,
      bundle,
      credits: bundleConfig.credits,
      expectedRaw: finalRaw.toString(),
      decimals: rate.decimals,
      address,
      expiresAt,
      createdAt: new Date().toISOString(),
    }),
    { expirationTtl: 60 * 60 }
  );

  return json({
    payment_id: paymentId,
    chain: methodConfig.chain,
    token: methodConfig.token,
    address,
    amount: Number(finalRaw) / Math.pow(10, rate.decimals),
    amount_raw: finalRaw.toString(),
    decimals: rate.decimals,
    usd_price: usdAmount,
    credits: bundleConfig.credits,
    expires_at: expiresAt,
  });
}

async function getRate(methodConfig) {
  if (methodConfig.token === 'USDC') {
    return { price: 1.0, decimals: methodConfig.decimals };
  }

  const coinIds = { 'ETH': 'ethereum', 'SOL': 'solana', 'BTC': 'bitcoin' };
  const id = coinIds[methodConfig.token];
  if (!id) return null;

  try {
    const resp = await fetch(
      `https://api.coingecko.com/api/v3/simple/price?ids=${id}&vs_currencies=usd`
    );
    const data = await resp.json();
    const price = data[id]?.usd;
    if (!price) return null;
    return { price, decimals: methodConfig.decimals };
  } catch {
    return null;
  }
}

// =====================================================================
// CRYPTO — VERIFY
// =====================================================================

async function handleVerify(request, env) {
  const { payment_id } = await request.json();
  if (!payment_id) return json({ error: 'payment_id required' }, 400);

  const pendingRaw = await env.PENDING_PAYMENTS.get(`crypto:${payment_id}`);
  if (!pendingRaw) return json({ error: 'payment not found or expired' }, 404);

  const pending = JSON.parse(pendingRaw);

  if (pending.verified) {
    return json({ ok: true, alreadyVerified: true, credits: pending.credits });
  }

  if (new Date(pending.expiresAt) < new Date()) {
    return json({ error: 'payment expired' }, 410);
  }

  const found = await scanForPayment(env, pending);
  if (!found) {
    return json({ status: 'pending', message: 'No matching transaction found yet' });
  }

  const balance = await addCredits(env, pending.clientId, pending.credits, {
    type: 'crypto',
    method: pending.method,
    chain: pending.chain,
    token: pending.token,
    txHash: found.txHash,
    credits: pending.credits,
  });

  pending.verified = true;
  pending.txHash = found.txHash;
  await env.PENDING_PAYMENTS.put(`crypto:${payment_id}`, JSON.stringify(pending), {
    expirationTtl: 60 * 60 * 24 * 7,
  });

  return json({
    ok: true,
    creditsAdded: pending.credits,
    newBalance: balance,
    txHash: found.txHash,
  });
}

async function scanForPayment(env, pending) {
  const { chain, token, address, expectedRaw } = pending;
  if (chain === 'base' || chain === 'ethereum') {
    return await scanEvmChain(env, chain, token, address, expectedRaw);
  }
  if (chain === 'solana') return await scanSolana(env, address, expectedRaw);
  if (chain === 'bitcoin') return await scanBitcoin(env, address, expectedRaw);
  return null;
}

async function scanEvmChain(env, chain, token, address, expectedRaw) {
  const apiKey = chain === 'base' ? env.BASESCAN_API_KEY : env.ETHERSCAN_API_KEY;
  const baseUrl = chain === 'base'
    ? 'https://api.basescan.org/api'
    : 'https://api.etherscan.io/api';

  if (token === 'USDC') {
    const usdcAddress = USDC_ADDRESSES[chain];
    const url = `${baseUrl}?module=account&action=tokentx&contractaddress=${usdcAddress}&address=${address}&sort=desc&apikey=${apiKey}`;
    const resp = await fetch(url);
    const data = await resp.json();
    if (!data.result || !Array.isArray(data.result)) return null;

    for (const tx of data.result.slice(0, 20)) {
      if (tx.to?.toLowerCase() === address.toLowerCase() && tx.value === expectedRaw) {
        return { txHash: tx.hash, blockNumber: tx.blockNumber };
      }
    }
  } else if (token === 'ETH') {
    const url = `${baseUrl}?module=account&action=txlist&address=${address}&sort=desc&apikey=${apiKey}`;
    const resp = await fetch(url);
    const data = await resp.json();
    if (!data.result || !Array.isArray(data.result)) return null;

    for (const tx of data.result.slice(0, 20)) {
      if (tx.to?.toLowerCase() === address.toLowerCase() && tx.value === expectedRaw) {
        return { txHash: tx.hash, blockNumber: tx.blockNumber };
      }
    }
  }

  return null;
}

async function scanSolana(env, address, expectedRaw) {
  const resp = await fetch(
    `https://api.helius.xyz/v0/addresses/${address}/transactions?api-key=${env.HELIUS_API_KEY}&limit=20`
  );
  if (!resp.ok) return null;

  const txs = await resp.json();
  if (!Array.isArray(txs)) return null;

  const expected = BigInt(expectedRaw);

  for (const tx of txs) {
    const transfers = tx.nativeTransfers || [];
    for (const t of transfers) {
      if (t.toUserAccount === address && BigInt(t.amount) === expected) {
        return { txHash: tx.signature };
      }
    }
  }

  return null;
}

async function scanBitcoin(env, address, expectedRaw) {
  const resp = await fetch(`https://mempool.space/api/address/${address}/txs`);
  if (!resp.ok) return null;

  const txs = await resp.json();
  if (!Array.isArray(txs)) return null;

  const expected = parseInt(expectedRaw, 10);

  for (const tx of txs.slice(0, 20)) {
    for (const vout of tx.vout || []) {
      if (vout.scriptpubkey_address === address && vout.value === expected) {
        return { txHash: tx.txid };
      }
    }
  }

  return null;
}

// =====================================================================
// FEE TRACKING
// =====================================================================
//
// When a sweep completes, the client calls /fee/record with the details
// of what landed in the fee wallets. The worker stores them in KV with
// status "pending". The operator (you) later calls /fee/pending to see
// what's outstanding, sends the 90% manually from the fee wallet, then
// calls /fee/mark-forwarded to close it out.
//
// KV keys:
//   fee:sweep:<sweep_id>       → full receipt JSON
//   fee:pending                → array of sweep_ids (for fast listing)
//   fee:forwarded:<sweep_id>   → same receipt, moved here after forwarding
// =====================================================================

/**
 * POST /fee/record
 * Body:
 *   {
 *     clientId:     string,   // the pseudonymous client ID
 *     receipts:     [         // one entry per family/chain
 *       {
 *         family:    'evm' | 'solana' | 'bitcoin',
 *         chain?:    string,   // e.g. 'base', 'arbitrum' (only for EVM)
 *         amountRaw: string,   // raw units (wei, sats, etc.)
 *         decimals:  number,   // 6 for USDC, 18 for BNB USDC, 8 for BTC
 *         symbol:    string,   // 'USDC' or 'BTC'
 *         recipient: string,   // the fee wallet address
 *         userDestination: string, // where the 90% should go
 *       },
 *       ...
 *     ],
 *     sweepDurationMs: number,
 *     successes:    number,
 *     failures:     number,
 *   }
 */
async function handleFeeRecord(request, env) {
  const body = await request.json();
  const { clientId, receipts, sweepDurationMs, successes, failures } = body;

  if (!clientId) return json({ error: 'clientId required' }, 400);
  if (!Array.isArray(receipts) || receipts.length === 0) {
    return json({ error: 'receipts required (non-empty array)' }, 400);
  }

  const sweepId = crypto.randomUUID();
  const record = {
    sweepId,
    clientId,
    receipts,
    sweepDurationMs: sweepDurationMs || 0,
    successes: successes || 0,
    failures: failures || 0,
    status: 'pending',
    recordedAt: new Date().toISOString(),
    forwardedAt: null,
    forwardedTxHashes: null,
  };

  // Store the receipt
  await env.CREDITS.put(`fee:sweep:${sweepId}`, JSON.stringify(record));

  // Append to the pending index
  const pendingRaw = await env.CREDITS.get('fee:pending');
  const pending = pendingRaw ? JSON.parse(pendingRaw) : [];
  pending.unshift(sweepId);
  await env.CREDITS.put('fee:pending', JSON.stringify(pending));

  return json({ ok: true, sweepId, status: 'pending' });
}

/**
 * GET /fee/pending
 * Optional query params:
 *   ?limit=N  (default 100)
 *
 * Returns the list of pending receipts.
 * Requires the X-Operator-Secret header to match env.OPERATOR_SECRET.
 */
async function handleFeePending(request, env) {
  requireOperator(request, env);

  const url = new URL(request.url);
  const limit = parseInt(url.searchParams.get('limit') || '100', 10);

  const pendingRaw = await env.CREDITS.get('fee:pending');
  const pendingIds = pendingRaw ? JSON.parse(pendingRaw) : [];

  const items = [];
  for (const id of pendingIds.slice(0, limit)) {
    const raw = await env.CREDITS.get(`fee:sweep:${id}`);
    if (!raw) continue;
    try {
      items.push(JSON.parse(raw));
    } catch {}
  }

  return json({
    ok: true,
    count: items.length,
    totalPending: pendingIds.length,
    items,
  });
}

/**
 * POST /fee/mark-forwarded
 * Body:
 *   {
 *     sweepId: string,
 *     txHashes: [string],   // optional — tx hashes of the 90% sends you did manually
 *     note: string,          // optional — e.g. "sent via MetaMask"
 *   }
 *
 * Marks a receipt as forwarded. Removes it from the pending index and
 * moves it to the forwarded archive.
 * Requires the X-Operator-Secret header.
 */
async function handleFeeMarkForwarded(request, env) {
  requireOperator(request, env);

  const body = await request.json();
  const { sweepId, txHashes, note } = body;
  if (!sweepId) return json({ error: 'sweepId required' }, 400);

  const raw = await env.CREDITS.get(`fee:sweep:${sweepId}`);
  if (!raw) return json({ error: 'sweep not found' }, 404);

  const record = JSON.parse(raw);
  if (record.status === 'forwarded') {
    return json({ ok: true, alreadyForwarded: true, record });
  }

  record.status = 'forwarded';
  record.forwardedAt = new Date().toISOString();
  record.forwardedTxHashes = txHashes || null;
  record.forwardedNote = note || null;

  // Write to the forwarded archive (kept for 1 year)
  await env.CREDITS.put(`fee:forwarded:${sweepId}`, JSON.stringify(record), {
    expirationTtl: 60 * 60 * 24 * 365,
  });

  // Remove from pending index
  const pendingRaw = await env.CREDITS.get('fee:pending');
  const pending = pendingRaw ? JSON.parse(pendingRaw) : [];
  const filtered = pending.filter((id) => id !== sweepId);
  await env.CREDITS.put('fee:pending', JSON.stringify(filtered));

  // Delete the active record (it lives in the archive now)
  await env.CREDITS.delete(`fee:sweep:${sweepId}`);

  return json({ ok: true, sweepId, status: 'forwarded', record });
}

/**
 * GET /fee/summary
 * Returns aggregate totals across all time:
 *   - Total pending sweeps
 *   - Total fee amounts pending (per family/chain)
 *   - Total forwarded sweeps
 *
 * Requires X-Operator-Secret.
 */
async function handleFeeSummary(request, env) {
  requireOperator(request, env);

  const pendingRaw = await env.CREDITS.get('fee:pending');
  const pendingIds = pendingRaw ? JSON.parse(pendingRaw) : [];

  const totalsByChain = {};
  let totalPendingSweeps = 0;

  for (const id of pendingIds) {
    const raw = await env.CREDITS.get(`fee:sweep:${id}`);
    if (!raw) continue;
    let record;
    try { record = JSON.parse(raw); } catch { continue; }
    totalPendingSweeps++;

    for (const r of record.receipts || []) {
      const key = r.family === 'evm' ? `evm:${r.chain}` : r.family;
      if (!totalsByChain[key]) {
        totalsByChain[key] = { symbol: r.symbol, decimals: r.decimals, raw: 0n, count: 0 };
      }
      totalsByChain[key].raw += BigInt(r.amountRaw);
      totalsByChain[key].count += 1;
    }
  }

  // Convert BigInt to string for JSON
  const totals = {};
  for (const [key, v] of Object.entries(totalsByChain)) {
    totals[key] = {
      symbol: v.symbol,
      decimals: v.decimals,
      amount: Number(v.raw) / Math.pow(10, v.decimals),
      amountRaw: v.raw.toString(),
      count: v.count,
    };
  }

  return json({
    ok: true,
    totalPendingSweeps,
    totals,
  });
}

/**
 * Verify the request carries the correct X-Operator-Secret header.
 * Throws if not.
 */
function requireOperator(request, env) {
  const provided = request.headers.get('X-Operator-Secret') || '';
  const expected = env.OPERATOR_SECRET || '';
  if (!expected) throw new Error('OPERATOR_SECRET not configured on the worker');
  if (provided !== expected) {
    const err = new Error('unauthorized');
    err.status = 401;
    throw err;
  }
}

// =====================================================================
// HELPERS
// =====================================================================

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS },
  });
}