/**
 * payment-worker.js — Cloudflare Worker
 * =====================================================================
 * Endpoints:
 *   POST /square/checkout    — create a Square payment link
 *   POST /square/verify      — verify a completed Square order, issue credits
 *   POST /crypto/quote       — generate a payment address + amount for crypto
 *   POST /crypto/verify      — check if crypto payment arrived, issue credits
 *   POST /credits/balance    — get credit balance for a client ID
 *   POST /credits/consume    — consume one credit (called before a sweep)
 *   GET  /health             — health check
 *
 * Pricing:
 *   One credit = one sweep = $5 (configurable via PRICE_USD_CENTS)
 *   Bundles: 5 credits = $22.50, 10 credits = $40 (volume discounts)
 *
 * Crypto accepted (all bridged to a single receiving address):
 *   - USDC on Base      (preferred — cheap, fast)
 *   - USDC on Ethereum  (expensive but standard)
 *   - ETH on Base
 *   - SOL on Solana
 *   - BTC on Bitcoin
 *
 * Required secrets:
 *   SQUARE_ACCESS_TOKEN
 *   SQUARE_LOCATION_ID
 *   CLIENT_ID_PEPPER         — random string, hashes client IDs
 *   CRYPTO_ADDRESS_BASE      — 0x... receiving address on Base
 *   CRYPTO_ADDRESS_ETH       — 0x... receiving address on Ethereum
 *   CRYPTO_ADDRESS_SOL       — base58 receiving address on Solana
 *   CRYPTO_ADDRESS_BTC       — bc1q... receiving address on Bitcoin
 *   BASESCAN_API_KEY         — for verifying Base USDC/ETH payments
 *   ETHERSCAN_API_KEY        — for verifying Ethereum payments
 *   HELIUS_API_KEY           — for verifying Solana payments
 *   MEMPOOL_API_URL          — usually https://mempool.space/api
 *
 * KV namespaces:
 *   CREDITS             — client_id → { balance, history[] }
 *   PENDING_PAYMENTS    — payment_id → { method, expected, received, credits }
 */

// =====================================================================
// CONFIG
// =====================================================================

const PRICE_USD_CENTS = 500; // $5.00 per sweep

const BUNDLES = {
  'single':    { credits: 1,  priceCents: 500 },   // $5.00
  'pack-5':    { credits: 5,  priceCents: 2250 },  // $4.50 each
  'pack-10':   { credits: 10, priceCents: 4000 },  // $4.00 each
};

// Where crypto payments get sent (you own these)
const CRYPTO_ADDRESSES = {
  'usdc-base':     { chain: 'base',     token: 'USDC', envKey: 'CRYPTO_ADDRESS_BASE' },
  'usdc-ethereum': { chain: 'ethereum', token: 'USDC', envKey: 'CRYPTO_ADDRESS_ETH'  },
  'eth-base':      { chain: 'base',     token: 'ETH',  envKey: 'CRYPTO_ADDRESS_BASE' },
  'sol':           { chain: 'solana',   token: 'SOL',  envKey: 'CRYPTO_ADDRESS_SOL'  },
  'btc':           { chain: 'bitcoin',  token: 'BTC',  envKey: 'CRYPTO_ADDRESS_BTC'  },
};

const SQUARE_API = 'https://connect.squareup.com';
const SQUARE_VERSION = '2024-08-21';

const USDC_ADDRESSES = {
  base:     '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
  ethereum: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
};

// =====================================================================
// ROUTER
// =====================================================================

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    const cors = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    };

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: cors });
    }

    try {
      if (path === '/health') {
        return json({ ok: true, time: new Date().toISOString() }, 200, cors);
      }
      if (path === '/square/checkout' && request.method === 'POST') {
        return await handleSquareCheckout(request, env, cors);
      }
      if (path === '/square/verify' && request.method === 'POST') {
        return await handleSquareVerify(request, env, cors);
      }
      if (path === '/crypto/quote' && request.method === 'POST') {
        return await handleCryptoQuote(request, env, cors);
      }
      if (path === '/crypto/verify' && request.method === 'POST') {
        return await handleCryptoVerify(request, env, cors);
      }
      if (path === '/credits/balance' && request.method === 'POST') {
        return await handleCreditsBalance(request, env, cors);
      }
      if (path === '/credits/consume' && request.method === 'POST') {
        return await handleCreditsConsume(request, env, cors);
      }

      return json({ error: 'not found' }, 404, cors);
    } catch (err) {
      console.error('Worker error:', err);
      return json({ error: err.message || 'internal error' }, 500, cors);
    }
  },
};

// =====================================================================
// SQUARE CHECKOUT
// =====================================================================

