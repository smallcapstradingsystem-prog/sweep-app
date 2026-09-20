/**
 * payment-worker.js — Cloudflare Worker
 * =====================================================================
 * PoolPort LiquiFi — gas sponsorship and fee receipt recording.
 *
 * Endpoints:
 *   POST /gas/sponsor           — fund a user wallet with native gas
 *   POST /fee/record            — record sweep receipts (operator audit)
 *   GET  /fee/pending           — operator view: pending forwards
 *   GET  /fee/summary           — operator view: totals by chain
 *   POST /fee/mark-forwarded    — operator view: mark a sweep forwarded
 *   GET  /health                — health check
 *
 * Required secrets:
 *   GAS_SPONSOR_KEY          — EVM gas sponsor wallet. Accepts EITHER:
 *                              - a 0x-prefixed 64-char hex private key, OR
 *                              - a BIP-39 mnemonic (12/15/18/21/24 words)
 *   OPERATOR_SECRET          — password for /fee/* endpoints.
 *
 * Optional secrets:
 *   ALLOWED_ORIGINS          — comma-separated list of origins for CORS.
 *
 * KV namespaces:
 *   CREDITS             — sponsor rate limits, sponsor idempotency keys,
 *                         fee records, fee pending index
 */

import { ethers } from 'ethers';

// =====================================================================
// CONFIG
// =====================================================================

// The fee wallet address, mirrored from the client's config.js. Kept
// in sync manually — if the client changes FEE_WALLET_EVM, update
// this and redeploy.
const FEE_WALLET_EVM = '0x8B180186C79D146fd5617B31A9e2A3d938954Fa9';

const SPONSOR_RPC = {
  ethereum: 'https://ethereum-rpc.publicnode.com',
  arbitrum: 'https://arbitrum-one-rpc.publicnode.com',
  optimism: 'https://optimism-rpc.publicnode.com',
  base:     'https://base-rpc.publicnode.com',
  polygon:  'https://polygon-bor-rpc.publicnode.com',
  bnb:      'https://bsc-rpc.publicnode.com',
};

const SPONSOR_TARGET_WEI = {
  ethereum: '0.0008', arbitrum: '0.00002', optimism: '0.00002',
  base: '0.00002', polygon: '0.01', bnb: '0.0002',
};

const SPONSOR_MAX_WEI = {
  ethereum: '0.005', arbitrum: '0.0005', optimism: '0.0005',
  base: '0.0005', polygon: '0.2', bnb: '0.005',
};

const SPONSOR_RATE_MAX = 20;
const SPONSOR_RATE_WINDOW_MS = 10 * 60 * 1000;
const SPONSOR_IDEM_TTL = 60 * 5;

// =====================================================================
// CORS
// =====================================================================

function corsFor(request, env) {
  const allowed = (env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean);
  const origin = request.headers.get('Origin') || '';

  let allowOrigin = '*';
  if (allowed.length > 0) {
    allowOrigin = allowed.includes(origin) ? origin : allowed[0];
  }

  return {
    'Access-Control-Allow-Origin': allowOrigin,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-Operator-Secret, X-Client-Id, Idempotency-Key',
    'Vary': 'Origin',
  };
}

// =====================================================================
// SPONSOR WALLET CONSTRUCTION
// =====================================================================

const HEX_KEY_RE = /^0x[a-fA-F0-9]{64}$/;
const MNEMONIC_RE = /^(\S+\s+){11,23}\S+$/;
const VALID_MNEMONIC_WORD_COUNTS = new Set([12, 15, 18, 21, 24]);

