/**
 * main.js — Application entry point.
 */

import { ethers } from 'ethers';
import QRCode from 'qrcode';
import { state, resetState, clearAll } from './state.js';
import { createWallet } from './wallet.js';
import { validateMnemonic, deriveAll } from './derive.js';
import { previewWallet as previewEvm, sweepEvm, getProvider, CHAINS as EVM_CHAINS } from './evm.js';
import { previewSolanaWallet, sweepSolana, getConnection } from './solana.js';
import { previewBitcoinWallet, sweepBitcoin } from './bitcoin.js';
import { $, $$, el, show, hide, logLine, clearLog } from './ui.js';
import { initSentry, initPlausible, reportError, track } from './telemetry.js';
import { getClientId, fetchBalance, consumeCredit, invalidateBalanceCache } from './credits.js';
import { showCryptoPaymentModal } from './crypto-pay.js';

const WC_PROJECT_ID = '74d3ed4f87d14b6cac7556234dfb72a3';

// =====================================================================
// UI HELPERS
// =====================================================================

function showWalletSection(type) {
  $$('.wallet-section').forEach((s) => { s.style.display = 'none'; });
  const target = $(`#wallet-${type}`);
  if (target) target.style.display = '';
}

function readInputs() {
  const walletType = $('input[name=wallet-type]:checked')?.value || 'mnemonic';
  const destination = $('#destination').value.trim();
  const families = {
    evm: $('#family-evm').checked,
    solana: $('#family-solana').checked,
    bitcoin: $('#family-bitcoin').checked,
  };
  const evmChains = $$('#chain-list input[type=checkbox]:checked').map((cb) => cb.value);

  let mnemonics = [];
  if (walletType === 'mnemonic') {
    const text = $('#phrases').value.trim();
    mnemonics = text.split('\n').map((s) => s.trim()).filter(Boolean);
  }

  Object.assign(state, { walletType, destination, families, evmChains, mnemonics });
  return { walletType, destination, families, evmChains, mnemonics };
}

function validateInputs({ walletType, destination, families, mnemonics }) {
  const errors = [];
  if (!destination) errors.push('Destination address is required');

  if (walletType === 'mnemonic') {
    if (mnemonics.length === 0) errors.push('At least one mnemonic is required');
    for (let i = 0; i < mnemonics.length; i++) {
      if (!validateMnemonic(mnemonics[i])) {
        errors.push(`Mnemonic #${i + 1} is not a valid BIP-39 phrase`);
      }
    }
  }

  if (walletType !== 'mnemonic') {
    if (families.solana) errors.push('Solana sweep requires a mnemonic');
    if (families.bitcoin) errors.push('Bitcoin sweep requires a mnemonic');
  }

  return errors;
}

function updateCreditsBadge(balance) {
  const badge = $('#credits-badge');
  if (!badge) return;
  if (balance > 0) {
    badge.textContent = `${balance} credit${balance > 1 ? 's' : ''}`;
    badge.className = 'credits-badge credits-available';
  } else {
    badge.textContent = 'No credits';
    badge.className = 'credits-badge credits-empty';
  }
}

// =====================================================================
// CONNECT WALLET
// =====================================================================

async function connectWalletAndStore() {
  const { walletType } = readInputs();
  track.walletSelected(walletType);

  try {
    if (walletType === 'mnemonic') {
      logLine('Mnemonic mode: keys will be derived during Preview.');
      return;
    }

    if (walletType === 'extension') {
      logLine('Connecting to browser wallet...');
      const backend = await createWallet({ type: 'extension' });
      state.wallet = backend;
      const addr = await backend.getAddress();
      logLine(`Connected: ${addr}`);
      $('#connected-address').textContent = addr;
      show('#connected-banner');
      return;
    }

    if (walletType === 'walletconnect') {
      logLine('Connecting WalletConnect...');
      const qrContainer = $('#wc-qr');
      qrContainer.innerHTML = '';

      const backend = await createWallet({
        type: 'walletconnect',
        wcProjectId: WC_PROJECT_ID,
        wcOnUri: (uri) => {
          logLine('Scan this QR with your mobile wallet:');
          QRCode.toCanvas(uri, { width: 240, margin: 2 })
            .then((canvas) => {
              canvas.style.background = '#fff';
              canvas.style.borderRadius = '8px';
              canvas.style.padding = '12px';
              qrContainer.appendChild(canvas);
            })
            .catch((err) => logLine(`QR render failed: ${err.message}`));
        },
      });

      state.wallet = backend;
      const addr = await backend.getAddress();
      logLine(`Connected: ${addr}`);
      $('#connected-address').textContent = addr;
      show('#connected-banner');
      return;
    }

    if (walletType === 'ledger') {
      logLine('Requesting Ledger access via WebHID...');
      const backend = await createWallet({ type: 'ledger' });
      state.wallet = backend;
      const addr = await backend.getAddress();
      logLine(`Ledger connected: ${addr}`);
      $('#connected-address').textContent = addr;
      show('#connected-banner');
      return;
    }

    if (walletType === 'trezor') {
      logLine('Requesting Trezor access...');
      const backend = await createWallet({ type: 'trezor' });
      state.wallet = backend;
      const addr = await backend.getAddress();
      logLine(`Trezor connected: ${addr}`);
      $('#connected-address').textContent = addr;
      show('#connected-banner');
      return;
    }
  } catch (e) {
    logLine(`ERROR: ${e.message}`);
    reportError(e, { phase: 'connect', walletType });
    track.error('connect_failed');
  }
}

