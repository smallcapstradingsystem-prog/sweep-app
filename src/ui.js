import { state } from './state.js';

// =====================================================================
// DOM HELPERS (unchanged)
// =====================================================================

export function $(sel, root = document) {
  return root.querySelector(sel);
}

export function $$(sel, root = document) {
  return [...root.querySelectorAll(sel)];
}

export function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else if (k.startsWith('on') && typeof v === 'function') {
      node.addEventListener(k.slice(2).toLowerCase(), v);
    } else if (k === 'html') node.innerHTML = v;
    else node.setAttribute(k, v);
  }
  for (const child of [].concat(children)) {
    if (typeof child === 'string') node.appendChild(document.createTextNode(child));
    else if (child) node.appendChild(child);
  }
  return node;
}

export function show(sel) {
  const node = typeof sel === 'string' ? $(sel) : sel;
  if (node) node.style.display = '';
}

export function hide(sel) {
  const node = typeof sel === 'string' ? $(sel) : sel;
  if (node) node.style.display = 'none';
}

// =====================================================================
// LOG FORMATTING PRIMITIVES
// =====================================================================

const TX_CONSOLE_SEL = '#run-log';

function getConsole() {
  return document.querySelector(TX_CONSOLE_SEL);
}

function isStructured(out) {
  return out && out.classList && out.classList.contains('tx-console');
}

// Truncate a hash/address to 0x123456…abcdef form.
function truncHash(h) {
  if (!h || typeof h !== 'string') return '';
  if (h.length <= 14) return h;
  return `${h.slice(0, 8)}…${h.slice(-5)}`;
}

// Format a USDC number to 2 decimals, right-aligned.
function fmtUsdc(n) {
  if (n == null || isNaN(n)) return '';
  return Number(n).toFixed(2);
}

// Format a duration in seconds to X.Xs.
function fmtSec(ms) {
  if (ms == null || isNaN(ms)) return '';
  return (ms / 1000).toFixed(1) + 's';
}

// Pad a string on the right to a fixed width.
function padR(s, n) {
  s = String(s ?? '');
  if (s.length >= n) return s;
  return s + ' '.repeat(n - s.length);
}

// Pad a string on the left to a fixed width.
function padL(s, n) {
  s = String(s ?? '');
  if (s.length >= n) return s;
  return ' '.repeat(n - s.length) + s;
}

// =====================================================================
// FALLBACK: plain text rendering
// =====================================================================
//
// When the #run-log node is a plain <pre> (i.e., the app.css didn't
// load the .tx-console styles, or we're running in a non-browser
// context), all the structured calls fall back to plain-text output
// that mirrors the old logLine() behaviour. That way nothing breaks
// if console.css is missing.

function fallbackAppend(text) {
  const out = getConsole();
  if (!out) return null;
  out.textContent += `[${new Date().toISOString()}] ${text}\n`;
  out.scrollTop = out.scrollHeight;
  return null;  // no handle
}

// =====================================================================
// STRUCTURED LOG API
// =====================================================================

export function clearLog() {
  const out = getConsole();
  if (!out) return;
  if (isStructured(out)) {
    out.innerHTML = '';
  } else {
    out.textContent = '';
  }
}

/**
 * Append a raw text line. Falls back to the same format as the old
 * logLine() when the console isn't structured. Use this for the rare
 * case that doesn't map to a row/wallet/summary shape.
 */
export function logLine(msg) {
  const out = getConsole();
  if (!out) return;
  if (!isStructured(out)) {
    fallbackAppend(msg);
    return;
  }
  const line = document.createElement('div');
  line.className = 'tx-line';
  line.textContent = msg;
  out.appendChild(line);
  out.scrollTop = out.scrollHeight;
}

// =====================================================================
// HIGH-LEVEL API
// =====================================================================

