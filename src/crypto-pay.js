/**
 * crypto-pay.js — Crypto payment UI.
 *
 * Renders a modal with:
 *   - Method selection (USDC Base, USDC ETH, ETH Base, SOL, BTC)
 *   - The address to send to
 *   - The exact amount
 *   - A QR code
 *   - A live status indicator (polling for confirmation)
 */

import QRCode from 'qrcode';
import { requestCryptoQuote, pollCryptoPayment } from './credits.js';
import { $, el, show, hide } from './ui.js';

const METHODS = [
  { id: 'usdc-base', label: 'USDC on Base', icon: '🔵', hint: 'Cheapest — ~$0.01 gas' },
  { id: 'usdc-ethereum', label: 'USDC on Ethereum', icon: '⚪', hint: '~$5-20 gas' },
  { id: 'eth-base', label: 'ETH on Base', icon: '🔷', hint: '~$0.01 gas' },
  { id: 'sol', label: 'SOL on Solana', icon: '🟣', hint: '~$0.001 gas' },
  { id: 'btc', label: 'Bitcoin', icon: '🟠', hint: 'Varies with mempool' },
];

let pollCancelled = false;

/**
 * Show the crypto payment modal.
 *
 * Resolves with { ok: true, creditsAdded, newBalance } when paid.
 * Rejects if the user closes the modal or payment times out.
 */
export function showCryptoPaymentModal(bundle = 'single') {
  return new Promise((resolve, reject) => {
    pollCancelled = false;

    const modal = buildModal(bundle, resolve, reject);
    document.body.appendChild(modal);
  });
}

function buildModal(bundle, resolve, reject) {
  const overlay = el('div', { class: 'modal-overlay' });
  const modal = el('div', { class: 'modal' });

  overlay.appendChild(modal);

  // Header
  modal.appendChild(el('div', { class: 'modal-header' }, [
    el('h2', { text: 'Pay with crypto' }),
    el('button', {
      class: 'modal-close',
      text: '×',
      onclick: () => {
        pollCancelled = true;
        overlay.remove();
        reject(new Error('Payment cancelled'));
      },
    }),
  ]));

  const body = el('div', { class: 'modal-body' });
  modal.appendChild(body);

  // Step 1: pick a method
  body.appendChild(el('p', {
    class: 'hint',
    text: 'Choose which asset to pay with. USDC on Base is cheapest.',
  }));

  const methodList = el('div', { class: 'crypto-methods' });
  for (const m of METHODS) {
    const btn = el('button', {
      class: 'crypto-method',
      onclick: () => selectMethod(m, bundle, body, overlay, resolve, reject),
    }, [
      el('div', { class: 'crypto-method-left' }, [
        el('span', { class: 'crypto-method-icon', text: m.icon }),
        el('div', {}, [
          el('div', { class: 'crypto-method-label', text: m.label }),
          el('div', { class: 'crypto-method-hint', text: m.hint }),
        ]),
      ]),
      el('span', { class: 'crypto-method-arrow', text: '→' }),
    ]);
    methodList.appendChild(btn);
  }
  body.appendChild(methodList);

  return overlay;
}

