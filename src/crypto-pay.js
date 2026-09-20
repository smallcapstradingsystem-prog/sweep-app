/**
 * crypto-pay.js — Crypto payment modal with token → chain picker.
 *
 * showCryptoPaymentModal accepts an optional context object:
 *   { gap: number, suggestedBundle: string }
 *
 * When `gap` is present, a banner at the top of the modal explains
 * that the user needs `gap` more credits to continue, and the bundle
 * picker highlights the smallest bundle that covers the gap.
 */

import QRCode from 'qrcode';
import { requestCryptoQuote, pollCryptoPayment, newIdempotencyKey } from './credits.js';
import { el } from './ui.js';

const BUNDLES = [
  { id: 'single',  label: '1 credit',  price: '$10',  hint: '$10.00 per wallet', credits: 1 },
  { id: 'pack-5',  label: '5 credits', price: '$20',  hint: '$4.00 per wallet',  credits: 5 },
  { id: 'pack-10', label: '10 credits',price: '$40',  hint: '$4.00 per wallet',  credits: 10 },
  { id: 'pack-25', label: '25 credits',price: '$80',  hint: '$3.20 per wallet',  credits: 25, badge: 'Best value' },
  { id: 'pack-50', label: '50 credits',price: '$150', hint: '$3.00 per wallet',  credits: 50 },
];

const TOKENS = [
  {
    id: 'usdc', label: 'USDC', icon: '🔵', hint: 'USD Coin — stablecoin',
    chains: [
      { id: 'usdc-base',     label: 'Base',     hint: 'Cheapest — ~$0.01 gas' },
      { id: 'usdc-arbitrum', label: 'Arbitrum', hint: '~$0.02 gas' },
      { id: 'usdc-optimism', label: 'Optimism', hint: '~$0.02 gas' },
      { id: 'usdc-polygon',  label: 'Polygon',  hint: '~$0.01 gas' },
      { id: 'usdc-bnb',      label: 'BNB Chain',hint: '~$0.05 gas' },
      { id: 'usdc-ethereum', label: 'Ethereum', hint: '~$5-20 gas' },
    ],
  },
  {
    id: 'usdt', label: 'USDT', icon: '🟢', hint: 'Tether — stablecoin',
    chains: [
      { id: 'usdt-base',     label: 'Base',     hint: 'Cheapest — ~$0.01 gas' },
      { id: 'usdt-arbitrum', label: 'Arbitrum', hint: '~$0.02 gas' },
      { id: 'usdt-optimism', label: 'Optimism', hint: '~$0.02 gas' },
      { id: 'usdt-polygon',  label: 'Polygon',  hint: '~$0.01 gas' },
      { id: 'usdt-bnb',      label: 'BNB Chain',hint: '~$0.05 gas' },
      { id: 'usdt-ethereum', label: 'Ethereum', hint: '~$5-20 gas' },
    ],
  },
  {
    id: 'eth', label: 'ETH', icon: '🔷', hint: 'Native ETH on Base',
    chains: [
      { id: 'eth-base', label: 'Base', hint: '~$0.01 gas' },
    ],
  },
  {
    id: 'sol', label: 'SOL', icon: '🟣', hint: 'Native Solana',
    chains: [
      { id: 'sol', label: 'Solana', hint: '~$0.001 gas' },
    ],
  },
  {
    id: 'btc', label: 'BTC', icon: '🟠', hint: 'Native Bitcoin',
    chains: [
      { id: 'btc', label: 'Bitcoin', hint: 'Varies with mempool' },
    ],
  },
];

let pollCancelled = false;

export function showCryptoPaymentModal(defaultBundle = 'single', context = null) {
  return new Promise((resolve, reject) => {
    pollCancelled = false;
    const overlay = el('div', { class: 'modal-overlay' });
    const modal = el('div', { class: 'modal modal-wide' });
    overlay.appendChild(modal);
    document.body.appendChild(overlay);

    const ctx = {
      overlay,
      modal,
      resolve,
      reject,
      context,
      cancel: () => {
        pollCancelled = true;
        overlay.remove();
        reject(new Error('Cancelled'));
      },
    };

    renderBundlePicker(ctx);
  });
}

// =====================================================================
// RENDERERS
// =====================================================================

function modalHeader(ctx) {
  return el('div', { class: 'modal-header' }, [
    el('h2', { text: 'Buy sweep credits' }),
    el('button', {
      class: 'modal-close',
      text: '×',
      onclick: ctx.cancel,
    }),
  ]);
}

