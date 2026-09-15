/**
 * payment-worker.js — Crypto payments for Sweep
 * =====================================================================
 * Handles manual crypto payments: user sends to your address, worker
 * scans the chain, credits are added when the payment is confirmed.
 *
 * Endpoints:
 *   POST /credits/balance    — get credit balance for a client ID
 *   POST /credits/consume    — consume one credit
 *   POST /crypto/quote       — generate a payment quote (address + amount)
 *   POST /crypto/verify      — check if a payment arrived, issue credits
 *   GET  /health             — health check
 *
 * Required secrets:
 *   CRYPTO_ADDRESS_BASE   — 0x... address on Base (also used for ETH on Base)
 *   CRYPTO_ADDRESS_ETH    — 0x... address on Ethereum
 *   CRYPTO_ADDRESS_SOL    — base58 address on Solana
 *   CRYPTO_ADDRESS_BTC    — bc1q... address on Bitcoin
 *   BASESCAN_API_KEY      — from basescan.org
 *   ETHERSCAN_API_KEY     — from etherscan.io
 *   HELIUS_API_KEY        — from helius.dev
 *
 * KV namespaces:
 *   CREDITS           — client_id → { balance, history }
 *   PENDING_PAYMENTS  — payment_id → { expected, address, credits, ... }
 */

const PRICE_USD_CENTS = 500; // $5.00 per sweep

const BUNDLES = {
  'single':  { credits: 1,  priceCents: 500 },
  'pack-5':  { credits: 5,  priceCents: 2000 },
  'pack-10': { credits: 10, priceCents: 4000 },
  'pack-25': { credits: 25, priceCents: 8000 },
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
  'Access-Control-Allow-Headers': 'Content-Type',
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
      if (url.pathname === '/credits/balance' && request.method === 'POST') {
        return await handleBalance(request, env);
      }
      if (url.pathname === '/credits/consume' && request.method === 'POST') {
        return await handleConsume(request, env);
      }
      if (url.pathname === '/crypto/quote' && request.method === 'POST') {
        return await handleQuote(request, env);
      }
      if (url.pathname === '/crypto/verify' && request.method === 'POST') {
        return await handleVerify(request, env);
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
  const { clientId, bundle = 'single', method = 'usdc-base' } = await request.json();

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

  // Add a unique 4-digit suffix so we can distinguish this payment
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
// HELPERS
// =====================================================================

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS },
  });
}