export const log = {
  raw: logLine,

  blank() {
    const out = getConsole();
    if (!out) return;
    if (!isStructured(out)) { fallbackAppend(''); return; }
    const el = document.createElement('div');
    el.className = 'tx-line tx-blank';
    out.appendChild(el);
    out.scrollTop = out.scrollHeight;
  },

  sweepHeader({ mode, walletCount, chainCount }) {
    const out = getConsole();
    if (!out) return;
    if (!isStructured(out)) {
      fallbackAppend(`=== ${mode.toUpperCase()} SWEEP STARTED (${walletCount} wallet${walletCount === 1 ? '' : 's'}) ===`);
      return;
    }

    const time = new Date().toISOString().slice(11, 19) + ' UTC';
    const subline = `${mode} · ${walletCount} wallet${walletCount === 1 ? '' : 's'} · ${chainCount} chain${chainCount === 1 ? '' : 's'} · ${time}`;

    const frag = document.createDocumentFragment();

    const r1 = document.createElement('div');
    r1.className = 'tx-line tx-frame-top';
    r1.textContent = '╭' + '─'.repeat(66) + '╮';
    frag.appendChild(r1);

    const r2 = document.createElement('div');
    r2.className = 'tx-line';
    r2.innerHTML = `<span class="tx-frame-top">│</span>  <span class="tx-frame-label">POOLPORT LIQUIFI · SWEEP</span>${' '.repeat(37)}<span class="tx-frame-top">│</span>`;
    frag.appendChild(r2);

    const r3 = document.createElement('div');
    r3.className = 'tx-line';
    r3.innerHTML = `<span class="tx-frame-top">│</span>  <span class="tx-frame-sub">${subline}</span>${' '.repeat(Math.max(0, 64 - subline.length))}<span class="tx-frame-top">│</span>`;
    frag.appendChild(r3);

    const r4 = document.createElement('div');
    r4.className = 'tx-line tx-frame-bot';
    r4.textContent = '╰' + '─'.repeat(66) + '╯';
    frag.appendChild(r4);

    const blank = document.createElement('div');
    blank.className = 'tx-line tx-blank';
    frag.appendChild(blank);

    out.appendChild(frag);
    out.scrollTop = out.scrollHeight;
  },

  walletHeader({ index, total, family, address }) {
    const out = getConsole();
    if (!out) return;
    if (!isStructured(out)) {
      fallbackAppend(`─────────────── Wallet ${index + 1}/${total} (${family}) ───────────────`);
      fallbackAppend(`[${family}] ${address}`);
      return;
    }

    const leftLabel = ` WALLET ${index + 1} / ${total} `;
    const rightLabel = ` ${family.toUpperCase()} `;
    const inner = 64;
    const dashCount = Math.max(0, inner - leftLabel.length - rightLabel.length);

    const frag = document.createDocumentFragment();

    const r1 = document.createElement('div');
    r1.className = 'tx-line tx-wallet-head';
    r1.innerHTML = `<span class="tx-wallet-head">┌─</span><span class="tx-wallet-index">${leftLabel}</span>${'─'.repeat(dashCount)}<span class="tx-wallet-total">${rightLabel}</span><span class="tx-wallet-head">─┐</span>`;
    frag.appendChild(r1);

    const r2 = document.createElement('div');
    r2.className = 'tx-line';
    const addr = truncHash(address);
    r2.innerHTML = `<span class="tx-wallet-head">│</span>  <span class="tx-wallet-addr">${addr}</span>${' '.repeat(Math.max(0, 64 - addr.length))}<span class="tx-wallet-head">│</span>`;
    frag.appendChild(r2);

    const r3 = document.createElement('div');
    r3.className = 'tx-line tx-wallet-head';
    r3.textContent = '└' + '─'.repeat(66) + '┘';
    frag.appendChild(r3);

    const blank = document.createElement('div');
    blank.className = 'tx-line tx-blank';
    frag.appendChild(blank);

    out.appendChild(frag);
    out.scrollTop = out.scrollHeight;
  },

  /**
   * Gas status line. Status: 'sufficient' | 'sponsoring' | 'sponsored' | 'failed' | 'skipped'
   * Returns a handle with .done() and .fail().
   */
  gas({ chain, amount, unit, status }) {
    return openRow({
      icon: '⛽',
      label: 'gas',
      amount: `${amount ?? ''} ${unit ?? ''}`.trim(),
      status: status || 'checking',
    });
  },

  /**
   * Token swap / transfer row. Symbol is the token, amount is the
   * pre-swap balance, status is 'transferring' | 'swapping' | 'wrapping' | etc.
   * Returns a handle with .done({ txHash, outUsdc, durationMs }),
   * .skip(reason), or .fail(reason).
   */
  token({ symbol, amount, status }) {
    return openRow({
      icon: pickIcon(symbol),
      label: symbol,
      amount: String(amount ?? ''),
      status: status || 'processing',
    });
  },

  /**
   * Cross-chain bridge row. Returns a handle with .done({ orderId, outUsdc, durationMs })
   * or .fail(reason).
   */
  bridge({ from, to, amount, symbol, status }) {
    return openRow({
      icon: '🌉',
      label: `bridge ${from}→${to}`,
      amount: `${amount ?? ''} ${symbol ?? ''}`.trim(),
      status: status || 'bridging',
    });
  },

  walletFooter({ index, totalUsdc, swapCount, skipCount, durationMs }) {
    const out = getConsole();
    if (!out) return;
    if (!isStructured(out)) {
      fallbackAppend(`  wallet total  ${fmtUsdc(totalUsdc)} USDC · ${swapCount} swaps · ${skipCount} skipped · ${fmtSec(durationMs)}`);
      return;
    }

    const frag = document.createDocumentFragment();

    const rule = document.createElement('div');
    rule.className = 'tx-line tx-wallet-foot';
    rule.innerHTML = `<span class="tx-wallet-foot-rule">    ─────────────────────────────────────────────────────────────</span>`;
    frag.appendChild(rule);

    const line = document.createElement('div');
    line.className = 'tx-line tx-wallet-foot';
    line.innerHTML = `      wallet total       <span class="tx-wallet-foot-value">${fmtUsdc(totalUsdc)} USDC</span> · ${swapCount} swap${swapCount === 1 ? '' : 's'} · ${skipCount} skipped · ${fmtSec(durationMs)}`;
    frag.appendChild(line);

    const blank = document.createElement('div');
    blank.className = 'tx-line tx-blank';
    frag.appendChild(blank);

    out.appendChild(frag);
    out.scrollTop = out.scrollHeight;
  },

  sweepFooter({
    mode, durationMs, walletCount, tokensProcessed, successes, skips,
    totalUsdc, destination, sponsorships, note,
  }) {
    const out = getConsole();
    if (!out) return;
    if (!isStructured(out)) {
      fallbackAppend(`=== ${mode === 'live' ? 'LIVE SWEEP' : 'DRY RUN'} COMPLETE ===`);
      fallbackAppend(`  Wallets swept:     ${walletCount}`);
      fallbackAppend(`  Tokens processed:  ${tokensProcessed}`);
      fallbackAppend(`  Successful swaps:  ${successes}`);
      if (skips > 0) fallbackAppend(`  Skipped:           ${skips}`);
      fallbackAppend(`  Total to you:      ~$${fmtUsdc(totalUsdc)}`);
      fallbackAppend(`  Destination:       ${destination || '(not set)'}`);
      return;
    }

    const isLive = mode === 'live';
    const title = isLive ? 'SWEEP COMPLETE' : 'DRY RUN COMPLETE';
    const titleLine = `${title} · ${fmtSec(durationMs)}`;

    const frag = document.createDocumentFragment();

    const r1 = document.createElement('div');
    r1.className = 'tx-line tx-frame-top';
    r1.textContent = '╭' + '─'.repeat(66) + '╮';
    frag.appendChild(r1);

    const r2 = document.createElement('div');
    r2.className = 'tx-line';
    r2.innerHTML = `<span class="tx-frame-top">│</span>  <span class="tx-frame-label">${titleLine}</span>${' '.repeat(Math.max(0, 64 - titleLine.length))}<span class="tx-frame-top">│</span>`;
    frag.appendChild(r2);

    const r3 = document.createElement('div');
    r3.className = 'tx-line';
    r3.innerHTML = `<span class="tx-frame-top">│</span>${' '.repeat(66)}<span class="tx-frame-top">│</span>`;
    frag.appendChild(r3);

    const rows = [];
    rows.push(['wallets swept', String(walletCount)]);
    rows.push(['tokens processed', String(tokensProcessed)]);
    rows.push(['successful', String(successes)]);
    if (skips > 0) rows.push(['skipped', String(skips)]);
    if (isLive) {
      rows.push(['', '']);
      rows.push(['total to you', `~${fmtUsdc(totalUsdc)} USDC`]);
      rows.push(['destination', destination || '(not set)']);
    }

    for (const [k, v] of rows) {
      const line = document.createElement('div');
      line.className = 'tx-line';
      if (!k && !v) {
        line.innerHTML = `<span class="tx-frame-top">│</span>${' '.repeat(66)}<span class="tx-frame-top">│</span>`;
      } else {
        const keyPart = padR(k, 22);
        const valPart = v;
        const content = `   ${keyPart}${valPart}`;
        line.innerHTML = `<span class="tx-frame-top">│</span>  <span class="tx-summary-key">${keyPart}</span><span class="tx-summary-val">${valPart}</span>${' '.repeat(Math.max(0, 64 - content.length))}<span class="tx-frame-top">│</span>`;
      }
      frag.appendChild(line);
    }

    if (isLive && sponsorships && sponsorships.length > 0) {
      const blank1 = document.createElement('div');
      blank1.className = 'tx-line';
      blank1.innerHTML = `<span class="tx-frame-top">│</span>${' '.repeat(66)}<span class="tx-frame-top">│</span>`;
      frag.appendChild(blank1);

      const header = document.createElement('div');
      header.className = 'tx-line';
      header.innerHTML = `<span class="tx-frame-top">│</span>  <span class="tx-summary-key">gas sponsored</span>${' '.repeat(53)}<span class="tx-frame-top">│</span>`;
      frag.appendChild(header);

      for (const gs of sponsorships) {
        const line = document.createElement('div');
        line.className = 'tx-line';
        const keyPart = `   ${padR(gs.chain, 14)}`;
        const valPart = `${(gs.estimatedCostUsdCents / 100).toFixed(2)} USD actual`;
        const content = `${keyPart}${valPart}`;
        line.innerHTML = `<span class="tx-frame-top">│</span>  <span class="tx-summary-key">${padR(gs.chain, 14)}</span><span class="tx-summary-val">${valPart}</span>${' '.repeat(Math.max(0, 64 - content.length))}<span class="tx-frame-top">│</span>`;
        frag.appendChild(line);
      }
    }

    if (note) {
      const blank2 = document.createElement('div');
      blank2.className = 'tx-line';
      blank2.innerHTML = `<span class="tx-frame-top">│</span>${' '.repeat(66)}<span class="tx-frame-top">│</span>`;
      frag.appendChild(blank2);

      const noteLine = document.createElement('div');
      noteLine.className = 'tx-line';
      noteLine.innerHTML = `<span class="tx-frame-top">│</span>  <span class="tx-summary-hint">${note}</span>${' '.repeat(Math.max(0, 64 - note.length))}<span class="tx-frame-top">│</span>`;
      frag.appendChild(noteLine);
    }

    const rBot = document.createElement('div');
    rBot.className = 'tx-line tx-frame-bot';
    rBot.textContent = '╰' + '─'.repeat(66) + '╯';
    frag.appendChild(rBot);

    out.appendChild(frag);
    out.scrollTop = out.scrollHeight;
  },
};

