/**
 * credits.js — Client-side credit management.
 *
 * Talks to the payment worker. Stores a pseudonymous client ID in
 * localStorage so payments can be tied to this browser without any
 * account or email.
 */

const PAYMENT_WORKER_URL = 'https://sweep-payment.smallcapstradingsystem.workers.dev';
const CLIENT_ID_KEY = 'sweep_client_id';
const CACHE_MS = 30 * 1000;

let cachedBalance = null;

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
  cachedBalance = null;
}

export async function fetchBalance(opts = {}) {
  if (!opts.force && cachedBalance !== null) {
    const age = Date.now() - cachedBalance._fetchedAt;
    if (age < CACHE_MS) return cachedBalance.balance;
  }

  try {
    const resp = await fetch(`${PAYMENT_WORKER_URL}/credits/balance`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clientId: getClientId() }),
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const data = await resp.json();
    cachedBalance = { balance: data.balance, _fetchedAt: Date.now() };
    return data.balance;
  } catch (err) {
    console.warn('Credit worker unreachable:', err.message);
    return cachedBalance?.balance ?? 0;
  }
}

export async function consumeCredit(reason = 'sweep') {
  const resp = await fetch(`${PAYMENT_WORKER_URL}/credits/consume`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ clientId: getClientId(), reason }),
  });

  const data = await resp.json();
  if (!resp.ok) throw new Error(data.error || `HTTP ${resp.status}`);

  cachedBalance = { balance: data.newBalance, _fetchedAt: Date.now() };
  return data.newBalance;
}

export function invalidateBalanceCache() {
  cachedBalance = null;
}

export async function requestCryptoQuote(bundle, method) {
  const resp = await fetch(`${PAYMENT_WORKER_URL}/crypto/quote`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ clientId: getClientId(), bundle, method }),
  });
  const data = await resp.json();
  if (!resp.ok) throw new Error(data.error || `HTTP ${resp.status}`);
  return data;
}

export async function verifyCryptoPayment(paymentId) {
  const resp = await fetch(`${PAYMENT_WORKER_URL}/crypto/verify`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ payment_id: paymentId }),
  });
  const data = await resp.json();
  if (!resp.ok) throw new Error(data.error || `HTTP ${resp.status}`);
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
      const result = await verifyCryptoPayment(paymentId);
      if (result.ok) return result;
    } catch (err) {
      console.warn('Polling error:', err.message);
    }

    await new Promise((r) => setTimeout(r, intervalMs));
  }

  throw new Error('Payment verification timed out');
}

export { PAYMENT_WORKER_URL };