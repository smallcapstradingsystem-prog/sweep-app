/**
 * credits.js — Client-side credit management + fee recording + gas sponsorship.
 *
 * Every mutating call carries an `Idempotency-Key` header. The key must be
 * stable across retries of the same logical operation and distinct across
 * distinct operations. Callers generate keys with `crypto.randomUUID()` and
 * reuse them on retry.
 *
 * Pricing: 1 credit = 1 wallet swept. A "wallet" is one mnemonic-derived
 * identity (spanning EVM + Solana + Bitcoin for that mnemonic) or one
 * connected wallet (extension, WalletConnect, Ledger, Trezor). See
 * consumeCredit for the count parameter.
 */

const PAYMENT_WORKER_URL = 'https://poolport-liquifi.smallcapstradingsystem.workers.dev';
const CLIENT_ID_KEY = 'sweep_client_id';
const FREE_CLAIM_KEY = 'sweep_free_claim_key';
const CACHE_MS = 30 * 1000;

let cachedBalance = null;

// =====================================================================
// CLIENT IDENTITY
// =====================================================================

export function getClientId() {
  let id = localStorage.getItem(CLIENT_ID_KEY);
  if (!id || id.length < 16) {
    const bytes = new Uint8Array(24);
    crypto.getRandomValues(bytes);
    id = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
    localStorage.setItem(CLIENT_ID_KEY, id);
  }
  return id;
}

export function resetClientId() {
  localStorage.removeItem(CLIENT_ID_KEY);
  localStorage.removeItem(FREE_CLAIM_KEY);
  cachedBalance = null;
}

// =====================================================================
// IDEMPOTENCY KEY HELPERS
// =====================================================================

export function newIdempotencyKey() {
  return crypto.randomUUID();
}

function getFreeClaimKey() {
  let key = localStorage.getItem(FREE_CLAIM_KEY);
  if (!key) {
    key = crypto.randomUUID();
    localStorage.setItem(FREE_CLAIM_KEY, key);
  }
  return key;
}

function clearFreeClaimKey() {
  localStorage.removeItem(FREE_CLAIM_KEY);
}

async function post(url, body, { idempotencyKey } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;

  const resp = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });

  const rawText = await resp.text();
  let data;
  try {
    data = rawText ? JSON.parse(rawText) : {};
  } catch (parseErr) {
    const preview = rawText.slice(0, 200);
    console.warn(`Non-JSON response from ${url} (${resp.status}):`, preview);
    const err = new Error(`HTTP ${resp.status} — non-JSON response`);
    err.status = resp.status;
    err.rawBody = preview;
    err.parseError = parseErr.message;
    throw err;
  }

  if (!resp.ok) {
    const err = new Error(data.error || `HTTP ${resp.status}`);
    err.status = resp.status;
    err.data = data;
    throw err;
  }
  return data;
}

// =====================================================================
// CREDIT BALANCE
// =====================================================================

export async function fetchBalance(opts = {}) {
  if (!opts.force && cachedBalance !== null) {
    const age = Date.now() - cachedBalance._fetchedAt;
    if (age < CACHE_MS) return cachedBalance.balance;
  }
  try {
    const data = await post(`${PAYMENT_WORKER_URL}/credits/balance`, {
      clientId: getClientId(),
    });
    cachedBalance = { balance: data.balance, _fetchedAt: Date.now() };
    return data.balance;
  } catch (err) {
    console.warn('Credit worker unreachable:', err.message);
    return cachedBalance?.balance ?? 0;
  }
}

// =====================================================================
// CREDIT CONSUMPTION
// =====================================================================

/**
 * Consume credits.
 *
 * @param {string} reason
 * @param {object} [opts]
 * @param {string} [opts.idempotencyKey]  reuse across retries of the same logical consume
 * @param {number} [opts.count]           number of credits to consume (default 1)
 */
export async function consumeCredit(reason = 'sweep', opts = {}) {
  const body = { clientId: getClientId(), reason };
  if (opts.count !== undefined) body.count = opts.count;

  const data = await post(
    `${PAYMENT_WORKER_URL}/credits/consume`,
    body,
    { idempotencyKey: opts.idempotencyKey }
  );
  cachedBalance = { balance: data.newBalance, _fetchedAt: Date.now() };
  return data.newBalance;
}

export function invalidateBalanceCache() {
  cachedBalance = null;
}

// =====================================================================
// FREE CREDITS
// =====================================================================

export async function fetchClaimInfo() {
  return await post(`${PAYMENT_WORKER_URL}/credits/claim-info`, {
    clientId: getClientId(),
  });
}

export async function claimFreeCredits() {
  const key = getFreeClaimKey();
  const data = await post(
    `${PAYMENT_WORKER_URL}/credits/claim-free`,
    { clientId: getClientId() },
    { idempotencyKey: key }
  );

  if (data.creditsGranted > 0 || data.alreadyClaimed) {
    clearFreeClaimKey();
  }
  if (data.creditsGranted > 0) invalidateBalanceCache();
  return data;
}

// =====================================================================
// CRYPTO PAYMENT
// =====================================================================

export async function requestCryptoQuote(bundle, method, opts = {}) {
  return await post(
    `${PAYMENT_WORKER_URL}/crypto/quote`,
    { clientId: getClientId(), bundle, method },
    { idempotencyKey: opts.idempotencyKey }
  );
}

export async function verifyCryptoPayment(paymentId, opts = {}) {
  const data = await post(
    `${PAYMENT_WORKER_URL}/crypto/verify`,
    { payment_id: paymentId, clientId: getClientId() },
    { idempotencyKey: opts.idempotencyKey || `verify:${paymentId}` }
  );
  if (data.ok) invalidateBalanceCache();
  return data;
}

export async function pollCryptoPayment(paymentId, { timeoutMs = 30 * 60 * 1000, intervalMs = 5000, onTick } = {}) {
  const start = Date.now();
  let attempt = 0;
  const total = Math.floor(timeoutMs / intervalMs);
  while (Date.now() - start < timeoutMs) {
    attempt++;
    if (onTick) onTick(attempt, total);
    try {
      const result = await verifyCryptoPayment(paymentId, {
        idempotencyKey: `verify:${paymentId}:${attempt}`,
      });
      if (result.ok) return result;
    } catch (err) {
      console.warn('Polling error:', err.message);
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error('Payment verification timed out');
}

// =====================================================================
// GAS SPONSORSHIP
// =====================================================================

export async function requestGasSponsorship(chain, toAddress, opts = {}) {
  return await post(
    `${PAYMENT_WORKER_URL}/gas/sponsor`,
    { chain, toAddress },
    { idempotencyKey: opts.idempotencyKey }
  );
}

// =====================================================================
// FEE RECORDING
// =====================================================================

export async function recordFee(sweepRecord, opts = {}) {
  return await post(
    `${PAYMENT_WORKER_URL}/fee/record`,
    {
      clientId: getClientId(),
      receipts: sweepRecord.receipts,
      gasSponsorships: sweepRecord.gasSponsorships || [],
      sweepDurationMs: sweepRecord.sweepDurationMs || 0,
      successes: sweepRecord.successes || 0,
      failures: sweepRecord.failures || 0,
    },
    { idempotencyKey: opts.idempotencyKey }
  );
}

export { PAYMENT_WORKER_URL };