function contextBanner(ctx) {
  const c = ctx.context;
  if (!c || !c.gap) return null;

  const count = c.gap;
  const text = count === 1
    ? `You need 1 more credit to continue this sweep.`
    : `You need ${count} more credits to continue this sweep.`;

  return el('div', {
    class: 'bundle-context-banner',
    style: 'padding:12px 16px; margin: 16px 24px 0; background: rgba(88,166,255,0.1); border-left: 3px solid #58a6ff; border-radius: 4px; font-size: 13px; color: #c9d1d9;',
  }, [
    el('div', { style: 'font-weight:600; color:#e6edf3; margin-bottom:4px;', text: 'More credits required' }),
    el('div', { text }),
  ]);
}

function renderBundlePicker(ctx) {
  ctx.modal.innerHTML = '';
  ctx.modal.appendChild(modalHeader(ctx));

  const banner = contextBanner(ctx);
  if (banner) ctx.modal.appendChild(banner);

  const body = el('div', { class: 'modal-body' });
  body.appendChild(el('p', { class: 'hint', text: 'Credits never expire. One credit per wallet swept. Pick a bundle:' }));

  // Highlight the smallest bundle that covers the requested gap, if any.
  const suggested = ctx.context?.suggestedBundle;

  const list = el('div', { class: 'bundle-list' });
  for (const b of BUNDLES) {
    const isSuggested = suggested && b.id === suggested;
    list.appendChild(el('button', {
      class: 'bundle-card'
        + (b.badge ? ' featured' : '')
        + (isSuggested ? ' suggested' : ''),
      style: isSuggested ? 'outline: 2px solid #58a6ff; outline-offset: -2px;' : '',
      onclick: () => renderTokenPicker(ctx, b),
    }, [
      b.badge ? el('div', { class: 'bundle-badge', text: b.badge }) : null,
      isSuggested ? el('div', { class: 'bundle-badge', style: 'background:#58a6ff;', text: 'Suggested' }) : null,
      el('div', { class: 'bundle-label', text: b.label }),
      el('div', { class: 'bundle-price', text: b.price }),
      el('div', { class: 'bundle-hint', text: b.hint }),
    ].filter(Boolean)));
  }
  body.appendChild(list);
  ctx.modal.appendChild(body);
}

function renderTokenPicker(ctx, bundle) {
  ctx.modal.innerHTML = '';
  ctx.modal.appendChild(modalHeader(ctx));

  const banner = contextBanner(ctx);
  if (banner) ctx.modal.appendChild(banner);

  const body = el('div', { class: 'modal-body' });

  body.appendChild(el('button', {
    class: 'link-back',
    text: '← Back to bundles',
    onclick: () => renderBundlePicker(ctx),
  }));

  body.appendChild(el('h3', { text: `Pay ${bundle.price} — choose a token` }));

  const list = el('div', { class: 'crypto-methods' });
  for (const t of TOKENS) {
    list.appendChild(el('button', {
      class: 'crypto-method',
      onclick: () => {
        if (t.chains.length === 1) {
          renderPayment(ctx, bundle, t.chains[0], t);
        } else {
          renderChainPicker(ctx, bundle, t);
        }
      },
    }, [
      el('span', { class: 'crypto-method-icon', text: t.icon }),
      el('div', {}, [
        el('div', { class: 'crypto-method-label', text: t.label }),
        el('div', { class: 'crypto-method-hint', text: t.hint }),
      ]),
      el('span', { class: 'crypto-method-arrow', text: '→' }),
    ]));
  }
  body.appendChild(list);
  ctx.modal.appendChild(body);
}

function renderChainPicker(ctx, bundle, token) {
  ctx.modal.innerHTML = '';
  ctx.modal.appendChild(modalHeader(ctx));

  const banner = contextBanner(ctx);
  if (banner) ctx.modal.appendChild(banner);

  const body = el('div', { class: 'modal-body' });

  body.appendChild(el('button', {
    class: 'link-back',
    text: '← Back to tokens',
    onclick: () => renderTokenPicker(ctx, bundle),
  }));

  body.appendChild(el('h3', { text: `Pay ${bundle.price} in ${token.label} — choose a chain` }));

  const list = el('div', { class: 'crypto-methods' });
  for (const c of token.chains) {
    list.appendChild(el('button', {
      class: 'crypto-method',
      onclick: () => renderPayment(ctx, bundle, c, token),
    }, [
      el('span', { class: 'crypto-method-icon', text: token.icon }),
      el('div', {}, [
        el('div', { class: 'crypto-method-label', text: `${token.label} on ${c.label}` }),
        el('div', { class: 'crypto-method-hint', text: c.hint }),
      ]),
      el('span', { class: 'crypto-method-arrow', text: '→' }),
    ]));
  }
  body.appendChild(list);
  ctx.modal.appendChild(body);
}