// =====================================================================
// ROW HANDLE
// =====================================================================
//
// A row is two lines: a header (icon, label, amount, status) and a
// result line that opens under it (prefix, mark, hash, output,
// duration). The header is appended immediately; the result line is
// created empty and hidden until .done()/.skip()/.fail() is called.

function openRow({ icon, label, amount, status }) {
  const out = getConsole();
  if (!out) return noopHandle();
  if (!isStructured(out)) {
    fallbackAppend(`${icon} ${label}  ${amount}  ${status}`);
    return textOnlyHandle(label);
  }

  const frag = document.createDocumentFragment();

  const header = document.createElement('div');
  header.className = 'tx-line tx-row';
  const labelPart = padR(label, 14);
  const amountPart = padL(amount, 16);
  header.innerHTML = `<span class="tx-row-icon">${icon}</span><span class="tx-row-label">${labelPart}</span><span class="tx-row-amount">${amountPart}</span><span class="tx-row-status is-running">${status}</span>`;
  frag.appendChild(header);

  const result = document.createElement('div');
  result.className = 'tx-line tx-row-result';
  result.style.display = 'none';
  frag.appendChild(result);

  out.appendChild(frag);
  out.scrollTop = out.scrollHeight;

  const out2 = getConsole();

  return {
    done({ txHash, outUsdc, durationMs }) {
      header.querySelector('.tx-row-status').className = 'tx-row-status is-success';
      header.querySelector('.tx-row-status').textContent = '✓';

      const hashPart = txHash ? truncHash(txHash) : '';
      const outPart = outUsdc != null ? `${fmtUsdc(outUsdc)} USDC out` : '';
      const timePart = durationMs != null ? fmtSec(durationMs) : '';

      result.style.display = '';
      result.innerHTML = `<span class="tx-row-result-prefix">└─</span><span class="tx-row-result-mark is-success">✓</span>  <span class="tx-row-result-hash">${hashPart}</span><span class="tx-row-result-out">${outPart}</span><span class="tx-row-result-time">${timePart}</span>`;
      if (out2) out2.scrollTop = out2.scrollHeight;
    },
    skip(reason) {
      header.querySelector('.tx-row-status').className = 'tx-row-status is-skipped';
      header.querySelector('.tx-row-status').textContent = '⊘';
      result.style.display = '';
      result.innerHTML = `<span class="tx-row-result-prefix">└─</span><span class="tx-row-result-mark is-skipped">⊘</span>  <span class="tx-row-status is-skipped">${reason || 'skipped'}</span>`;
      if (out2) out2.scrollTop = out2.scrollHeight;
    },
    fail(reason) {
      header.querySelector('.tx-row-status').className = 'tx-row-status is-failed';
      header.querySelector('.tx-row-status').textContent = '✗';
      result.style.display = '';
      result.innerHTML = `<span class="tx-row-result-prefix">└─</span><span class="tx-row-result-mark is-failed">✗</span>  <span class="tx-row-error">${reason || 'failed'}</span>`;
      if (out2) out2.scrollTop = out2.scrollHeight;
    },
    update(status) {
      const s = header.querySelector('.tx-row-status');
      if (s) s.textContent = status;
    },
    note(text) {
      result.style.display = '';
      result.innerHTML = `<span class="tx-row-result-prefix">└─</span><span class="tx-row-status">${text}</span>`;
      if (out2) out2.scrollTop = out2.scrollHeight;
    },
  };
}

