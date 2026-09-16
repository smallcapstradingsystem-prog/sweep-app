/**
 * payment-worker.js — Cloudflare Worker
 * =====================================================================
 * Endpoints:
 *   POST /crypto/quote       — generate a payment address + amount for crypto
 *   POST /crypto/verify      — check if crypto payment arrived, issue credits
 *   POST /credits/balance    — get credit balance for a client ID
 *   POST /credits/consume    — consume one credit (called before a sweep)
 *   POST /gas/sponsor        — fund a user wallet with native gas
 *   POST /fee/record         — record sweep receipts; accumulate Solana orderIds
 *   GET  /fee/pending        — operator view: pending forwards
 *   GET  /fee/summary        — operator view: totals by chain
 *   POST /fee/mark-forwarded — operator view: mark a sweep forwarded
 *   GET  /health             — health check
 *
 * Required secrets:
 *   CRYPTO_ADDRESS_BASE      — 0x... receiving address on Base
 *   CRYPTO_ADDRESS_ETH       — 0x... receiving address on Ethereum
 *   CRYPTO_ADDRESS_SOL       — base58 receiving address on Solana
 *   CRYPTO_ADDRESS_BTC       — bc1q... receiving address on Bitcoin
 *   BASESCAN_API_KEY
 *   ETHERSCAN_API_KEY
 *   HELIUS_API_KEY
 *   GAS_SPONSOR_KEY          — EVM gas sponsor wallet private key
 *   OPERATOR_SECRET          — password for /fee/* operator endpoints
 *
 * KV namespaces:
 *   CREDITS             — client_id → balance; also fee records + rate limits
 *   PENDING_PAYMENTS    — payment_id → { method, expected, received, credits }
 *   RECEIPTS            — Solana orderIds pending affiliate claim
 */

import { ethers } from 'ethers';

// =====================================================================
// CONFIG
// =====================================================================

const PRICE_USD_CENTS = 500;

const BUNDLES = {
  'single':    { credits: 1,  priceCents: 500 },
  'pack-5':    { credits: 5,  priceCents: 2250 },
  'pack-10':   { credits: 10, priceCents: 4000 },
  'pack-25':   { credits: 25, priceCents: 8000 },
  'pack-50':   { credits: 50, priceCents: 15000 },
};

const METHODS = {
  'usdc-base':     { chain: 'base',     token: 'USDC', decimals: 6,  envAddress: 'CRYPTO_ADDRESS_BASE' },
  'eth-base':      { chain: 'base',     token: 'ETH',  decimals: 18, envAddress: 'CRYPTO_ADDRESS_BASE' },
  'usdc-ethereum': { chain: 'ethereum', token: 'USDC', decimals: 6,  envAddress: 'CRYPTO_ADDRESS_ETH'  },
  'sol':           { chain: 'solana',   token: 'SOL',  decimals: 9,  envAddress: 'CRYPTO_ADDRESS_SOL'  },
  'btc':           { chain: 'bitcoin',  token: 'BTC',  decimals: 8,  envAddress: 'CRYPTO_ADDRESS_BTC'  },
};

const USDC_ADDRESSES = {
  base:     '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
  ethereum: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
};

const SPONSOR_RPC = {
  ethereum: 'https://ethereum-rpc.publicnode.com',
  arbitrum: 'https://arbitrum-one-rpc.publicnode.com',
  optimism: 'https://optimism-rpc.publicnode.com',
  base:     'https://base-rpc.publicnode.com',
  polygon:  'https://polygon-bor-rpc.publicnode.com',
  bnb:      'https://bsc-rpc.publicnode.com',
};

const SPONSOR_MAX_WEI = {
  ethereum: '0.005',
  arbitrum: '0.0005',
  optimism: '0.0005',
  base:     '0.0005',
  polygon:  '0.2',
  bnb:      '0.005',
};

const SPONSOR_RATE_MAX = 20;
const SPONSOR_RATE_WINDOW_MS = 10 * 60 * 1000;