// =====================================================================
// PREVIEW
// =====================================================================

async function runPreview() {
  const startTime = Date.now();
  clearLog();
  const inputs = readInputs();
  const errors = validateInputs(inputs);
  if (errors.length > 0) {
    for (const e of errors) logLine(`ERROR: ${e}`);
    return;
  }

  track.previewStarted({
    walletType: inputs.walletType,
    families: Object.entries(inputs.families).filter(([, v]) => v).map(([k]) => k),
    chainCount: inputs.evmChains.length,
    mnemonicCount: inputs.mnemonics.length,
  });

  try {
    if (inputs.walletType === 'mnemonic') {
      logLine(`Deriving keys for ${inputs.mnemonics.length} mnemonic(s)...`);
      state.derivedKeys = deriveAll(inputs.mnemonics, inputs.families);
      logLine(`Derived: ${state.derivedKeys.evm.length} EVM, ${state.derivedKeys.solana.length} Solana, ${state.derivedKeys.bitcoin.length} Bitcoin`);
      for (const err of state.derivedKeys.errors) logLine(`WARN: ${err}`);
    } else {
      if (!state.wallet) {
        logLine('ERROR: connect your wallet first');
        return;
      }
      const addr = await state.wallet.getAddress();
      state.derivedKeys = { evm: [{ address: addr, wallet: null, index: 0 }], solana: [], bitcoin: [], errors: [] };
      logLine(`Using connected address: ${addr}`);
    }

    state.previews = { evm: [], solana: [], bitcoin: [] };

    for (const { address, index } of state.derivedKeys.evm) {
      for (const chain of state.evmChains) {
        logLine(`\nPreviewing ${chain} ${address}...`);
        try {
          const p = await previewEvm(chain, address);
          state.previews.evm.push({ index, ...p });
          logLine(`  native: ${p.native?.formatted ?? '0'} ${p.native?.symbol ?? ''}`);
          for (const t of p.tokens) logLine(`  ${t.symbol}: ${t.formatted}`);
          if (p.error) logLine(`  warning: ${p.error}`);
        } catch (e) {
          logLine(`  ERROR: ${e.message}`);
          reportError(e, { phase: 'preview_evm', chain });
        }
      }
    }

    if (inputs.families.solana && state.derivedKeys.solana.length > 0) {
      const conn = getConnection();
      for (const { address, index } of state.derivedKeys.solana) {
        logLine(`\nPreviewing Solana ${address}...`);
        try {
          const p = await previewSolanaWallet(conn, address);
          state.previews.solana.push({ index, ...p });
          logLine(`  SOL: ${p.sol?.formatted ?? 0}`);
          logLine(`  tokens: ${p.tokens.length}`);
        } catch (e) {
          logLine(`  ERROR: ${e.message}`);
        }
      }
    }

    if (inputs.families.bitcoin && state.derivedKeys.bitcoin.length > 0) {
      for (const { address, index } of state.derivedKeys.bitcoin) {
        logLine(`\nPreviewing Bitcoin ${address}...`);
        try {
          const p = await previewBitcoinWallet(address);
          state.previews.bitcoin.push({ index, ...p });
          logLine(`  utxos: ${p.utxos.length}, balance: ${p.balance} sats`);
        } catch (e) {
          logLine(`  ERROR: ${e.message}`);
        }
      }
    }

    logLine('\nPreview complete. Review before sweeping.');
    show('#run-button');

    const tokensFound =
      state.previews.evm.reduce((n, p) => n + p.tokens.length, 0) +
      state.previews.solana.reduce((n, p) => n + p.tokens.length, 0);

    track.previewCompleted({ walletType: inputs.walletType, durationMs: Date.now() - startTime, tokensFound });
  } catch (e) {
    reportError(e, { phase: 'preview_fatal' });
    track.error('preview_fatal');
    throw e;
  }
}