export function buildSponsorWallet(secret, provider) {
  if (typeof secret !== 'string') {
    throw new Error('GAS_SPONSOR_KEY must be a string');
  }
  const trimmed = secret.trim();

  if (HEX_KEY_RE.test(trimmed)) {
    return new ethers.Wallet(trimmed, provider);
  }

  if (MNEMONIC_RE.test(trimmed)) {
    const words = trimmed.split(/\s+/);
    if (!VALID_MNEMONIC_WORD_COUNTS.has(words.length)) {
      throw new Error(`GAS_SPONSOR_KEY mnemonic has ${words.length} words; expected 12/15/18/21/24`);
    }
    return ethers.HDNodeWallet.fromPhrase(trimmed, undefined, "m/44'/60'/0'/0/0").connect(provider);
  }

  throw new Error('GAS_SPONSOR_KEY is neither a 0x-prefixed 64-char hex private key nor a BIP-39 mnemonic');
}

// =====================================================================
// ROUTER
// =====================================================================

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    const cors = corsFor(request, env);

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: cors });
    }

    try {
      if (path === '/health') return json({ ok: true, time: new Date().toISOString() }, 200, cors);

      if (path === '/gas/sponsor' && request.method === 'POST') return await handleGasSponsor(request, env, cors);

      if (path === '/fee/record'          && request.method === 'POST') return await handleFeeRecord(request, env, cors);
      if (path === '/fee/pending'         && request.method === 'GET')  return await handleFeePending(request, env, cors);
      if (path === '/fee/mark-forwarded'  && request.method === 'POST') return await handleFeeMarkForwarded(request, env, cors);
      if (path === '/fee/summary'         && request.method === 'GET')  return await handleFeeSummary(request, env, cors);

      return json({ error: 'not found' }, 404, cors);
    } catch (err) {
      if (err.status === 401) return json({ error: 'unauthorized' }, 401, cors);
      if (err.status === 429) return json({ error: 'rate limited' }, 429, cors);
      if (err.status === 500 && err.message.includes('OPERATOR_SECRET')) {
        return json({ error: 'operator secret not configured' }, 500, cors);
      }
      const firstFrame = String(err?.stack || '').split('\n')[0];
      console.error('Worker error:', err?.name || 'Error', '—', firstFrame);
      return json({ error: 'internal error' }, 500, cors);
    }
  },
};

// =====================================================================
// GAS SPONSORSHIP
// =====================================================================

export async function handleGasSponsor(request, env, cors) {
  const ip = request.headers.get('cf-connecting-ip') || 'unknown';
  if (!(await checkSponsorRate(env, ip))) {
    return json({ error: 'rate limited — too many sponsor requests' }, 429, cors);
  }

  const { chain, toAddress, shortfallWei } = await request.json();

  if (!chain || !SPONSOR_RPC[chain]) return json({ error: `unsupported chain: ${chain}` }, 400, cors);
  if (!toAddress || !/^0x[a-fA-F0-9]{40}$/.test(toAddress)) return json({ error: 'valid toAddress required' }, 400, cors);
  if (!shortfallWei || !/^\d+$/.test(String(shortfallWei))) return json({ error: 'shortfallWei required (decimal string)' }, 400, cors);

  const clientHint = BigInt(shortfallWei);
  if (clientHint === 0n) return json({ ok: true, sent: '0', reason: 'no shortfall' }, 200, cors);

  const maxSend = ethers.parseEther(SPONSOR_MAX_WEI[chain]);
  if (clientHint > maxSend) return json({ error: `shortfall exceeds safe maximum for ${chain}` }, 400, cors);

  if (!env.GAS_SPONSOR_KEY) return json({ error: 'sponsor not configured' }, 500, cors);

  const idemKey = `sponsor:idem:${chain}:${toAddress.toLowerCase()}`;
  const prior = await env.CREDITS.get(idemKey);
  if (prior) {
    try {
      const parsed = JSON.parse(prior);
      return json({
        ok: true, sent: parsed.sent, txHash: parsed.txHash, alreadySent: true,
      }, 200, cors);
    } catch {
      // Corrupt record — fall through and try to send again below.
    }
  }

  let sponsorWallet;
  try {
    sponsorWallet = buildSponsorWallet(env.GAS_SPONSOR_KEY, new ethers.JsonRpcProvider(SPONSOR_RPC[chain]));
  } catch (e) {
    console.error('Sponsor wallet construction failed:', e.message);
    return json({ error: 'sponsor wallet is misconfigured' }, 500, cors);
  }

  const provider = sponsorWallet.provider;
  const sponsorAddress = await sponsorWallet.getAddress();

  const target = ethers.parseEther(SPONSOR_TARGET_WEI[chain]);
  const userBalance = await provider.getBalance(toAddress);
  if (userBalance >= target) {
    return json({ ok: true, sent: '0', reason: 'user already funded' }, 200, cors);
  }
  let shortfall = target - userBalance;
  if (shortfall > maxSend) shortfall = maxSend;

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

    await env.CREDITS.put(idemKey, JSON.stringify({
      sent: shortfall.toString(), txHash: tx.hash, at: new Date().toISOString(),
    }), { expirationTtl: SPONSOR_IDEM_TTL }).catch(() => {});

    return json({ ok: true, sent: shortfall.toString(), txHash: tx.hash }, 200, cors);
  } catch (e) {
    console.error('Sponsor send failed for chain', chain);
    return json({ error: 'sponsor send failed' }, 500, cors);
  }
}

