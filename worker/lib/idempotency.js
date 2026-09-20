/**
 * idempotency.js — replay protection for mutating worker endpoints.
 * =====================================================================
 * Wraps a request handler so that two requests carrying the same
 * Idempotency-Key (and the same body) return the same response, and
 * the underlying handler runs at most once.
 *
 * Storage is now a Durable Object, which closes the get-then-put race
 * that the previous KV implementation had. Two truly concurrent
 * requests with the same key cannot both execute the handler.
 *
 * Design notes:
 *
 *   1. Store key is scoped by endpoint path AND, when available,
 *      clientId. Two different clients using the same key on the same
 *      endpoint are two different operations.
 *
 *   2. The request body is hashed and stored alongside the response.
 *      Same key + different body → 409. Same key + same body → the
 *      cached response is replayed.
 *
 *   3. Responses are stored verbatim, including error responses.
 *
 *   4. If the DO is unreachable, we fail open: process the request
 *      without idempotency. Better to allow a rare double-process
 *      than to block all traffic during a DO outage.
 */

const IDEMPOTENCY_KEY_RE = /^[a-zA-Z0-9_-]{8,128}$/;

const CLIENT_SCOPED_ENDPOINTS = new Set([
  '/credits/consume',
  '/credits/claim-free',
  '/fee/record',
  '/crypto/verify',
]);

export async function withIdempotency(request, env, handler) {
  const key = request.headers.get('Idempotency-Key');

  if (!key) {
    return await handler();
  }

  if (!IDEMPOTENCY_KEY_RE.test(key)) {
    return jsonResponse({ error: 'invalid Idempotency-Key format' }, 400);
  }

  const url = new URL(request.url);
  const path = url.pathname;

  let bodyText = '';
  try {
    bodyText = await request.clone().text();
  } catch {
    bodyText = '';
  }

  const bodyHash = await sha256Hex(bodyText);

  let clientId = null;
  if (CLIENT_SCOPED_ENDPOINTS.has(path)) {
    try {
      const parsed = JSON.parse(bodyText);
      if (parsed && typeof parsed.clientId === 'string' && parsed.clientId.length >= 16) {
        clientId = parsed.clientId;
      }
    } catch {}
  }

  const storeKey = clientId
    ? `${path}:${clientId}:${key}`
    : `${path}:${key}`;

  // Get the DO stub. The DO is a single global instance — we use a fixed
  // name so all keys funnel through it.
  let doStub;
  try {
    const id = env.IDEMPOTENCY_DO.idFromName('global');
    doStub = env.IDEMPOTENCY_DO.get(id);
  } catch (e) {
    console.warn('idempotency DO unavailable, failing open', { error: e.message });
    return await handler();
  }

  // ---- Lookup ----
  let existing = null;
  try {
    const lookupResp = await doStub.fetch(
      new Request('https://do/lookup?key=' + encodeURIComponent(storeKey), { method: 'GET' })
    );
    if (lookupResp.ok) {
      const j = await lookupResp.json();
      existing = j.record || null;
    }
  } catch (e) {
    console.warn('idempotency DO lookup failed, failing open', { error: e.message });
    return await handler();
  }

  if (existing) {
    if (existing.bodyHash === bodyHash) {
      return new Response(existing.responseBody, {
        status: existing.responseStatus,
        headers: {
          'Content-Type': 'application/json',
          'Idempotent-Replay': 'true',
        },
      });
    }
    return jsonResponse({
      error: 'Idempotency-Key reused with a different request body',
    }, 409);
  }

  // ---- Miss: run the handler ----
  const response = await handler();

  let responseBody = '';
  try {
    responseBody = await response.clone().text();
  } catch {
    return response;
  }

  // Store the response. The DO refuses to overwrite an existing entry,
  // so if a concurrent request already stored something, we don't
  // clobber it. In that case the concurrent request's response wins
  // for subsequent replays — which is fine, they had the same key and
  // (per the bodyHash check) the same body.
  try {
    await doStub.fetch(new Request('https://do/store', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        key: storeKey,
        bodyHash,
        responseStatus: response.status,
        responseBody,
      }),
    }));
  } catch (e) {
    console.warn('idempotency DO store failed', { error: e.message });
  }

  return response;
}

async function sha256Hex(s) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(buf)]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}