const RECEIPTS_KEY = 'pending_solana_order_ids';
const RECEIPTS_MAX = 5000;

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
      'Access-Control-Allow-Headers': 'Content-Type, X-Operator-Secret',
    };

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: cors });
    }

    try {
      if (path === '/health') return json({ ok: true, time: new Date().toISOString() }, 200, cors);

      if (path === '/crypto/quote'  && request.method === 'POST') return await handleCryptoQuote(request, env, cors);
      if (path === '/crypto/verify' && request.method === 'POST') return await handleCryptoVerify(request, env, cors);

      if (path === '/credits/balance' && request.method === 'POST') return await handleCreditsBalance(request, env, cors);
      if (path === '/credits/consume' && request.method === 'POST') return await handleCreditsConsume(request, env, cors);

      if (path === '/gas/sponsor' && request.method === 'POST') return await handleGasSponsor(request, env, cors);

      if (path === '/fee/record'          && request.method === 'POST') return await handleFeeRecord(request, env, cors);
      if (path === '/fee/pending'         && request.method === 'GET')  return await handleFeePending(request, env, cors);
      if (path === '/fee/mark-forwarded'  && request.method === 'POST') return await handleFeeMarkForwarded(request, env, cors);
      if (path === '/fee/summary'         && request.method === 'GET')  return await handleFeeSummary(request, env, cors);

      return json({ error: 'not found' }, 404, cors);
    } catch (err) {
      if (err.status === 401) return json({ error: 'unauthorized' }, 401, cors);
      console.error('Worker error:', err);
      return json({ error: err.message || 'internal error' }, 500, cors);
    }
  },
};

// =====================================================================
// CRYPTO — QUOTE
// =====================================================================

async function handleCryptoQuote(request, env, cors) {
  const { clientId, bundle = 'single', method = 'usdc-base' } = await request.json();

  if (!clientId || typeof clientId !== 'string' || clientId.length < 16) {
    return json({ error: 'clientId required' }, 400, cors);
  }

  const bundleConfig = BUNDLES[bundle];
  if (!bundleConfig) return json({ error: `unknown bundle: ${bundle}` }, 400, cors);

  const methodConfig = METHODS[method];
  if (!methodConfig) return json({ error: `unknown method: ${method}` }, 400, cors);

  const address = env[methodConfig.envAddress];
  if (!address) return json({ error: `crypto address not configured for ${method}` }, 500, cors);

  const rate = await getCryptoRate(methodConfig);
  if (!rate) return json({ error: 'could not fetch exchange rate' }, 502, cors);

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
  }, 200, cors);
}

async function getCryptoRate(methodConfig) {
  if (methodConfig.token === 'USDC') return { price: 1.0, decimals: methodConfig.decimals };

  const coinIds = { ETH: 'ethereum', SOL: 'solana', BTC: 'bitcoin' };
  const id = coinIds[methodConfig.token];
  if (!id) return null;

  try {
    const resp = await fetch(`https://api.coingecko.com/api/v3/simple/price?ids=${id}&vs_currencies=usd`);
    const data = await resp.json();
    const price = data[id]?.usd;
    if (!price) return null;
    return { price, decimals: methodConfig.decimals };
  } catch { return null; }
}

// =====================================================================
// CRYPTO — VERIFY
// =====================================================================

async function handleCryptoVerify(request, env, cors) {
  const { payment_id } = await request.json();
  if (!payment_id) return json({ error: 'payment_id required' }, 400, cors);

  const pendingRaw = await env.PENDING_PAYMENTS.get(`crypto:${payment_id}`);
  if (!pendingRaw) return json({ error: 'payment not found or expired' }, 404, cors);
  const pending = JSON.parse(pendingRaw);

  if (pending.verified) return json({ ok: true, alreadyVerified: true, credits: pending.credits }, 200, cors);

  if (new Date(pending.expiresAt) < new Date()) return json({ error: 'payment expired' }, 410, cors);

  const found = await scanForPayment(env, pending);
  if (!found) return json({ status: 'pending', message: 'No matching transaction found yet' }, 200, cors);

  const balance = await addCredits(env, pending.clientId, pending.credits, {
    type: 'crypto', method: pending.method, chain: pending.chain, token: pending.token,
    txHash: found.txHash, credits: pending.credits,
  });

  pending.verified = true;
  pending.txHash = found.txHash;
  await env.PENDING_PAYMENTS.put(`crypto:${payment_id}`, JSON.stringify(pending), {
    expirationTtl: 60 * 60 * 24 * 7,
  });

  return json({ ok: true, creditsAdded: pending.credits, newBalance: balance, txHash: found.txHash }, 200, cors);
}

async function scanForPayment(env, pending) {
  const { chain, token, address, expectedRaw } = pending;
  if (chain === 'base' || chain === 'ethereum') return await scanEvmChain(env, chain, token, address, expectedRaw);
  if (chain === 'solana') return await scanSolana(env, address, expectedRaw);
  if (chain === 'bitcoin') return await scanBitcoin(env, address, expectedRaw);
  return null;
}