export async function checkSponsorRate(env, ip) {
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
// FEE RECORDING
// =====================================================================

export async function handleFeeRecord(request, env, cors) {
  const body = await request.json();
  const {
    clientId,
    sweepId,
    receipts = [],
    gasSponsorships = [],
    sweepDurationMs = 0,
    successes = 0,
    failures = 0,
  } = body;

  if (!clientId) return json({ error: 'clientId required' }, 400, cors);
  if (!sweepId || typeof sweepId !== 'string' || sweepId.length < 8) {
    return json({ error: 'sweepId required (min 8 chars)' }, 400, cors);
  }
  if (!Array.isArray(receipts) || receipts.length === 0) {
    return json({ error: 'receipts required (non-empty array)' }, 400, cors);
  }

  const existingRaw = await env.CREDITS.get(`fee:sweep:${sweepId}`);
  if (existingRaw) {
    return json({ ok: true, sweepId, alreadyRecorded: true, status: 'pending' }, 200, cors);
  }

  for (let i = 0; i < receipts.length; i++) {
    const r = receipts[i];
    if (!r || typeof r !== 'object') {
      return json({ error: `receipt[${i}] is not an object` }, 400, cors);
    }
    if (typeof r.family !== 'string' || !['evm', 'solana', 'bitcoin', 'tron'].includes(r.family)) {
      return json({ error: `receipt[${i}].family must be evm, solana, bitcoin, or tron` }, 400, cors);
    }
    if (typeof r.amountRaw !== 'string' || !/^\d+$/.test(r.amountRaw)) {
      return json({ error: `receipt[${i}].amountRaw must be a decimal string` }, 400, cors);
    }
    if (typeof r.decimals !== 'number' || r.decimals < 0 || r.decimals > 30) {
      return json({ error: `receipt[${i}].decimals must be 0-30` }, 400, cors);
    }
    if (typeof r.recipient !== 'string' || !/^0x[a-fA-F0-9]{40}$/.test(r.recipient) && r.family === 'evm') {
      return json({ error: `receipt[${i}].recipient must be a 0x address` }, 400, cors);
    }
    if (typeof r.userDestination !== 'string' || !/^0x[a-fA-F0-9]{40}$/.test(r.userDestination)) {
      return json({ error: `receipt[${i}].userDestination must be a 0x address` }, 400, cors);
    }
  }

  const operatorView = buildOperatorView(receipts, gasSponsorships);

  const record = {
    sweepId, clientId, receipts, gasSponsorships, operatorView,
    sweepDurationMs, successes, failures,
    status: 'pending',
    recordedAt: new Date().toISOString(),
    forwardedAt: null,
    forwardedTxHashes: null,
    sentAmounts: null,
  };

  await env.CREDITS.put(`fee:sweep:${sweepId}`, JSON.stringify(record));

  const pendingRaw = await env.CREDITS.get('fee:pending');
  const pending = pendingRaw ? JSON.parse(pendingRaw) : [];
  if (!pending.includes(sweepId)) {
    pending.unshift(sweepId);
    await env.CREDITS.put('fee:pending', JSON.stringify(pending));
  }

  return json({ ok: true, sweepId, status: 'pending' }, 200, cors);
}

export function scaleUsdcToDecimals(amount6, targetDecimals) {
  const a = BigInt(amount6);
  if (targetDecimals === 6) return a;
  if (targetDecimals > 6) return a * (10n ** BigInt(targetDecimals - 6));
  return a / (10n ** BigInt(6 - targetDecimals));
}

export function buildOperatorView(receipts, gasSponsorships) {
  const lines = [];
  lines.push('SWEEP RECEIPT');
  lines.push('═'.repeat(60));
  lines.push('Fee already collected on-chain by the swap routing protocols.');
  lines.push('Forward each user destination their share, minus any gas');
  lines.push('sponsorship fee, and keep the rest.');
  lines.push('');

  for (const r of receipts) {
    const chainLabel = r.family === 'evm' ? `EVM ${r.chain}` : r.family;
    const received = BigInt(r.amountRaw);
    const est = r.estimated ? ' (est.)' : '';
    const isPlaceholder = r.userDestination?.toLowerCase() === FEE_WALLET_EVM.toLowerCase();

    let sponsorFee = 0n;
    if (r.family === 'evm') {
      for (const gs of gasSponsorships) {
        if (gs.chain === r.chain && gs.sponsorshipFeeUsdcRaw) {
          sponsorFee += scaleUsdcToDecimals(gs.sponsorshipFeeUsdcRaw, r.decimals);
        }
      }
    }

    // User share is 90% of what landed in the fee wallet. Sponsorship
    // fee (if any) is deducted from that 90% before forwarding.
    const userShare = (received * 90n) / 100n;
    const netUserShare = userShare > sponsorFee ? userShare - sponsorFee : 0n;

    lines.push(`[${chainLabel}]`);
    lines.push(`  Fee wallet:        ${r.recipient}`);
    lines.push(`  Received:          ${formatAmount(received, r.decimals)} ${r.symbol}${est}`);
    lines.push(`  90% share:         ${formatAmount(userShare, r.decimals)} ${r.symbol}`);
    if (sponsorFee > 0n) {
      lines.push(`  Sponsorship fee:  -${formatAmount(sponsorFee, r.decimals)} ${r.symbol}`);
    }

    if (isPlaceholder) {
      lines.push(`  Send to user:      ** HOLD — user has not provided a destination **`);
    } else {
      lines.push(`  Send to user:      ${formatAmount(netUserShare, r.decimals)} ${r.symbol} on ${chainLabel} → ${r.userDestination}`);
    }
    lines.push(`  Keep as fee:       ${formatAmount(received - netUserShare, r.decimals)} ${r.symbol}`);

    if (r.estimated) {
      lines.push(`  NOTE:              Verify against ${r.bridge} settlement before forwarding.`);
    }
    lines.push('');
  }

  lines.push('═'.repeat(60));
  return lines.join('\n');
}

export function formatAmount(raw, decimals) {
  const s = raw.toString();
  const neg = s.startsWith('-');
  const digits = neg ? s.slice(1) : s;
  const padded = digits.padStart(decimals + 1, '0');
  const whole = padded.slice(0, padded.length - decimals);
  const frac = padded.slice(padded.length - decimals);
  return `${neg ? '-' : ''}${whole}.${frac}`;
}

export async function handleFeePending(request, env, cors) {
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

export async function handleFeeMarkForwarded(request, env, cors) {
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

export async function handleFeeSummary(request, env, cors) {
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

export function json(data, status = 200, cors = { 'Access-Control-Allow-Origin': '*' }) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...cors },
  });
}