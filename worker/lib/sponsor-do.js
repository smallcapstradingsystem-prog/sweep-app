/**
 * sponsor-do.js — Durable Object for atomic sponsor budget.
 * =====================================================================
 * One DO instance per (chain, toAddress). Serializes budget checks and
 * deductions, so a racing pair of requests cannot both pass the cap.
 *
 * Also serves as the per-IP rate limiter store. A second DO instance,
 * keyed by IP, handles that. Two DOs total for the sponsor path.
 *
 * Storage layout (DO storage, per (chain, toAddress) instance):
 *   spentWei    → bigint-as-string
 *   windowStart → ISO timestamp of the current 24h window
 *
 * Storage layout (DO storage, per IP instance):
 *   rateCount   → integer
 *   rateReset   → ISO timestamp
 */

const ADDRESS_WINDOW_MS = 24 * 60 * 60 * 1000;
const RATE_WINDOW_MS = 10 * 60 * 1000;

export class SponsorBudget {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.state.blockConcurrencyWhile(async () => {
      this.spentWei = BigInt((await this.state.storage.get('spentWei')) ?? '0');
      this.windowStart = (await this.state.storage.get('windowStart')) ?? null;
    });
  }

  async fetch(request) {
    const url = new URL(request.url);
    const path = url.pathname;

    try {
      if (path === '/check-and-reserve' && request.method === 'POST') {
        const body = await request.json();
        const { shortfallWei, capWei } = body;

        let shortfall, cap;
        try {
          shortfall = BigInt(shortfallWei);
          cap = BigInt(capWei);
        } catch {
          return json({ error: 'invalid bigint strings' }, 400);
        }

        const now = Date.now();
        const windowMs = this.windowStart ? new Date(this.windowStart).getTime() : 0;
        if (!this.windowStart || now - windowMs > ADDRESS_WINDOW_MS) {
          this.spentWei = 0n;
          this.windowStart = new Date(now).toISOString();
        }

        if (this.spentWei + shortfall > cap) {
          return json({
            allowed: false,
            spentWei: this.spentWei.toString(),
            capWei: cap.toString(),
          }, 429);
        }

        this.spentWei = this.spentWei + shortfall;
        await this.state.storage.put({
          spentWei: this.spentWei.toString(),
          windowStart: this.windowStart,
        });

        return json({
          allowed: true,
          spentWei: this.spentWei.toString(),
          capWei: cap.toString(),
        });
      }

      if (path === '/refund' && request.method === 'POST') {
        const body = await request.json();
        let amount;
        try {
          amount = BigInt(body.amountWei);
        } catch {
          return json({ error: 'invalid amountWei' }, 400);
        }
        this.spentWei = this.spentWei > amount ? this.spentWei - amount : 0n;
        await this.state.storage.put({ spentWei: this.spentWei.toString() });
        return json({ ok: true, spentWei: this.spentWei.toString() });
      }

      return json({ error: 'not found' }, 404);
    } catch (err) {
      console.error('SponsorBudget DO error:', err);
      return json({ error: err.message || 'internal error' }, 500);
    }
  }
}

export class SponsorRateLimit {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.state.blockConcurrencyWhile(async () => {
      this.count = (await this.state.storage.get('rateCount')) ?? 0;
      this.reset = (await this.state.storage.get('rateReset')) ?? null;
    });
  }

  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === '/check' && request.method === 'POST') {
      const body = await request.json();
      const { max } = body;
      if (!Number.isInteger(max) || max <= 0) {
        return json({ error: 'max must be a positive integer' }, 400);
      }

      const now = Date.now();
      const resetMs = this.reset ? new Date(this.reset).getTime() : 0;
      if (!this.reset || now > resetMs) {
        this.count = 1;
        this.reset = new Date(now + RATE_WINDOW_MS).toISOString();
        await this.state.storage.put({ rateCount: this.count, rateReset: this.reset });
        return json({ allowed: true, count: this.count, reset: this.reset });
      }

      if (this.count >= max) {
        return json({ allowed: false, count: this.count, reset: this.reset }, 429);
      }

      this.count = this.count + 1;
      await this.state.storage.put({ rateCount: this.count });
      return json({ allowed: true, count: this.count, reset: this.reset });
    }
    return json({ error: 'not found' }, 404);
  }
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}