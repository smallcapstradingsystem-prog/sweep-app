/**
 * payment-worker.js — Crypto payments + fee tracking + gas sponsorship.
 */

import { ethers } from 'ethers';

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

// =====================================================================
// GAS SPONSORSHIP
// =====================================================================
// The sponsor wallet funds gas for user wallets that can't pay for
// their own sweeps. Its key lives only as a Cloudflare secret
// (GAS_SPONSOR_KEY).
//
// One RPC per chain. Uses public endpoints by default.
// =====================================================================

const SPONSOR_RPC = {
  ethereum: 'https://ethereum-rpc.publicnode.com',
  arbitrum: 'https://arbitrum-one-rpc.publicnode.com',
  optimism: 'https://optimism-rpc.publicnode.com',
  base:     'https://base-rpc.publicnode.com',
  polygon:  'https://polygon-bor-rpc.publicnode.com',
  bnb:      'https://bsc-rpc.publicnode.com',
};

// Absolute ceiling on any single sponsorship call. Protects against a
// compromised client sending huge shortfalls.
const SPONSOR_MAX_WEI = {
  ethereum: '0.005',
  arbitrum: '0.0005',
  optimism: '0.0005',
  base:     '0.0005',
  polygon:  '0.2',
  bnb:      '0.005',
};