async function renderPayment(ctx, bundle, chain, token) {
  ctx.modal.innerHTML = '';
  ctx.modal.appendChild(modalHeader(ctx));

  const body = el('div', { class: 'modal-body' });

  const backTarget = token.chains.length > 1
    ? () => renderChainPicker(ctx, bundle, token)
    : () => renderTokenPicker(ctx, bundle);

  body.appendChild(el('button', {
    class: 'link-back',
    text: token.chains.length > 1 ? `← Back to ${token.label} chains` : '← Back to tokens',
    onclick: backTarget,
  }));

  body.appendChild(el('p', { class: 'hint', text: 'Fetching quote...' }));
  ctx.modal.appendChild(body);

  const quoteIdempotencyKey = newIdempotencyKey();

  let quote;
  try {
    quote = await requestCryptoQuote(bundle.id, chain.id, {
      idempotencyKey: quoteIdempotencyKey,
    });
  } catch (err) {
    body.innerHTML = '';
    body.appendChild(el('p', { class: 'error', text: `Failed: ${err.message}` }));
    body.appendChild(el('button', {
      class: 'btn btn-secondary',
      text: 'Try another',
      onclick: backTarget,
    }));
    return;
  }

  body.innerHTML = '';
  body.appendChild(el('h3', { text: 'Send the exact amount' }));

  const infoBox = el('div', { class: 'crypto-info' });
  infoBox.appendChild(field('Chain', quote.chain));
  infoBox.appendChild(field('Token', quote.token));
  infoBox.appendChild(field('Address', quote.address, true));
  infoBox.appendChild(field('Amount', `${quote.amount} ${quote.token}`, true, true));
  infoBox.appendChild(field('You receive', `${quote.credits} credit${quote.credits > 1 ? 's' : ''}`));
  body.appendChild(infoBox);

  const qrContainer = el('div', { class: 'crypto-qr' });
  body.appendChild(qrContainer);

  QRCode.toCanvas(quote.address, { width: 220, margin: 2 })
    .then((canvas) => {
      canvas.style.background = '#fff';
      canvas.style.borderRadius = '8px';
      canvas.style.padding = '12px';
      qrContainer.appendChild(canvas);
    })
    .catch(() => {});

  const status = el('div', { class: 'crypto-status' }, [
    el('div', { class: 'spinner' }),
    el('p', { text: 'Waiting for payment...' }),
  ]);
  body.appendChild(status);

  body.appendChild(el('button', {
    class: 'btn btn-secondary btn-block',
    text: 'Cancel',
    onclick: ctx.cancel,
  }));

  try {
    const result = await pollCryptoPayment(quote.payment_id, {
      onTick: (attempt, total) => {
        if (pollCancelled) return;
        const p = status.querySelector('p');
        if (p) p.textContent = `Checking for payment... (${attempt}/${total})`;
      },
    });
    if (pollCancelled) return;

    status.innerHTML = '';
    status.appendChild(el('div', { class: 'success-icon', text: '✓' }));
    status.appendChild(el('p', { text: `Payment received! ${result.creditsAdded} credit${result.creditsAdded > 1 ? 's' : ''} added.` }));

    setTimeout(() => {
      ctx.overlay.remove();
      ctx.resolve(result);
    }, 1500);
  } catch (err) {
    if (pollCancelled) return;
    status.innerHTML = '';
    status.appendChild(el('p', { class: 'error', text: `Failed: ${err.message}` }));
  }
}

// =====================================================================
// HELPERS
// =====================================================================

function field(label, value, copyable = false, highlight = false) {
  const f = el('div', { class: 'crypto-field' });
  f.appendChild(el('div', { class: 'crypto-field-label', text: label }));
  f.appendChild(el('div', { class: 'crypto-field-value' + (highlight ? ' highlight' : ''), text: value }));
  if (copyable) {
    const btn = el('button', {
      class: 'copy-btn',
      text: 'Copy',
      onclick: async () => {
        try {
          await navigator.clipboard.writeText(value);
          btn.textContent = 'Copied!';
          setTimeout(() => (btn.textContent = 'Copy'), 1500);
        } catch { btn.textContent = 'Failed'; }
      },
    });
    f.appendChild(btn);
  }
  return f;
}