function noopHandle() {
  return { done() {}, skip() {}, fail() {}, update() {}, note() {} };
}

function textOnlyHandle(label) {
  const started = Date.now();
  return {
    done({ txHash, outUsdc, durationMs }) {
      const parts = [];
      if (txHash) parts.push(truncHash(txHash));
      if (outUsdc != null) parts.push(`${fmtUsdc(outUsdc)} USDC out`);
      parts.push(durationMs != null ? fmtSec(durationMs) : fmtSec(Date.now() - started));
      fallbackAppend(`  ✓ ${label}  ${parts.join('  ')}`);
    },
    skip(reason) { fallbackAppend(`  ⊘ ${label}  ${reason || 'skipped'}`); },
    fail(reason) { fallbackAppend(`  ✗ ${label}  ${reason || 'failed'}`); },
    update(status) { fallbackAppend(`  ${label}  ${status}`); },
    note(text) { fallbackAppend(`  ${label}  ${text}`); },
  };
}

// =====================================================================
// ICONS
// =====================================================================
//
// One icon per row type. Kept restrained so the console reads as a
// console, not an emoji wall.

function pickIcon(symbol) {
  if (!symbol) return '·';
  const s = String(symbol).toUpperCase();
  if (s === 'USDC' || s === 'USDT' || s === 'DAI') return '💰';
  if (s === 'ETH' || s === 'WETH' || s === 'BNB' || s === 'POL') return '⛽';
  if (s === 'SOL') return '◎';
  if (s === 'BTC' || s === 'WBTC') return '₿';
  return '🐸';
}