/**
 * credits.js — Client identity and credit management.
 *
 * Uses a pseudonymous client ID stored in localStorage. The ID is a
 * random 32-byte hex string, generated on first visit. It's the only
 * thing that ties a payment to a browser.
 *
 * All credit operations go through the payment worker.
 */

const PAYMENT_WORKER_URL = 'https://sweep-payment.yourname.workers.dev';
const CLIENT_ID_KEY = 'sweep_client_id';
const CACHE_MS = 30 * 1000; // 30s cache for balance

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
  cachedBalance = null;
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
    // Worker not reachable — assume dev mode, give unlimited credits
    console.warn('Credit worker unreachable; treating as dev mode:', err.message);
    cachedBalance = { balance: 999, _fetchedAt: Date.now() };
    return 999;
  }
}

export async function consumeCredit(reason = 'sweep') {
  const resp = await fetch(`${PAYMENT_WORKER_URL}/credits/consume`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ clientId: getClientId(), reason }),
  });

  const data = await resp.json();
  if (!resp.ok) {
    throw new Error(data.error || `HTTP ${resp.status}`);
  }

  cachedBalance = { balance: data.newBalance, _fetchedAt: Date.now() };
  return data.newBalance;
}

export function invalidateBalanceCache() {
  cachedBalance = null;
}

// =====================================================================
// SQUARE PAYMENT
// =====================================================================

export async function startSquareCheckout(bundle = 'single') {
  const resp = await fetch(`${PAYMENT_WORKER_URL}/square/checkout`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ clientId: getClientId(), bundle }),
  });

  const data = await resp.json();
  if (!resp.ok) throw new Error(data.error || `HTTP ${resp.status}`);

  // Redirect to Square
  window.location.href = data.url;
  return data;
}

export async function verifySquareOrder(orderId) {
  const resp = await fetch(`${PAYMENT_WORKER_URL}/square/verify`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ orderId, clientId: getClientId() }),
  });

  const data = await resp.json();
  if (!resp.ok) throw new Error(data.error || `HTTP ${resp.status}`);
  invalidateBalanceCache();
  return data;
}

// =====================================================================
// CRYPTO PAYMENT
// =====================================================================

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

/**
 * Poll the payment worker until the crypto payment is confirmed,
 * up to `timeoutMs`. Calls onTick(attempt, total) each poll.
 */
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
      if (result.status === 'pending') {
        // keep polling
      } else {
        throw new Error(result.error || 'unknown verification failure');
      }
    } catch (err) {
      // Network error, keep trying
      console.warn('Polling error:', err.message);
    }

    await new Promise((r) => setTimeout(r, intervalMs));
  }

  throw new Error('Payment verification timed out');
}

export { PAYMENT_WORKER_URL };