/**
 * crypto-pay.js — Crypto payment modal with bundle picker.
 */

import QRCode from 'qrcode';
import { requestCryptoQuote, pollCryptoPayment } from './credits.js';
import { el } from './ui.js';

const BUNDLES = [
  { id: 'single',  label: '1 credit',  price: '$5',  hint: '$5.00 per sweep' },
  { id: 'pack-5',  label: '5 credits', price: '$20', hint: '$4.00 per sweep' },
  { id: 'pack-10', label: '10 credits',price: '$40', hint: '$4.00 per sweep' },
  { id: 'pack-25', label: '25 credits',price: '$80', hint: '$3.20 per sweep', badge: 'Best value' },
];

const METHODS = [
  { id: 'usdc-base',     label: 'USDC on Base',     icon: '🔵', hint: 'Cheapest — ~$0.01 gas' },
  { id: 'usdc-ethereum', label: 'USDC on Ethereum', icon: '⚪', hint: '~$5-20 gas' },
  { id: 'eth-base',      label: 'ETH on Base',      icon: '🔷', hint: '~$0.01 gas' },
  { id: 'sol',           label: 'SOL on Solana',    icon: '🟣', hint: '~$0.001 gas' },
  { id: 'btc',           label: 'Bitcoin',          icon: '🟠', hint: 'Varies with mempool' },
];

let pollCancelled = false;

export function showCryptoPaymentModal(defaultBundle = 'single') {
  return new Promise((resolve, reject) => {
    pollCancelled = false;
    const modal = buildModal(defaultBundle, resolve, reject);
    document.body.appendChild(modal);
  });
}

function buildModal(defaultBundle, resolve, reject) {
  const overlay = el('div', { class: 'modal-overlay' });
  const modal = el('div', { class: 'modal modal-wide' });
  overlay.appendChild(modal);

  modal.appendChild(el('div', { class: 'modal-header' }, [
    el('h2', { text: 'Buy sweep credits' }),
    el('button', {
      class: 'modal-close',
      text: '×',
      onclick: () => { pollCancelled = true; overlay.remove(); reject(new Error('Cancelled')); },
    }),
  ]));

  const body = el('div', { class: 'modal-body' });
  modal.appendChild(body);

  // ---- Step 1: pick a bundle ----
  body.appendChild(el('p', { class: 'hint', text: 'Credits never expire. Pick a bundle:' }));

  const bundleList = el('div', { class: 'bundle-list' });
  for (const b of BUNDLES) {
    const btn = el('button', {
      class: 'bundle-card' + (b.badge ? ' featured' : ''),
      onclick: () => showMethodPicker(b, body, overlay, resolve, reject),
    }, [
      b.badge ? el('div', { class: 'bundle-badge', text: b.badge }) : null,
      el('div', { class: 'bundle-label', text: b.label }),
      el('div', { class: 'bundle-price', text: b.price }),
      el('div', { class: 'bundle-hint', text: b.hint }),
    ].filter(Boolean));
    bundleList.appendChild(btn);
  }
  body.appendChild(bundleList);

  return overlay;
}

function showMethodPicker(bundle, body, overlay, resolve, reject) {
  body.innerHTML = '';

  body.appendChild(el('button', {
    class: 'link-back',
    text: '← Back to bundles',
    onclick: () => {
      body.innerHTML = '';
      const modal = overlay.querySelector('.modal');
      modal.innerHTML = '';
      modal.appendChild(buildModalContent(resolve, reject));
    },
  }));

  body.appendChild(el('h3', { text: `Pay ${bundle.price} — choose a method` }));

  const methodList = el('div', { class: 'crypto-methods' });
  for (const m of METHODS) {
    methodList.appendChild(el('button', {
      class: 'crypto-method',
      onclick: () => selectMethod(m, bundle, body, overlay, resolve, reject),
    }, [
      el('span', { class: 'crypto-method-icon', text: m.icon }),
      el('div', {}, [
        el('div', { class: 'crypto-method-label', text: m.label }),
        el('div', { class: 'crypto-method-hint', text: m.hint }),
      ]),
      el('span', { class: 'crypto-method-arrow', text: '→' }),
    ]));
  }
  body.appendChild(methodList);
}

async function selectMethod(method, bundle, body, overlay, resolve, reject) {
  body.innerHTML = '';
  body.appendChild(el('p', { class: 'hint', text: 'Fetching quote...' }));

  let quote;
  try {
    quote = await requestCryptoQuote(bundle.id, method.id);
  } catch (err) {
    body.innerHTML = '';
    body.appendChild(el('p', { class: 'error', text: `Failed: ${err.message}` }));
    body.appendChild(el('button', {
      class: 'btn btn-secondary',
      text: 'Try another method',
      onclick: () => { overlay.remove(); showCryptoPaymentModal(bundle.id).then(resolve).catch(reject); },
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

  const qrPayload = buildQrPayload(quote);
  QRCode.toCanvas(qrPayload, { width: 220, margin: 2 })
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
    onclick: () => { pollCancelled = true; overlay.remove(); reject(new Error('Cancelled')); },
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

    setTimeout(() => { overlay.remove(); resolve(result); }, 1500);
  } catch (err) {
    if (pollCancelled) return;
    status.innerHTML = '';
    status.appendChild(el('p', { class: 'error', text: `Failed: ${err.message}` }));
  }
}

function buildModalContent(resolve, reject) {
  const fragment = document.createDocumentFragment();
  fragment.appendChild(el('div', { class: 'modal-header' }, [
    el('h2', { text: 'Buy sweep credits' }),
    el('button', {
      class: 'modal-close',
      text: '×',
      onclick: () => { pollCancelled = true; reject(new Error('Cancelled')); },
    }),
  ]));
  const body = el('div', { class: 'modal-body' });
  body.appendChild(el('p', { class: 'hint', text: 'Credits never expire. Pick a bundle:' }));
  const bundleList = el('div', { class: 'bundle-list' });
  for (const b of BUNDLES) {
    bundleList.appendChild(el('button', {
      class: 'bundle-card' + (b.badge ? ' featured' : ''),
      onclick: (e) => {
        const overlay = e.target.closest('.modal-overlay');
        showMethodPicker(b, overlay.querySelector('.modal-body'), overlay, resolve, reject);
      },
    }, [
      b.badge ? el('div', { class: 'bundle-badge', text: b.badge }) : null,
      el('div', { class: 'bundle-label', text: b.label }),
      el('div', { class: 'bundle-price', text: b.price }),
      el('div', { class: 'bundle-hint', text: b.hint }),
    ].filter(Boolean)));
  }
  body.appendChild(bundleList);
  fragment.appendChild(body);
  return fragment;
}

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

function buildQrPayload(quote) {
  if (quote.chain === 'bitcoin') return `bitcoin:${quote.address}?amount=${quote.amount}`;
  if (quote.chain === 'solana') return `solana:${quote.address}?amount=${quote.amount}`;
  if (quote.token === 'ETH') return `ethereum:${quote.address}?value=${quote.amount_raw}`;
  return quote.address;
}