async function selectMethod(method, bundle, body, overlay, resolve, reject) {
  // Replace body with loading
  body.innerHTML = '';
  body.appendChild(el('p', { class: 'hint', text: 'Fetching quote...' }));

  let quote;
  try {
    quote = await requestCryptoQuote(bundle, method.id);
  } catch (err) {
    body.innerHTML = '';
    body.appendChild(el('p', { class: 'error', text: `Failed to get quote: ${err.message}` }));
    body.appendChild(el('button', {
      class: 'btn btn-secondary',
      text: 'Try another method',
      onclick: () => {
        overlay.remove();
        // Re-open
        showCryptoPaymentModal(bundle).then(resolve).catch(reject);
      },
    }));
    return;
  }

  // Render payment instructions
  body.innerHTML = '';
  body.appendChild(el('h3', { text: 'Send the exact amount' }));

  const infoBox = el('div', { class: 'crypto-info' });

  infoBox.appendChild(buildField('Chain', quote.chain));
  infoBox.appendChild(buildField('Token', quote.token));
  infoBox.appendChild(buildField('Address', quote.address, true));
  infoBox.appendChild(buildField('Amount', `${quote.amount} ${quote.token}`, true, true));

  body.appendChild(infoBox);

  // QR code
  const qrContainer = el('div', { class: 'crypto-qr' });
  body.appendChild(qrContainer);

  // Build QR payload — scheme varies by chain
  const qrPayload = buildQrPayload(quote);
  QRCode.toCanvas(qrPayload, { width: 220, margin: 2 })
    .then((canvas) => {
      canvas.style.background = '#fff';
      canvas.style.borderRadius = '8px';
      canvas.style.padding = '12px';
      qrContainer.appendChild(canvas);
    })
    .catch((err) => {
      qrContainer.appendChild(el('p', { class: 'error', text: `QR failed: ${err.message}` }));
    });

  // Status area
  const status = el('div', { class: 'crypto-status' }, [
    el('div', { class: 'spinner' }),
    el('p', { text: 'Waiting for payment...' }),
  ]);
  body.appendChild(status);

  // Cancel button
  body.appendChild(el('button', {
    class: 'btn btn-secondary btn-block',
    text: 'Cancel',
    onclick: () => {
      pollCancelled = true;
      overlay.remove();
      reject(new Error('Payment cancelled'));
    },
  }));

  // Start polling
  try {
    const result = await pollCryptoPayment(quote.payment_id, {
      onTick: (attempt, total) => {
        if (pollCancelled) return;
        const p = status.querySelector('p');
        if (p) p.textContent = `Checking for payment... (${attempt}/${total})`;
      },
    });

    if (pollCancelled) return;

    // Success!
    status.innerHTML = '';
    status.appendChild(el('div', { class: 'success-icon', text: '✓' }));
    status.appendChild(el('p', { text: `Payment received! ${result.creditsAdded} credit${result.creditsAdded > 1 ? 's' : ''} added.` }));

    setTimeout(() => {
      overlay.remove();
      resolve(result);
    }, 1500);
  } catch (err) {
    if (pollCancelled) return;
    status.innerHTML = '';
    status.appendChild(el('p', { class: 'error', text: `Payment failed: ${err.message}` }));
  }
}

function buildField(label, value, copyable = false, highlight = false) {
  const field = el('div', { class: 'crypto-field' });
  field.appendChild(el('div', { class: 'crypto-field-label', text: label }));
  const valueEl = el('div', { class: 'crypto-field-value' + (highlight ? ' highlight' : ''), text: value });
  field.appendChild(valueEl);
  if (copyable) {
    const copyBtn = el('button', {
      class: 'copy-btn',
      text: 'Copy',
      onclick: async () => {
        try {
          await navigator.clipboard.writeText(value);
          copyBtn.textContent = 'Copied!';
          setTimeout(() => (copyBtn.textContent = 'Copy'), 1500);
        } catch {
          copyBtn.textContent = 'Failed';
        }
      },
    });
    field.appendChild(copyBtn);
  }
  return field;
}

function buildQrPayload(quote) {
  // Standard URI schemes for each chain
  if (quote.chain === 'bitcoin') {
    return `bitcoin:${quote.address}?amount=${quote.amount}`;
  }
  if (quote.chain === 'solana') {
    return `solana:${quote.address}?amount=${quote.amount}`;
  }
  // EVM: use EIP-681 for native, plain address for ERC-20
  if (quote.token === 'ETH') {
    return `ethereum:${quote.address}?value=${quote.amount_raw}`;
  }
  // ERC-20: just the address, since EIP-681 token transfers are rarely supported
  return quote.address;
}