async function handleSquareCheckout(request, env, cors) {
  const body = await request.json();
  const { bundle = 'single', clientId } = body;

  if (!clientId || typeof clientId !== 'string' || clientId.length < 16) {
    return json({ error: 'clientId required (min 16 chars)' }, 400, cors);
  }

  const bundleConfig = BUNDLES[bundle];
  if (!bundleConfig) {
    return json({ error: `unknown bundle: ${bundle}` }, 400, cors);
  }

  // Include clientId in redirect so we can credit the right account
  const redirectUrl = `https://sweep.yourdomain.com/checkout-complete.html?clientId=${encodeURIComponent(clientId)}`;

  const squareBody = {
    idempotency_key: crypto.randomUUID(),
    quick_pay: {
      name: `Sweep — ${bundleConfig.credits} sweep credit${bundleConfig.credits > 1 ? 's' : ''}`,
      price_money: {
        amount: bundleConfig.priceCents,
        currency: 'USD',
      },
      location_id: env.SQUARE_LOCATION_ID,
    },
    checkout_options: {
      redirect_url: redirectUrl,
      ask_for_shipping_address: false,
    },
  };

  const resp = await fetch(`${SQUARE_API}/v2/online-checkout/payment-links`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${env.SQUARE_ACCESS_TOKEN}`,
      'Content-Type': 'application/json',
      'Square-Version': SQUARE_VERSION,
    },
    body: JSON.stringify(squareBody),
  });

  const data = await resp.json();
  if (!resp.ok) {
    console.error('Square API error:', JSON.stringify(data));
    return json({ error: 'Square API error', details: data.errors }, 400, cors);
  }

  // Record the pending payment
  await env.PENDING_PAYMENTS.put(
    `square:${data.payment_link.order_id}`,
    JSON.stringify({
      method: 'square',
      clientId,
      bundle,
      credits: bundleConfig.credits,
      priceCents: bundleConfig.priceCents,
      orderId: data.payment_link.order_id,
      createdAt: new Date().toISOString(),
    }),
    { expirationTtl: 60 * 60 * 24 } // 24h expiry
  );

  return json({
    url: data.payment_link.url,
    order_id: data.payment_link.order_id,
    bundle,
    credits: bundleConfig.credits,
  }, 200, cors);
}

async function handleSquareVerify(request, env, cors) {
  const { orderId, clientId } = await request.json();

  if (!orderId || !clientId) {
    return json({ error: 'orderId and clientId required' }, 400, cors);
  }

  // Check if we already issued credits for this order
  const existing = await env.CREDITS.get(`order:${orderId}`);
  if (existing) {
    return json({ ok: true, alreadyIssued: true, credits: parseInt(existing, 10) }, 200, cors);
  }

  // Fetch the pending payment record
  const pendingRaw = await env.PENDING_PAYMENTS.get(`square:${orderId}`);
  if (!pendingRaw) {
    return json({ error: 'Order not found or expired' }, 404, cors);
  }
  const pending = JSON.parse(pendingRaw);

  // Security: clientId must match what was recorded at checkout
  if (pending.clientId !== clientId) {
    return json({ error: 'clientId mismatch' }, 403, cors);
  }

  // Fetch order from Square
  const orderResp = await fetch(`${SQUARE_API}/v2/orders/${orderId}`, {
    method: 'GET',
    headers: {
      'Authorization': `Bearer ${env.SQUARE_ACCESS_TOKEN}`,
      'Square-Version': SQUARE_VERSION,
    },
  });
  const orderData = await orderResp.json();

  if (!orderResp.ok) {
    return json({ error: 'Could not fetch order', details: orderData.errors }, 400, cors);
  }

  const order = orderData.order;
  if (!order || order.state !== 'COMPLETED') {
    return json({ error: `Order not completed (state: ${order?.state || 'unknown'})` }, 400, cors);
  }

  // Credit the user
  const balance = await addCredits(env, clientId, pending.credits, {
    type: 'square',
    orderId,
    amountCents: pending.priceCents,
    credits: pending.credits,
  });

  // Mark order as issued
  await env.CREDITS.put(`order:${orderId}`, pending.credits.toString(), {
    expirationTtl: 60 * 60 * 24 * 365, // keep for a year
  });

  return json({
    ok: true,
    creditsAdded: pending.credits,
    newBalance: balance,
  }, 200, cors);
}

// =====================================================================
// CRYPTO PAYMENTS
// =====================================================================

/**
 * Generate a crypto payment quote.
 *
 * The client sends: { clientId, bundle, method }
 * We return: { payment_id, address, amount, amount_raw, expires_at, chain, token }
 *
 * The client then shows the address + amount to the user. When the user pays,
 * the client calls /crypto/verify with the tx hash (or the worker checks
 * automatically if we implement a polling loop).
 */
async function handleCryptoQuote(request, env, cors) {
  const { clientId, bundle = 'single', method = 'usdc-base' } = await request.json();

  if (!clientId || typeof clientId !== 'string' || clientId.length < 16) {
    return json({ error: 'clientId required' }, 400, cors);
  }

  const bundleConfig = BUNDLES[bundle];
  if (!bundleConfig) {
    return json({ error: `unknown bundle: ${bundle}` }, 400, cors);
  }

  const cryptoConfig = CRYPTO_ADDRESSES[method];
  if (!cryptoConfig) {
    return json({ error: `unknown crypto method: ${method}` }, 400, cors);
  }

  const address = env[cryptoConfig.envKey];
  if (!address) {
    return json({ error: `crypto address not configured for ${method}` }, 500, cors);
  }

  // Generate a unique payment ID with a small random amount suffix
  // This lets us identify which payment corresponds to which user
  const paymentId = crypto.randomUUID();

  // Fetch USD → crypto exchange rate
  const rate = await getCryptoRate(cryptoConfig.chain, cryptoConfig.token);
  if (!rate) {
    return json({ error: 'could not fetch exchange rate' }, 502, cors);
  }

  const usdAmount = bundleConfig.priceCents / 100;
  const cryptoAmount = usdAmount / rate.price;
  const cryptoAmountRaw = BigInt(Math.round(cryptoAmount * Math.pow(10, rate.decimals)));

  // Add a tiny unique suffix so we can match the exact tx
  // e.g., 5.00012345 USDC instead of 5.00000000
  const uniqueSuffix = BigInt(Math.floor(Math.random() * 10000)); // 0-9999
  const finalRaw = cryptoAmountRaw + uniqueSuffix;

  const expiresAt = new Date(Date.now() + 30 * 60 * 1000).toISOString(); // 30 min

  await env.PENDING_PAYMENTS.put(
    `crypto:${paymentId}`,
    JSON.stringify({
      method,
      chain: cryptoConfig.chain,
      token: cryptoConfig.token,
      clientId,
      bundle,
      credits: bundleConfig.credits,
      expectedRaw: finalRaw.toString(),
      address,
      expiresAt,
      createdAt: new Date().toISOString(),
    }),
    { expirationTtl: 60 * 60 } // 1h expiry
  );

  return json({
    payment_id: paymentId,
    chain: cryptoConfig.chain,
    token: cryptoConfig.token,
    address,
    amount: Number(finalRaw) / Math.pow(10, rate.decimals),
    amount_raw: finalRaw.toString(),
    decimals: rate.decimals,
    usd_price: usdAmount,
    credits: bundleConfig.credits,
    expires_at: expiresAt,
  }, 200, cors);
}

/**
 * Verify a crypto payment.
 *
 * The client sends: { payment_id }
 * We look up the pending payment, scan the chain for a matching tx,
 * and if found, credit the account.
 *
 * For UX, the client should poll this endpoint every 5s after the user
 * claims to have paid.
 */
async function handleCryptoVerify(request, env, cors) {
  const { payment_id } = await request.json();

  if (!payment_id) {
    return json({ error: 'payment_id required' }, 400, cors);
  }

  const pendingRaw = await env.PENDING_PAYMENTS.get(`crypto:${payment_id}`);
  if (!pendingRaw) {
    return json({ error: 'payment not found or expired' }, 404, cors);
  }
  const pending = JSON.parse(pendingRaw);

  // Check if we already verified this payment
  if (pending.verified) {
    return json({ ok: true, alreadyVerified: true, credits: pending.credits }, 200, cors);
  }

  // Check expiry
  if (new Date(pending.expiresAt) < new Date()) {
    return json({ error: 'payment expired' }, 410, cors);
  }

  // Scan the chain for the expected amount
  const found = await scanForPayment(env, pending);
  if (!found) {
    return json({ status: 'pending', message: 'No matching transaction found yet' }, 200, cors);
  }

  // Credit the user
  const balance = await addCredits(env, pending.clientId, pending.credits, {
    type: 'crypto',
    method: pending.method,
    chain: pending.chain,
    token: pending.token,
    txHash: found.txHash,
    credits: pending.credits,
  });

  // Mark as verified
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
  }, 200, cors);
}

/**
 * Scan the chain for a matching incoming payment.
 * Uses public block explorer APIs (Basescan, Etherscan, Helius, mempool.space).
 */
async function scanForPayment(env, pending) {
  const { chain, token, address, expectedRaw } = pending;

  if (chain === 'base' || chain === 'ethereum') {
    return await scanEvmChain(env, chain, token, address, expectedRaw);
  }
  if (chain === 'solana') {
    return await scanSolana(env, address, expectedRaw);
  }
  if (chain === 'bitcoin') {
    return await scanBitcoin(env, address, expectedRaw);
  }
  return null;
}

async function scanEvmChain(env, chain, token, address, expectedRaw) {
  const apiKey = chain === 'base' ? env.BASESCAN_API_KEY : env.ETHERSCAN_API_KEY;
  const baseUrl = chain === 'base'
    ? 'https://api.basescan.org/api'
    : 'https://api.etherscan.io/api';

  if (token === 'USDC') {
    const usdcAddress = USDC_ADDRESSES[chain];
    // Get recent ERC-20 transfers to this address
    const url = `${baseUrl}?module=account&action=tokentx&contractaddress=${usdcAddress}&address=${address}&sort=desc&apikey=${apiKey}`;
    const resp = await fetch(url);
    const data = await resp.json();

    if (!data.result || !Array.isArray(data.result)) return null;

    for (const tx of data.result.slice(0, 20)) {
      if (tx.to.toLowerCase() === address.toLowerCase() && tx.value === expectedRaw) {
        return { txHash: tx.hash, blockNumber: tx.blockNumber };
      }
    }
  } else if (token === 'ETH') {
    // Get recent normal transactions
    const url = `${baseUrl}?module=account&action=txlist&address=${address}&sort=desc&apikey=${apiKey}`;
    const resp = await fetch(url);
    const data = await resp.json();

    if (!data.result || !Array.isArray(data.result)) return null;

    for (const tx of data.result.slice(0, 20)) {
      if (tx.to.toLowerCase() === address.toLowerCase() && tx.value === expectedRaw) {
        return { txHash: tx.hash, blockNumber: tx.blockNumber };
      }
    }
  }

  return null;
}

async function scanSolana(env, address, expectedRaw) {
  const resp = await fetch(`https://api.helius.xyz/v0/addresses/${address}/transactions?api-key=${env.HELIUS_API_KEY}&limit=20`);
  if (!resp.ok) return null;

  const txs = await resp.json();
  if (!Array.isArray(txs)) return null;

  const expected = BigInt(expectedRaw);

  for (const tx of txs) {
    // Look for transfers to our address with the expected lamport amount
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
    const status = tx.status || {};
    if (!status.confirmed) continue;

    for (const vout of tx.vout || []) {
      if (vout.scriptpubkey_address === address && vout.value === expected) {
        return { txHash: tx.txid };
      }
    }
  }

  return null;
}

async function getCryptoRate(chain, token) {
  // Use CoinGecko's simple price API
  const coinIds = {
    'usdc-base': 'usd-coin',
    'usdc-ethereum': 'usd-coin',
    'eth-base': 'ethereum',
    'sol': 'solana',
    'btc': 'bitcoin',
  };
  const key = `${token.toLowerCase()}-${chain}`;
  const id = coinIds[key];

  if (token === 'USDC') {
    return { price: 1.0, decimals: 6 };
  }

  if (!id) return null;

  try {
    const resp = await fetch(`https://api.coingecko.com/api/v3/simple/price?ids=${id}&vs_currencies=usd`);
    const data = await resp.json();
    const price = data[id]?.usd;
    if (!price) return null;

    const decimals = token === 'BTC' ? 8 : token === 'SOL' ? 9 : 18;
    return { price, decimals };
  } catch {
    return null;
  }
}

// =====================================================================
// CREDITS
// =====================================================================

async function handleCreditsBalance(request, env, cors) {
  const { clientId } = await request.json();
  if (!clientId) return json({ error: 'clientId required' }, 400, cors);

  const balance = await getCredits(env, clientId);
  return json({ clientId, balance }, 200, cors);
}

async function handleCreditsConsume(request, env, cors) {
  const { clientId, reason } = await request.json();
  if (!clientId) return json({ error: 'clientId required' }, 400, cors);

  const balance = await getCredits(env, clientId);
  if (balance < 1) {
    return json({ error: 'insufficient credits', balance }, 402, cors);
  }

  const newBalance = await addCredits(env, clientId, -1, {
    type: 'consume',
    reason: reason || 'sweep',
  });

  return json({ ok: true, consumed: 1, newBalance }, 200, cors);
}

async function getCredits(env, clientId) {
  const raw = await env.CREDITS.get(`balance:${clientId}`);
  return raw ? parseInt(raw, 10) : 0;
}

async function addCredits(env, clientId, delta, metadata = {}) {
  const current = await getCredits(env, clientId);
  const next = current + delta;

  await env.CREDITS.put(`balance:${clientId}`, next.toString());

  // Append to history
  const historyRaw = await env.CREDITS.get(`history:${clientId}`);
  const history = historyRaw ? JSON.parse(historyRaw) : [];
  history.unshift({
    delta,
    balance: next,
    at: new Date().toISOString(),
    ...metadata,
  });
  // Keep last 50 entries
  await env.CREDITS.put(`history:${clientId}`, JSON.stringify(history.slice(0, 50)));

  return next;
}

// =====================================================================
// HELPERS
// =====================================================================

function json(data, status, cors) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...cors },
  });
}