// Rate limit: max N sponsorship requests per IP per window.
const SPONSOR_RATE_MAX = 20;                      // 20 calls
const SPONSOR_RATE_WINDOW_MS = 10 * 60 * 1000;    // in 10 minutes

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, X-Operator-Secret',
};

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === 'OPTIONS') return new Response(null, { headers: CORS });

    try {
      if (url.pathname === '/health') return json({ ok: true, time: new Date().toISOString() });
      if (url.pathname === '/credits/balance' && request.method === 'POST') return await handleBalance(request, env);
      if (url.pathname === '/credits/consume' && request.method === 'POST') return await handleConsume(request, env);
      if (url.pathname === '/crypto/quote' && request.method === 'POST') return await handleQuote(request, env);
      if (url.pathname === '/crypto/verify' && request.method === 'POST') return await handleVerify(request, env);
      if (url.pathname === '/gas/sponsor' && request.method === 'POST') return await handleGasSponsor(request, env);
      if (url.pathname === '/fee/record' && request.method === 'POST') return await handleFeeRecord(request, env);
      if (url.pathname === '/fee/pending' && request.method === 'GET') return await handleFeePending(request, env);
      if (url.pathname === '/fee/mark-forwarded' && request.method === 'POST') return await handleFeeMarkForwarded(request, env);
      if (url.pathname === '/fee/summary' && request.method === 'GET') return await handleFeeSummary(request, env);
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
  const newBalance = await addCredits(env, clientId, -1, { type: 'consume', reason: reason || 'sweep' });
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
// GAS SPONSORSHIP
// =====================================================================

async function handleGasSponsor(request, env) {
  // ---- Rate limit by IP ----
  const ip = request.headers.get('cf-connecting-ip') || 'unknown';
  if (!(await checkSponsorRate(env, ip))) {
    return json({ error: 'rate limited — too many sponsor requests' }, 429);
  }

  const { chain, toAddress, shortfallWei } = await request.json();

  // ---- Validate ----
  if (!chain || !SPONSOR_RPC[chain]) {
    return json({ error: `unsupported chain: ${chain}` }, 400);
  }
  if (!toAddress || !/^0x[a-fA-F0-9]{40}$/.test(toAddress)) {
    return json({ error: 'valid toAddress required' }, 400);
  }
  if (!shortfallWei || !/^\d+$/.test(String(shortfallWei))) {
    return json({ error: 'shortfallWei required (decimal string)' }, 400);
  }
  const shortfall = BigInt(shortfallWei);
  if (shortfall === 0n) {
    return json({ ok: true, sent: '0', reason: 'no shortfall' });
  }
  const maxSend = ethers.parseEther(SPONSOR_MAX_WEI[chain]);
  if (shortfall > maxSend) {
    return json({ error: `shortfall exceeds safe maximum for ${chain}` }, 400);
  }

  if (!env.GAS_SPONSOR_KEY) {
    return json({ error: 'sponsor not configured (GAS_SPONSOR_KEY missing)' }, 500);
  }

  // ---- Connect ----
  const provider = new ethers.JsonRpcProvider(SPONSOR_RPC[chain]);
  const sponsorWallet = new ethers.Wallet(env.GAS_SPONSOR_KEY, provider);
  const sponsorAddress = await sponsorWallet.getAddress();

  // ---- Check sponsor has enough ----
  const sponsorBalance = await provider.getBalance(sponsorAddress);
  const feeData = await provider.getFeeData();
  const gasPrice = feeData.gasPrice ?? 0n;
  const gasCost = gasPrice * 21000n;
  const required = shortfall + gasCost;
  if (sponsorBalance < required) {
    return json({
      error: 'sponsor wallet is low on native gas',
      chain,
      sponsorAddress,
      sponsorBalance: sponsorBalance.toString(),
      required: required.toString(),
    }, 503);
  }

  // ---- Send ----
  try {
    const tx = await sponsorWallet.sendTransaction({
      to: toAddress,
      value: shortfall,
    });
    await tx.wait(1);
    return json({
      ok: true,
      sent: shortfall.toString(),
      txHash: tx.hash,
    });
  } catch (e) {
    console.error('Sponsor send failed:', e);
    return json({ error: `sponsor send failed: ${e.message}` }, 500);
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
  } catch {
    return true; // fail-open on KV errors
  }
}

// =====================================================================
// FEE TRACKING
// =====================================================================

async function handleFeeRecord(request, env) {
  const body = await request.json();
  const { clientId, receipts, sweepDurationMs, successes, failures, gasSponsorships } = body;
  if (!clientId) return json({ error: 'clientId required' }, 400);
  if (!Array.isArray(receipts) || receipts.length === 0) {
    return json({ error: 'receipts required (non-empty array)' }, 400);
  }

  const sweepId = crypto.randomUUID();

  // =====================================================================
  // OPERATOR VIEW
  // =====================================================================
  // Build a human-readable summary that only the operator sees. This
  // shows up in /fee/pending so you know exactly what to forward to
  // each user, on which chain, minus sponsorship fees.
  // =====================================================================
  const operatorView = buildOperatorView(receipts, gasSponsorships || []);

  const record = {
    sweepId,
    clientId,
    receipts,
    gasSponsorships: gasSponsorships || [],
    operatorView,
    sweepDurationMs: sweepDurationMs || 0,
    successes: successes || 0,
    failures: failures || 0,
    status: 'pending',
    recordedAt: new Date().toISOString(),
    forwardedAt: null,
    forwardedTxHashes: null,
    sentAmounts: null,
  };

  await env.CREDITS.put(`fee:sweep:${sweepId}`, JSON.stringify(record));

  const pendingRaw = await env.CREDITS.get('fee:pending');
  const pending = pendingRaw ? JSON.parse(pendingRaw) : [];
  pending.unshift(sweepId);
  await env.CREDITS.put('fee:pending', JSON.stringify(pending));

  return json({ ok: true, sweepId, status: 'pending' });
}

/**
 * Build the operator view that goes into the record.
 * Contains: per-chain instructions on what to send where.
 */
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

async function handleFeeMarkForwarded(request, env) {
  requireOperator(request, env);

  const body = await request.json();
  const { sweepId, txHashes, note, sentAmounts } = body;
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
  record.sentAmounts = sentAmounts || null;

  await env.CREDITS.put(`fee:forwarded:${sweepId}`, JSON.stringify(record), {
    expirationTtl: 60 * 60 * 24 * 365,
  });

  const pendingRaw = await env.CREDITS.get('fee:pending');
  const pending = pendingRaw ? JSON.parse(pendingRaw) : [];
  await env.CREDITS.put('fee:pending', JSON.stringify(pending.filter((id) => id !== sweepId)));

  await env.CREDITS.delete(`fee:sweep:${sweepId}`);

  return json({ ok: true, sweepId, status: 'forwarded', record });
}

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

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS },
  });
}