// =====================================================================
// PAYMENT
// =====================================================================

async function requirePayment() {
  track.paymentStarted('crypto');
  try {
    const result = await showCryptoPaymentModal('pack-5');
    track.paymentCompleted('crypto');
    return result;
  } catch (err) {
    throw err;
  }
}

// =====================================================================
// SWEEP
// =====================================================================

async function runSweep(live) {
  const startTime = Date.now();
  if (!state.derivedKeys) {
    logLine('ERROR: run Preview first');
    return;
  }

  // ---- PAYMENT GATE (only for live) ----
  if (live) {
    logLine('\n⚠ Reminder: each wallet needs native gas to broadcast.');
    logLine('  Ethereum mainnet: ~0.005 ETH');
    logLine('  Base / Arbitrum / Optimism: ~0.0002 ETH');
    logLine('  Polygon: ~0.5 POL\n');

    let balance = await fetchBalance();

    if (balance < 1) {
      logLine('No credits available. Opening payment modal...');
      try {
        await requirePayment();
        balance = await fetchBalance({ force: true });
        logLine(`Payment complete. Credits: ${balance}`);
      } catch (err) {
        logLine(`Payment cancelled or failed: ${err.message}`);
        return;
      }
    }

    if (balance < 1) {
      logLine('ERROR: still no credits after payment.');
      return;
    }

    const confirm = prompt(`This live sweep will consume 1 credit (you have ${balance}). Type LIVE_SWEEP_NOW to confirm:`);
    if (confirm !== 'LIVE_SWEEP_NOW') {
      logLine('Live sweep cancelled.');
      return;
    }

    try {
      const newBalance = await consumeCredit('sweep');
      logLine(`Credit consumed. Remaining: ${newBalance}`);
      updateCreditsBadge(newBalance);
    } catch (err) {
      logLine(`ERROR: could not consume credit: ${err.message}`);
      return;
    }
  }

  const dryRun = !live;
  logLine(`\n=== ${dryRun ? 'DRY RUN' : 'LIVE SWEEP'} STARTED ===`);
  track.sweepStarted(live);

  state.results = { evm: [], solana: [], bitcoin: [] };
  let successes = 0;
  let failures = 0;

  try {
    for (const entry of state.derivedKeys.evm) {
      const address = entry.address;
      for (const chain of state.evmChains) {
        logLine(`\n[EVM ${chain}] ${address}`);
        try {
          const provider = getProvider(chain);

          let signer;
          if (state.walletType === 'mnemonic') {
            signer = entry.wallet.connect(provider);
          } else if (state.walletType === 'extension') {
            // Ask the extension to switch to this chain before signing
            const cfg = EVM_CHAINS[chain];
            if (state.wallet.switchChain) {
              await state.wallet.switchChain(cfg.chainId);
            }
            signer = await state.wallet.getEthersSigner(provider);
          } else {
            signer = await state.wallet.getEthersSigner(provider);
          }

          const preview = state.previews.evm.find((p) => p.address === address && p.chain === chain);
          const tokens = preview?.tokens || [];

          const r = await sweepEvm(chain, signer, state.destination, { dryRun, tokens, slippageBps: 100 });
          state.results.evm.push({ chain, address, ...r });

          for (const s of r.swaps) {
            logLine(`  swap ${s.symbol}: ${s.status}${s.txHash ? ' ' + s.txHash : ''}${s.note ? ' (' + s.note + ')' : ''}${s.error ? ' — ' + s.error : ''}`);
            if (s.status === 'SUCCESS') successes++;
            if (s.status === 'FAILED' || s.status === 'ERROR') failures++;
          }
          for (const t of r.transfers) {
            logLine(`  transfer ${t.symbol}: ${t.status}${t.txHash ? ' ' + t.txHash : ''}`);
            if (t.status === 'SUCCESS') successes++;
            if (t.status === 'FAILED' || t.status === 'ERROR') failures++;
          }
          for (const e of r.errors) logLine(`  ERROR: ${e}`);
        } catch (e) {
          logLine(`  FATAL: ${e.message}`);
          reportError(e, { phase: 'sweep_evm', chain });
        }
      }
    }

    if (state.families?.solana && state.derivedKeys.solana.length > 0) {
      const conn = getConnection();
      for (const { keypair, address, index } of state.derivedKeys.solana) {
        logLine(`\n[Solana] ${address}`);
        try {
          const r = await sweepSolana(conn, keypair, state.destination, { dryRun });
          state.results.solana.push({ index, ...r });
          for (const s of r.swaps) {
            logLine(`  swap ${s.mint.slice(0, 8)}: ${s.status} ${s.signature || ''}`);
            if (s.status === 'SUCCESS') successes++;
            if (s.status === 'FAILED' || s.status === 'ERROR') failures++;
          }
          for (const t of r.transfers) {
            logLine(`  transfer ${t.mint.slice(0, 8)}: ${t.status} ${t.signature || ''}`);
            if (t.status === 'SUCCESS') successes++;
            if (t.status === 'FAILED' || t.status === 'ERROR') failures++;
          }
          for (const e of r.errors) logLine(`  ERROR: ${e}`);
        } catch (e) {
          logLine(`  FATAL: ${e.message}`);
        }
      }
    }

    if (state.families?.bitcoin && state.derivedKeys.bitcoin.length > 0) {
      for (const { keyPair, address, index } of state.derivedKeys.bitcoin) {
        logLine(`\n[Bitcoin] ${address}`);
        try {
          const r = await sweepBitcoin(address, keyPair, state.destination, { dryRun });
          state.results.bitcoin.push({ index, ...r });
          logLine(`  ${r.status} ${r.txid || ''} ${r.error || ''}`);
          if (r.status === 'SUCCESS') successes++;
          if (r.status === 'ERROR' || r.status === 'BROADCAST_ERROR') failures++;
        } catch (e) {
          logLine(`  FATAL: ${e.message}`);
        }
      }
    }

    logLine(`\n=== ${dryRun ? 'DRY RUN' : 'LIVE SWEEP'} COMPLETE ===`);
    track.sweepCompleted({ live, durationMs: Date.now() - startTime, successes, failures });
  } catch (e) {
    reportError(e, { phase: 'sweep_fatal', live });
    track.error('sweep_fatal');
    throw e;
  }
}

