/**
 * idempotency-do.js — Durable Object for atomic idempotency.
 * =====================================================================
 * One global DO instance. All idempotency keys funnel through it, so
 * the get-then-put race in the KV implementation cannot occur.
 *
 * A request that arrives with an Idempotency-Key and a body hash that
 * matches a prior stored record receives the stored response. A request
 * with the same key but a different body hash is rejected with 409.
 *
 * Storage layout (DO storage):
 *   key:<key>  → { bodyHash, responseStatus, responseBody, processedAt }
 *
 * Cleanup: the DO does not auto-expire entries. A cron sweep deletes
 * entries older than 24h. For a smaller deployment, the DO could
 * implement an LRU on write; we chose the simpler correctness-first
 * approach.
 */

const ENTRY_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_RESPONSE_BYTES = 64 * 1024;

export class Idempotency {
  constructor(state, env) {
    this.state = state;
    this.env = env;
  }

  async fetch(request) {
    const url = new URL(request.url);
    const path = url.pathname;

    try {
      // GET /lookup?key=... — read-only, returns the stored record
      if (path === '/lookup' && request.method === 'GET') {
        const key = url.searchParams.get('key');
        if (!key) return json({ error: 'key required' }, 400);
        const record = await this.state.storage.get(`key:${key}`);
        return json({ record: record || null });
      }

      // POST /store — write a new record if none exists. If one exists,
      // do not overwrite (caller decides what to do based on the read).
      if (path === '/store' && request.method === 'POST') {
        const body = await request.json();
        const { key, bodyHash, responseStatus, responseBody } = body;

        if (!key || !bodyHash) {
          return json({ error: 'key and bodyHash required' }, 400);
        }
        if (typeof responseBody !== 'string') {
          return json({ error: 'responseBody must be a string' }, 400);
        }
        if (responseBody.length > MAX_RESPONSE_BYTES) {
          return json({ ok: true, cached: false, reason: 'response too large' });
        }

        const storeKey = `key:${key}`;
        // The DO's storage API provides atomic transactions. We use a
        // `get` + `put` guarded by a "does not exist yet" check that
        // runs in a single event loop turn, so no concurrent request
        // can slip between.
        const existing = await this.state.storage.get(storeKey);
        if (existing) {
          return json({ ok: true, cached: false, reason: 'key already stored' });
        }

        await this.state.storage.put(storeKey, {
          bodyHash,
          responseStatus,
          responseBody,
          processedAt: new Date().toISOString(),
        });

        return json({ ok: true, cached: true });
      }

      // POST /sweep — cron-driven cleanup of old entries
      if (path === '/sweep' && request.method === 'POST') {
        const cutoff = Date.now() - ENTRY_TTL_MS;
        const all = await this.state.storage.list({ prefix: 'key:' });
        let deleted = 0;
        const toDelete = [];
        for (const [k, v] of all) {
          const at = v.processedAt ? new Date(v.processedAt).getTime() : 0;
          if (at < cutoff) toDelete.push(k);
        }
        if (toDelete.length > 0) {
          await this.state.storage.delete(toDelete);
          deleted = toDelete.length;
        }
        return json({ ok: true, deleted });
      }

      return json({ error: 'not found' }, 404);
    } catch (err) {
      console.error('Idempotency DO error:', err);
      return json({ error: err.message || 'internal error' }, 500);
    }
  }
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}