/**
 * credits.js — Gas sponsorship + fee receipt client.
 *
 * The product no longer sells credits. The service fee is taken
 * atomically at swap time by the underlying routing protocols (0x on
 * EVM, deBridge on Solana, THORChain on Bitcoin) and delivered
 * directly to the fee wallets. Users pay nothing up front and buy
 * nothing.
 *
 * Two server-side calls remain:
 *
 *   POST /gas/sponsor   — top up an EVM source wallet with native gas
 *   POST /fee/record    — record a receipt of the on-chain fee, for
 *                         the operator's accounting only
 *
 * The fee receipt is not a payment mechanism. The money already moved
 * on-chain by the time this call runs. The receipt is a server-side
 * audit trail so the operator can see pending sweeps without
 * cross-referencing block explorers manually.
 */

const PAYMENT_WORKER_URL = 'https://poolport-liquifi.smallcapstradingsystem.workers.dev';

// =====================================================================
// CLIENT ID
// =====================================================================
//
// A stable, pseudonymous identifier, sent with every request so the
// worker can rate-limit per client. Never linked to any identity.

const CLIENT_ID_KEY = 'migrate_client_id';

export function getClientId() {
  let id = null;
  try {
    id = localStorage.getItem(CLIENT_ID_KEY);
  } catch { /* localStorage unavailable */ }

  if (!id) {
    const bytes = new Uint8Array(24);
    crypto.getRandomValues(bytes);
    id = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
    try {
      localStorage.setItem(CLIENT_ID_KEY, id);
    } catch { /* ignore */ }
  }
  return id;
}

// =====================================================================
// IDEMPOTENCY KEY
// =====================================================================
//
// One per sweep. Used to scope gas sponsor attempt keys and the fee
// receipt so retries don't double-send or double-record.

export function newIdempotencyKey() {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

// =====================================================================
// HTTP HELPERS
// =====================================================================

async function post(path, body, opts = {}) {
  const headers = {
    'Content-Type': 'application/json',
    'X-Client-Id': getClientId(),
  };

  if (opts.idempotencyKey) {
    headers['Idempotency-Key'] = opts.idempotencyKey;
  }

  let resp;
  try {
    resp = await fetch(`${PAYMENT_WORKER_URL}${path}`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });
  } catch (e) {
    throw new Error(`network: ${e.message}`);
  }

  let data = null;
  try {
    data = await resp.json();
  } catch {
    throw new Error(`invalid response (HTTP ${resp.status})`);
  }

  if (!resp.ok) {
    const msg = data?.error || `HTTP ${resp.status}`;
    const err = new Error(msg);
    err.status = resp.status;
    err.data = data;
    throw err;
  }

  return data;
}

// =====================================================================
// GAS SPONSORSHIP
// =====================================================================

/**
 * Request native gas for a wallet that can't afford its sweep.
 *
 * @param {string} chain      — chain key, e.g. 'base'
 * @param {string} toAddress  — wallet to fund (0x...)
 * @param {object} opts
 * @param {string} [opts.idempotencyKey] — stable per wallet per sweep
 * @returns {Promise<{ok: boolean, sent?: string, txHash?: string, error?: string}>}
 */
export async function requestGasSponsorship(chain, toAddress, opts = {}) {
  const body = { chain, toAddress };

  if (opts.idempotencyKey) {
    body.idempotencyKey = opts.idempotencyKey;
  }

  try {
    const data = await post('/gas/sponsor', body);
    return {
      ok: true,
      sent: data.sent,
      txHash: data.txHash,
      alreadySent: data.alreadySent === true,
      reason: data.reason,
    };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// =====================================================================
// FEE RECEIPTS
// =====================================================================
//
// Records what the swap routing protocols already took on-chain. The
// worker verifies EVM receipts against on-chain transfer logs before
// storing them, so this endpoint cannot be used to inject fake fee
// records. Solana and Bitcoin receipts are reconciled later by the
// reconciler worker.

/**
 * @param {object} payload
 * @param {Array}  payload.receipts          — one per chain/family
 * @param {Array}  [payload.gasSponsorships] — EVM sponsorships to offset
 * @param {number} [payload.sweepDurationMs]
 * @param {number} [payload.successes]
 * @param {number} [payload.failures]
 * @param {object} opts
 * @param {string} [opts.idempotencyKey]
 */
export async function recordFee(payload, opts = {}) {
  return await post('/fee/record', payload, opts);
}

export { PAYMENT_WORKER_URL };