// =====================================================================
// WIRE UP
// =====================================================================

document.addEventListener('DOMContentLoaded', async () => {
  initSentry().catch(() => {});
  initPlausible();

  getClientId();
  const balance = await fetchBalance();
  updateCreditsBadge(balance);

  $$('input[name=wallet-type]').forEach((radio) => {
    radio.addEventListener('change', (e) => {
      showWalletSection(e.target.value);
      hide('#connected-banner');
    });
  });
  showWalletSection('mnemonic');

  const connectBtn = $('#connect-button');
  if (connectBtn) connectBtn.addEventListener('click', connectWalletAndStore);

  $('#preview-button').addEventListener('click', runPreview);
  $('#run-button').addEventListener('click', () => runSweep(state.mode === 'live'));

  $('#buy-credits-button')?.addEventListener('click', async () => {
    try {
      await requirePayment();
      const newBalance = await fetchBalance({ force: true });
      updateCreditsBadge(newBalance);
    } catch (err) {
      console.error('Buy credits failed:', err);
    }
  });

  $('#clear-button').addEventListener('click', async () => {
    if (state.wallet) {
      try { await state.wallet.dispose(); } catch {}
    }
    clearAll();
    $('#phrases').value = '';
    $('#destination').value = '';
    clearLog();
    hide('#run-button');
    hide('#connected-banner');
  });

  $$('input[name=mode]').forEach((radio) => {
    radio.addEventListener('change', (e) => {
      state.mode = e.target.value;
      const runBtn = $('#run-button');
      if (runBtn) {
        runBtn.textContent = state.mode === 'live' ? '⚡ EXECUTE LIVE SWEEP' : '▶ Run Dry Run';
        runBtn.className = state.mode === 'live' ? 'btn btn-danger' : 'btn btn-primary';
      }
      const warning = $('#live-warning');
      if (warning) {
        warning.style.display = state.mode === 'live' ? '' : 'none';
      }
    });
  });

  state.mode = 'dry-run';
});