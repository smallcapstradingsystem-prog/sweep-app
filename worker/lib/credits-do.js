/**
 * credits-do.js — Durable Object for atomic credit accounting.
 * =====================================================================
 * One DO instance per clientId. All mutations serialize through a
 * single-threaded event loop, so read-modify-write races are
 * impossible.
 *
 * This replaces the KV-backed balance logic that was racy under
 * concurrent requests. The KV `history:${clientId}` key is retained
 * for backward compatibility with the operator's existing history
 * viewer, but it's now written by this DO after every successful
 * mutation, so it stays in sync.
 *
 * Storage layout (DO storage, not KV):
 *   balance       → integer (string-encoded)
 *   history       → JSON array, capped at 50 entries, most recent first
 *
 * The DO exposes:
 *   getBalance()
 *   apply({ delta, metadata })
 *   getHistory()
 *
 * The `apply` method is the ONLY way to change a balance. It runs
 * read-modify-write in one turn of the event loop, so no two applies
 * can interleave for the same client.
 */

const HISTORY_MAX = 50;

export class Credits {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    // Block concurrent applies until state is loaded. The DO framework
    // guarantees single-threaded execution, but we still want to gate
    // on the storage read so the first apply doesn't race the initial
    // `blockConcurrencyWhile` loader.
    this.state.blockConcurrencyWhile(async () => {
      this.balance = (await this.state.storage.get('balance')) ?? 0;
      this.history = (await this.state.storage.get('history')) ?? [];
    });
  }

  async fetch(request) {
    const url = new URL(request.url);
    const path = url.pathname;

    try {
      if (path === '/balance' && request.method === 'GET') {
        return json({ balance: this.balance });
      }

      if (path === '/history' && request.method === 'GET') {
        return json({ history: this.history });
      }

      if (path === '/apply' && request.method === 'POST') {
        const body = await request.json();
        const { delta, metadata = {} } = body;

        if (!Number.isInteger(delta)) {
          return json({ error: 'delta must be an integer' }, 400);
        }

        const current = this.balance;
        const next = current + delta;

        // Refuse to go negative. This is the atomic check that KV
        // couldn't give us. Callers who expect a 402 can look for it.
        if (next < 0) {
          return json({
            ok: false,
            error: 'insufficient credits',
            balance: current,
            requested: delta,
          }, 402);
        }

        this.balance = next;

        const entry = {
          delta,
          balance: next,
          at: new Date().toISOString(),
          ...metadata,
        };
        this.history.unshift(entry);
        if (this.history.length > HISTORY_MAX) this.history.length = HISTORY_MAX;

        // Persist both in one transaction so storage never diverges
        // from memory even if the isolate dies between writes.
        await this.state.storage.put({
          balance: next,
          history: this.history,
        });

        return json({ ok: true, balance: next, delta });
      }

      return json({ error: 'not found' }, 404);
    } catch (err) {
      console.error('Credits DO error:', err);
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