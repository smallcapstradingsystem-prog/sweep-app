const SENTRY_DSN = '';
const PLAUSIBLE_DOMAIN = '';

let sentryLoaded = false;
let Sentry = null;
let plausibleLoaded = false;

export async function initSentry() {
  if (!SENTRY_DSN || sentryLoaded) return;
  const mod = await import('@sentry/browser');
  Sentry = mod;
  Sentry.init({
    dsn: SENTRY_DSN,
    environment: 'production',
    release: window.__POOLPORT_LIQUIFI_RELEASE__ || 'dev',
    sendDefaultPii: false,
    tracesSampleRate: 0,
    sampleRate: 1.0,
    ignoreErrors: [
      'ResizeObserver loop limit exceeded',
      'User rejected the request',
      'User denied transaction signature',
      'User rejected transaction',
    ],
    beforeSend(event) { return scrubEvent(event); },
    beforeBreadcrumb(bc) { return scrubBreadcrumb(bc); },
  });
  sentryLoaded = true;
}

// =====================================================================
// SCRUBBING
// =====================================================================
//
// Everything that leaves the browser passes through scrubDeep. The
// scrubber:
//
//   1. Walks the ENTIRE event tree — message, exception, contexts,
//      tags, user, extra, breadcrumbs, request — not just a subset.
//   2. Redacts any 0x-prefixed hex string of 20+ chars (addresses,
//      tx hashes, signatures).
//   3. Redacts runs of 12-24 lowercase words separated by whitespace
//      (BIP-39-shaped mnemonics).
//   4. Drops any field whose key name matches /phrase|mnemonic|private|
//      secret|seed|wif/i, regardless of shape.
//   5. Blanks request bodies and query strings unconditionally.
//
// This is intentionally aggressive. False positives are fine; false
// negatives are not.
//
// The BIP-39 heuristic will occasionally match prose in an error
// message ("the quick brown fox jumped over the lazy dog and ran
// away again into the woods and hills..."). That's acceptable — a
// redacted error string is better than a leaked mnemonic.
// =====================================================================

const HEX_RE = /0x[a-fA-F0-9]{20,}/g;
const BIP39_RE = /\b(?:[a-z]{3,8}\s+){11,23}[a-z]{3,8}\b/gi;
const SENSITIVE_KEY_RE = /phrase|mnemonic|private|secret|seed|wif/i;

function scrubString(s) {
  if (typeof s !== 'string') return s;
  return s.replace(HEX_RE, '0x[REDACTED]').replace(BIP39_RE, '[REDACTED-PHRASE]');
}

function scrubDeep(value, seen = new WeakSet()) {
  if (value == null) return value;
  if (typeof value === 'string') return scrubString(value);
  if (typeof value !== 'object') return value;
  if (seen.has(value)) return '[circular]';
  seen.add(value);

  if (Array.isArray(value)) return value.map((v) => scrubDeep(v, seen));

  const out = {};
  for (const [k, v] of Object.entries(value)) {
    if (SENSITIVE_KEY_RE.test(k)) {
      out[k] = '[REDACTED]';
      continue;
    }
    out[k] = scrubDeep(v, seen);
  }
  return out;
}

function scrubEvent(event) {
  const scrubbed = scrubDeep(event);

  if (scrubbed?.request) {
    if (typeof scrubbed.request.url === 'string') {
      try {
        const u = new URL(scrubbed.request.url);
        scrubbed.request.url = u.origin + u.pathname;
      } catch {
        scrubbed.request.url = '[unparseable]';
      }
    }
    scrubbed.request.data = '[scrubbed]';
    scrubbed.request.query_string = '[scrubbed]';
    if (scrubbed.request.cookies) scrubbed.request.cookies = '[scrubbed]';
    if (scrubbed.request.headers) scrubbed.request.headers = '[scrubbed]';
  }

  return scrubbed;
}

function scrubBreadcrumb(bc) {
  const scrubbed = scrubDeep(bc);
  if (scrubbed?.data) {
    if (scrubbed.data.body) scrubbed.data.body = '[scrubbed]';
    if (scrubbed.data.url && typeof scrubbed.data.url === 'string') {
      try {
        const u = new URL(scrubbed.data.url);
        scrubbed.data.url = u.origin + u.pathname;
      } catch {}
    }
  }
  return scrubbed;
}

// ─── TONIGHT: scrubExtra is now just a thin alias for scrubDeep. The
// old version only handled a flat object and missed nested structures.
function scrubExtra(context) {
  return scrubDeep(context || {});
}

export function reportError(err, context = {}) {
  if (!sentryLoaded || !Sentry) { console.error(err); return; }
  Sentry.captureException(err, { extra: scrubExtra(context) });
}

export function initPlausible() {
  if (!PLAUSIBLE_DOMAIN || plausibleLoaded) return;
  if (document.querySelector('script[data-domain]')) { plausibleLoaded = true; return; }
  const s = document.createElement('script');
  s.async = true;
  s.defer = true;
  s.setAttribute('data-domain', PLAUSIBLE_DOMAIN);
  s.src = 'https://plausible.io/js/script.js';
  document.head.appendChild(s);
  plausibleLoaded = true;
}

export function trackEvent(name, props = {}) {
  if (!window.plausible) return;
  const safeProps = {};
  for (const [k, v] of Object.entries(props)) {
    if (/address|phrase|key|hash|txid/i.test(k)) continue;
    safeProps[k] = v;
  }
  window.plausible(name, { props: safeProps });
}

export const track = {
  walletSelected: (type) => trackEvent('wallet_selected', { type }),
  previewStarted: (d) => trackEvent('preview_started', {
    wallet_type: d.walletType, families: d.families.join(','),
    chain_count: d.chainCount, mnemonic_count: d.mnemonicCount,
  }),
  previewCompleted: (d) => trackEvent('preview_completed', {
    wallet_type: d.walletType, duration_ms: d.durationMs, tokens_found: d.tokensFound,
  }),
  sweepStarted: (live) => trackEvent('sweep_started', { mode: live ? 'live' : 'dry-run' }),
  sweepCompleted: (d) => trackEvent('sweep_completed', {
    mode: d.live ? 'live' : 'dry-run', duration_ms: d.durationMs,
    successes: d.successes, failures: d.failures,
  }),
  paymentStarted: (method) => trackEvent('payment_started', { method }),
  paymentCompleted: (method) => trackEvent('payment_completed', { method }),
  error: (kind) => trackEvent('error', { kind }),
};