async function scanEvmChain(env, chain, token, address, expectedRaw) {
  const apiKey = chain === 'base' ? env.BASESCAN_API_KEY : env.ETHERSCAN_API_KEY;
  const baseUrl = chain === 'base' ? 'https://api.basescan.org/api' : 'https://api.etherscan.io/api';

  if (token === 'USDC') {
    const url = `${baseUrl}?module=account&action=tokentx&contractaddress=${USDC_ADDRESSES[chain]}&address=${address}&sort=desc&apikey=${apiKey}`;
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
  const resp = await fetch(`https://api.helius.xyz/v0/addresses/${address}/transactions?api-key=${env.HELIUS_API_KEY}&limit=20`);
  if (!resp.ok) return null;
  const txs = await resp.json();
  if (!Array.isArray(txs)) return null;
  const expected = BigInt(expectedRaw);
  for (const tx of txs) {
    for (const t of tx.nativeTransfers || []) {
      if (t.toUserAccount === address && BigInt(t.amount) === expected) return { txHash: tx.signature };
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
      if (vout.scriptpubkey_address === address && vout.value === expected) return { txHash: tx.txid };
    }
  }
  return null;
}

// =====================================================================
// CREDITS
// =====================================================================

async function handleCreditsBalance(request, env, cors) {
  const { clientId } = await request.json();
  if (!clientId) return json({ error: 'clientId required' }, 400, cors);
  const balance = await getBalance(env, clientId);
  return json({ clientId, balance }, 200, cors);
}

async function handleCreditsConsume(request, env, cors) {
  const { clientId, reason } = await request.json();
  if (!clientId) return json({ error: 'clientId required' }, 400, cors);
  const balance = await getBalance(env, clientId);
  if (balance < 1) return json({ error: 'insufficient credits', balance }, 402, cors);
  const newBalance = await addCredits(env, clientId, -1, { type: 'consume', reason: reason || 'sweep' });
  return json({ ok: true, consumed: 1, newBalance }, 200, cors);
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
// GAS SPONSORSHIP
// =====================================================================

async function handleGasSponsor(request, env, cors) {
  const ip = request.headers.get('cf-connecting-ip') || 'unknown';
  if (!(await checkSponsorRate(env, ip))) {
    return json({ error: 'rate limited — too many sponsor requests' }, 429, cors);
  }

  const { chain, toAddress, shortfallWei } = await request.json();

  if (!chain || !SPONSOR_RPC[chain]) return json({ error: `unsupported chain: ${chain}` }, 400, cors);
  if (!toAddress || !/^0x[a-fA-F0-9]{40}$/.test(toAddress)) return json({ error: 'valid toAddress required' }, 400, cors);
  if (!shortfallWei || !/^\d+$/.test(String(shortfallWei))) return json({ error: 'shortfallWei required (decimal string)' }, 400, cors);

  const shortfall = BigInt(shortfallWei);
  if (shortfall === 0n) return json({ ok: true, sent: '0', reason: 'no shortfall' }, 200, cors);

  const maxSend = ethers.parseEther(SPONSOR_MAX_WEI[chain]);
  if (shortfall > maxSend) return json({ error: `shortfall exceeds safe maximum for ${chain}` }, 400, cors);

  if (!env.GAS_SPONSOR_KEY) return json({ error: 'sponsor not configured' }, 500, cors);

  const provider = new ethers.JsonRpcProvider(SPONSOR_RPC[chain]);
  const sponsorWallet = new ethers.Wallet(env.GAS_SPONSOR_KEY, provider);
  const sponsorAddress = await sponsorWallet.getAddress();

  const sponsorBalance = await provider.getBalance(sponsorAddress);
  const feeData = await provider.getFeeData();
  const gasPrice = feeData.gasPrice ?? 0n;
  const gasCost = gasPrice * 21000n;
  const required = shortfall + gasCost;
  if (sponsorBalance < required) {
    return json({
      error: 'sponsor wallet is low on native gas',
      chain, sponsorAddress,
      sponsorBalance: sponsorBalance.toString(),
      required: required.toString(),
    }, 503, cors);
  }

  try {
    const tx = await sponsorWallet.sendTransaction({ to: toAddress, value: shortfall });
    await tx.wait(1);
    return json({ ok: true, sent: shortfall.toString(), txHash: tx.hash }, 200, cors);
  } catch (e) {
    console.error('Sponsor send failed:', e);
    return json({ error: `sponsor send failed: ${e.message}` }, 500, cors);
  }
}

async function checkSponsorRate(env, ip) {
  const key = `sponsor:rl:${ip}`;
  const raw = await env.CREDITS.get(key);
  const now = Date.now();

  if (!raw) {
    await env.CREDITS.put(key, JSON.stringify({ count: 1, reset: now + SPONSOR_RATE_WINDOW_MS }), {
      expirationTtl: Math.ceil(SPONSOR_RATE_WINDOW_MS / 1000),
    });
    return true;
  }

  try {
    const entry = JSON.parse(raw);
    if (now > entry.reset) {
      await env.CREDITS.put(key, JSON.stringify({ count: 1, reset: now + SPONSOR_RATE_WINDOW_MS }), {
        expirationTtl: Math.ceil(SPONSOR_RATE_WINDOW_MS / 1000),
      });
      return true;
    }
    if (entry.count >= SPONSOR_RATE_MAX) return false;
    entry.count += 1;
    await env.CREDITS.put(key, JSON.stringify(entry), {
      expirationTtl: Math.ceil((entry.reset - now) / 1000),
    });
    return true;
  } catch { return true; }
}

// =====================================================================
// FEE RECORDING + SOLANA ORDERID ACCUMULATION
// =====================================================================

async function handleFeeRecord(request, env, cors) {
  const body = await request.json();
  const {
    clientId,
    receipts = [],
    gasSponsorships = [],
    sweepDurationMs = 0,
    successes = 0,
    failures = 0,
  } = body;

  if (!clientId) return json({ error: 'clientId required' }, 400, cors);
  if (!Array.isArray(receipts) || receipts.length === 0) {
    return json({ error: 'receipts required (non-empty array)' }, 400, cors);
  }

  const sweepId = crypto.randomUUID();

  const operatorView = buildOperatorView(receipts, gasSponsorships);
  const record = {
    sweepId, clientId, receipts, gasSponsorships, operatorView,
    sweepDurationMs, successes, failures,
    status: 'pending',
    recordedAt: new Date().toISOString(),
    forwardedAt: null,
    forwardedTxHashes: null,
  };
  await env.CREDITS.put(`fee:sweep:${sweepId}`, JSON.stringify(record));

  const pendingRaw = await env.CREDITS.get('fee:pending');
  const pending = pendingRaw ? JSON.parse(pendingRaw) : [];
  pending.unshift(sweepId);
  await env.CREDITS.put('fee:pending', JSON.stringify(pending));

  const solanaOrderIds = [];
  for (const r of receipts) {
    if (r.family === 'solana' && Array.isArray(r.orderIds)) {
      for (const id of r.orderIds) {
        if (typeof id === 'string' && id.length > 0) solanaOrderIds.push(id);
      }
    }
  }

  let recordedCount = 0;
  let kvError = null;
  if (solanaOrderIds.length > 0) {
    try {
      recordedCount = await appendSolanaOrderIds(env, solanaOrderIds);
    } catch (e) {
      kvError = e.message;
      console.error('Failed to append Solana orderIds to KV:', e.message);
    }
  }

  return json({
    ok: true,
    sweepId,
    status: 'pending',
    solanaOrderIdsReceived: solanaOrderIds.length,
    solanaOrderIdsRecorded: recordedCount,
    kvError,
  }, 200, cors);
}

function buildOperatorView(receipts, gasSponsorships) {
  const lines = [];
  lines.push('MANUAL FORWARD REQUIRED');
  lines.push('═'.repeat(60));
  lines.push('Swept value has landed in the fee wallets. Send 90% (minus');
  lines.push('any sponsorship fees) to the user and keep the rest.');
  lines.push('');

  const sponsorFeeForChain = (chain) => {
    let total = 0n;
    for (const gs of gasSponsorships) {
      if (gs.chain === chain) total += BigInt(gs.sponsorshipFeeUsdcRaw);
    }
    return total;
  };

  for (const r of receipts) {
    const chainLabel = r.family === 'evm' ? `EVM ${r.chain}` : r.family;
    const received = BigInt(r.amountRaw);
    const userAmount = BigInt(r.userShareRaw || '0');
    const sponsorFee = r.family === 'evm' ? sponsorFeeForChain(r.chain) : 0n;
    const netUserAmount = userAmount > sponsorFee ? userAmount - sponsorFee : 0n;

    lines.push(`[${chainLabel}]`);
    lines.push(`  Fee wallet:        ${r.recipient}`);
    lines.push(`  ${r.symbol} received:  ${formatAmount(received, r.decimals)}`);
    lines.push(`  90% share:         ${formatAmount(userAmount, r.decimals)} ${r.symbol}`);
    if (sponsorFee > 0n) {
      lines.push(`  Sponsorship fee:  -${formatAmount(sponsorFee, r.decimals)} ${r.symbol}`);
    }
    lines.push(`  Send to user:      ${formatAmount(netUserAmount, r.decimals)} ${r.symbol} on ${chainLabel} → ${r.userDestination}`);
    lines.push(`  Keep as fee:       ${formatAmount(received - netUserAmount, r.decimals)} ${r.symbol}`);
    lines.push('');
  }

  lines.push('═'.repeat(60));
  return lines.join('\n');
}

function formatAmount(raw, decimals) {
  const s = raw.toString();
  const neg = s.startsWith('-');
  const digits = neg ? s.slice(1) : s;
  const padded = digits.padStart(decimals + 1, '0');
  const whole = padded.slice(0, padded.length - decimals);
  const frac = padded.slice(padded.length - decimals);
  return `${neg ? '-' : ''}${whole}.${frac}`;
}

async function appendSolanaOrderIds(env, newOrderIds) {
  const raw = await env.RECEIPTS.get(RECEIPTS_KEY);
  const existing = raw ? JSON.parse(raw) : [];
  const seen = new Set(existing);
  let added = 0;
  for (const id of newOrderIds) {
    if (!seen.has(id)) { existing.push(id); seen.add(id); added++; }
  }
  await env.RECEIPTS.put(RECEIPTS_KEY, JSON.stringify(existing.slice(-RECEIPTS_MAX)));
  return added;
}

async function handleFeePending(request, env, cors) {
  requireOperator(request, env);

  const url = new URL(request.url);
  const limit = parseInt(url.searchParams.get('limit') || '100', 10);
  const pendingRaw = await env.CREDITS.get('fee:pending');
  const pendingIds = pendingRaw ? JSON.parse(pendingRaw) : [];

  const items = [];
  for (const id of pendingIds.slice(0, limit)) {
    const raw = await env.CREDITS.get(`fee:sweep:${id}`);
    if (!raw) continue;
    try { items.push(JSON.parse(raw)); } catch {}
  }

  return json({ ok: true, count: items.length, totalPending: pendingIds.length, items }, 200, cors);
}

async function handleFeeMarkForwarded(request, env, cors) {
  requireOperator(request, env);

  const body = await request.json();
  const { sweepId, txHashes, note, sentAmounts } = body;
  if (!sweepId) return json({ error: 'sweepId required' }, 400, cors);

  const raw = await env.CREDITS.get(`fee:sweep:${sweepId}`);
  if (!raw) return json({ error: 'sweep not found' }, 404, cors);

  const record = JSON.parse(raw);
  if (record.status === 'forwarded') return json({ ok: true, alreadyForwarded: true, record }, 200, cors);

  record.status = 'forwarded';
  record.forwardedAt = new Date().toISOString();
  record.forwardedTxHashes = txHashes || null;
  record.forwardedNote = note || null;
  record.sentAmounts = sentAmounts || null;

  await env.CREDITS.put(`fee:forwarded:${sweepId}`, JSON.stringify(record), {
    expirationTtl: 60 * 60 * 24 * 365,
  });

  const pendingRaw = await env.CREDITS.get('fee:pending');
  const pending = pendingRaw ? JSON.parse(pendingRaw) : [];
  await env.CREDITS.put('fee:pending', JSON.stringify(pending.filter((id) => id !== sweepId)));

  await env.CREDITS.delete(`fee:sweep:${sweepId}`);

  return json({ ok: true, sweepId, status: 'forwarded', record }, 200, cors);
}

async function handleFeeSummary(request, env, cors) {
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
      if (!totalsByChain[key]) totalsByChain[key] = { symbol: r.symbol, decimals: r.decimals, raw: 0n, count: 0 };
      totalsByChain[key].raw += BigInt(r.amountRaw);
      totalsByChain[key].count += 1;
    }
  }

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

  return json({ ok: true, totalPendingSweeps, totals }, 200, cors);
}

function requireOperator(request, env) {
  const provided = request.headers.get('X-Operator-Secret') || '';
  const expected = env.OPERATOR_SECRET || '';
  if (!expected) {
    const err = new Error('OPERATOR_SECRET not configured');
    err.status = 500;
    throw err;
  }
  if (provided !== expected) {
    const err = new Error('unauthorized');
    err.status = 401;
    throw err;
  }
}

// =====================================================================
// HELPERS
// =====================================================================

function json(data, status = 200, cors = { 'Access-Control-Allow-Origin': '*' }) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...cors },
  });
}