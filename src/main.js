/**
 * main.js — Application entry point.
 */

import { ethers } from 'ethers';
import { PublicKey } from '@solana/web3.js';
import QRCode from 'qrcode';
import { state, resetState, clearAll } from './state.js';
import { createWallet } from './wallet.js';
import { validateMnemonic, deriveAll } from './derive.js';
import { previewWallet as previewEvm, sweepEvm, getProvider, CHAINS as EVM_CHAINS } from './evm.js';
import { previewSolanaWallet, sweepSolana, getConnection, selectSolanaKeypair } from './solana.js';
import { previewBitcoinWallet, sweepBitcoin } from './bitcoin.js';
import { $, $$, el, show, hide, logLine, clearLog } from './ui.js';
import { initSentry, initPlausible, reportError, track } from './telemetry.js';
import {
  getClientId, fetchBalance, consumeCredit, invalidateBalanceCache,
  recordFee, requestGasSponsorship,
  fetchClaimInfo, claimFreeCredits,
} from './credits.js';
import { showCryptoPaymentModal } from './crypto-pay.js';
import {
  FEE_WALLET_EVM, FEE_WALLET_SOLANA, FEE_WALLET_BITCOIN,
  GAS_SPONSOR_ADDRESS, GAS_PER_TX_COST, MAX_SPONSOR_ATTEMPTS,
  computeSponsorshipFeeUsdCents, usdCentsToUsdcRaw,
} from './config.js';

const WC_PROJECT_ID = '74d3ed4f87d14b6cac7556234dfb72a3';

let freeClaimTimer = null;

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
  const destinations = { evm: $('#dest-evm').value.trim(), solana: '', bitcoin: '' };
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
    if (!destinations.evm) errors.push('EVM destination address is required.');
    else if (!isEvmAddress(destinations.evm)) errors.push('EVM destination must be a valid 0x address.');
  }
  if (families.solana) {
    if (!destinations.evm) {
      errors.push('EVM destination is required when sweeping Solana (Solana output bridges to Ethereum USDC).');
    } else if (!isEvmAddress(destinations.evm)) {
      errors.push('EVM destination must be a valid 0x address.');
    }
  }
  if (families.bitcoin) {
    if (!destinations.evm) {
      errors.push('EVM destination is required when sweeping Bitcoin (BTC output bridges to Ethereum USDC).');
    } else if (!isEvmAddress(destinations.evm)) {
      errors.push('EVM destination must be a valid 0x address.');
    }
  }

  if (families.evm && destinations.evm && isSolanaAddress(destinations.evm) && !isEvmAddress(destinations.evm)) {
    warnings.push('Your EVM destination looks like a Solana address.');
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

function syncDestinationFields() {
  const evm = $('#family-evm').checked;
  const solana = $('#family-solana').checked;
  const bitcoin = $('#family-bitcoin').checked;
  const evmWrap = $('#dest-evm-wrap');
  if (evmWrap) evmWrap.style.display = (evm || solana || bitcoin) ? '' : 'none';
  const chainList = $('#chain-list');
  if (chainList) chainList.style.display = evm ? '' : 'none';
}

// =====================================================================
// FREE CLAIM BANNER
// =====================================================================

function renderFreeClaimBanner(info) {
  const banner = $('#free-claim-banner');
  if (!banner) return;

  if (freeClaimTimer) {
    clearInterval(freeClaimTimer);
    freeClaimTimer = null;
  }

  if (info.claimed) {
    banner.style.display = '';
    banner.innerHTML = `
      <div class="free-claim-inner">
        <span class="free-claim-icon">✓</span>
        <div class="free-claim-text">
          <strong>${info.creditsGranted} free credits added</strong>
          <p>Your launch bonus is ready to use. Credits never expire.</p>
        </div>
      </div>
    `;
    return;
  }

  if (info.expired) {
    banner.style.display = '';
    banner.innerHTML = `
      <div class="free-claim-inner">
        <span class="free-claim-icon">⏱</span>
        <div class="free-claim-text">
          <strong>Your 24-hour claim window has ended</strong>
          <p>Free credits are no longer available on this browser.</p>
        </div>
      </div>
    `;
    return;
  }

  banner.style.display = '';
  banner.innerHTML = `
    <div class="free-claim-inner">
      <span class="free-claim-icon">🎁</span>
      <div class="free-claim-text">
        <strong>3 free sweep credits</strong>
        <p>Claim within <span id="free-claim-countdown">--:--:--</span></p>
      </div>
      <button id="free-claim-button" class="btn btn-primary btn-sm">Claim now</button>
    </div>
  `;

  const countdownEl = document.getElementById('free-claim-countdown');
  const renderedAt = Date.now();
  const updateCountdown = () => {
    const remaining = info.msRemaining - (Date.now() - renderedAt);
    if (remaining <= 0) {
      if (freeClaimTimer) { clearInterval(freeClaimTimer); freeClaimTimer = null; }
      fetchClaimInfo().then(renderFreeClaimBanner).catch(() => {});
      return;
    }
    const totalSec = Math.floor(remaining / 1000);
    const h = String(Math.floor(totalSec / 3600)).padStart(2, '0');
    const m = String(Math.floor((totalSec % 3600) / 60)).padStart(2, '0');
    const s = String(totalSec % 60).padStart(2, '0');
    if (countdownEl) countdownEl.textContent = `${h}:${m}:${s}`;
  };
  updateCountdown();
  freeClaimTimer = setInterval(updateCountdown, 1000);

  const claimBtn = document.getElementById('free-claim-button');
  if (claimBtn) {
    claimBtn.addEventListener('click', async () => {
      claimBtn.disabled = true;
      claimBtn.textContent = 'Claiming...';
      try {
        const result = await claimFreeCredits();
        if (result.creditsGranted > 0) {
          logLine(`Welcome bonus: ${result.creditsGranted} free sweep credits added.`);
        } else if (result.blockedByIp) {
          logLine('Free credits already claimed on this network.');
        } else if (result.offerExpired) {
          logLine('Your claim window has expired.');
        }
        const newBalance = await fetchBalance({ force: true });
        updateCreditsBadge(newBalance);
        const freshInfo = await fetchClaimInfo();
        renderFreeClaimBanner(freshInfo);
      } catch (err) {
        claimBtn.disabled = false;
        claimBtn.textContent = 'Try again';
        logLine(`Claim failed: ${err.message}`);
      }
    });
  }
}

// =====================================================================
// CONNECT WALLET
// =====================================================================

async function connectWalletAndStore() {
  const { walletType } = readInputs();
  return connectWalletAndStoreForType(walletType);
}

async function connectWalletAndStoreForType(walletType) {
  track.walletSelected(walletType);
  try {
    if (walletType === 'mnemonic') { logLine('Mnemonic mode: keys will be derived during Preview.'); return; }
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
  if (errors.length > 0) { for (const e of errors) logLine(`ERROR: ${e}`); return; }
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
      if (!state.wallet) { logLine('ERROR: connect your wallet first'); return; }
      const addr = await state.wallet.getAddress();
      state.derivedKeys = { evm: [{ address: addr, wallet: null, index: 0 }], solana: [], bitcoin: [], errors: [] };
      logLine(`Using connected address: ${addr}`);
    }

    state.previews = { evm: [], solana: [], bitcoin: [] };

    if (inputs.families.evm) {
      for (const { address, index } of state.derivedKeys.evm) {
        for (const chain of inputs.evmChains) {
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
      for (const { candidates, index } of state.derivedKeys.solana) {
        logLine(`\nSelecting Solana derivation...`);
        let selected;
        try {
          selected = await selectSolanaKeypair(conn, candidates, logLine);
        } catch (e) {
          logLine(`  WARN: derivation selection failed (${e.message}); using Phantom default`);
          selected = candidates.find((c) => c.name === 'phantom') || candidates[0];
        }

        logLine(`\nPreviewing Solana ${selected.address}...`);
        try {
          const p = await previewSolanaWallet(conn, selected.address);
          state.previews.solana.push({ index, ...p });
          logLine(`  SOL: ${p.sol?.formatted ?? 0}`);
          logLine(`  tokens: ${p.tokens.length}`);
        } catch (e) { logLine(`  ERROR: ${e.message}`); }
      }
    }

    if (inputs.families.bitcoin && state.derivedKeys.bitcoin.length > 0) {
      for (const { address, index } of state.derivedKeys.bitcoin) {
        logLine(`\nPreviewing Bitcoin ${address}...`);
        try {
          const p = await previewBitcoinWallet(address);
          state.previews.bitcoin.push({ index, ...p });
          logLine(`  utxos: ${p.utxos.length}, balance: ${p.balance} sats`);
        } catch (e) { logLine(`  ERROR: ${e.message}`); }
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
  } catch (err) { throw err; }
}

// =====================================================================
// GAS SPONSORSHIP (EVM only)
// =====================================================================

async function ensureWalletGasOnce(chain, walletAddress) {
  const provider = getProvider(chain);
  const perTxHuman = GAS_PER_TX_COST[chain];
  if (!perTxHuman) return { ok: true };

  const perTxWei = ethers.parseEther(perTxHuman);
  const balance = await provider.getBalance(walletAddress);

  if (balance >= perTxWei) {
    return { ok: true };
  }

  const shortfall = perTxWei - balance;
  logLine(`  Gas short on ${chain} — requesting ${ethers.formatEther(shortfall)} from sponsor`);

  try {
    const result = await requestGasSponsorship(chain, walletAddress, shortfall.toString());
    if (!result.ok) {
      return { ok: false, reason: result.error || 'sponsor rejected request' };
    }
    if (result.sent === '0') {
      return { ok: true };
    }
    logLine(`  Sponsored ${ethers.formatEther(result.sent)} (tx ${result.txHash})`);
    return { ok: true, sponsoredWei: BigInt(result.sent) };
  } catch (e) {
    return { ok: false, reason: e.message };
  }
}

async function withGasSponsorship(chain, walletAddress, action) {
  let sponsoredTotal = 0n;
  let lastError = null;

  for (let attempt = 1; attempt <= MAX_SPONSOR_ATTEMPTS; attempt++) {
    const gas = await ensureWalletGasOnce(chain, walletAddress);
    if (!gas.ok) {
      const e = new Error(`gas sponsor unavailable: ${gas.reason}`);
      e.sponsorUnavailable = true;
      throw e;
    }
    if (gas.sponsoredWei) sponsoredTotal += gas.sponsoredWei;

    try {
      const result = await action();
      return { result, sponsoredTotal };
    } catch (e) {
      const msg = (e.message || String(e)).toLowerCase();
      const isInsufficientGas =
        msg.includes('insufficient funds') ||
        msg.includes('insufficient balance for gas') ||
        msg.includes('gas required exceeds allowance') ||
        msg.includes('exceeds the balance');

      if (!isInsufficientGas) throw e;

      lastError = e;
      logLine(`  Attempt ${attempt}/${MAX_SPONSOR_ATTEMPTS} failed with insufficient gas, retrying...`);
      await new Promise((r) => setTimeout(r, 1000));
    }
  }

  throw new Error(`Exhausted ${MAX_SPONSOR_ATTEMPTS} sponsorship attempts: ${lastError?.message}`);
}

// =====================================================================
// SWEEP
// =====================================================================

async function runSweep(live) {
  const startTime = Date.now();
  if (!state.derivedKeys) { logLine('ERROR: run Preview first'); return; }

  const inputs = readInputs();
  const destinations = inputs.destinations;
  const families = inputs.families;

  if (live) {
    logLine('\n⚠ Reminder: EVM wallets with no gas will be sponsored automatically for a fee.');
    logLine('  Solana source wallets need a small SOL balance to cover transaction fees.');
    logLine('  Bitcoin fees are deducted from the swept UTXOs.');

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
    if (balance < 1) { logLine('ERROR: still no credits after payment.'); return; }

    const confirm = prompt(
      `This live sweep will consume 1 credit (you have ${balance}).\n` +
      `If any EVM wallet needs gas, a $1 minimum sponsorship fee applies.\n\n` +
      `Type LIVE_SWEEP_NOW to confirm:`
    );
    if (confirm !== 'LIVE_SWEEP_NOW') { logLine('Live sweep cancelled.'); return; }

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

  const feeReceipts = { evm: [], solana: [], bitcoin: [] };
  const sponsoredGasByChain = {};
  const chainHadAnySuccess = {};

  const evmFeeForChain = (chain) =>
    feeReceipts.evm
      .filter((e) => e.chain === chain)
      .reduce((sum, e) => sum + e.amountRaw, 0n);
  const solanaFeeTotal = () => feeReceipts.solana.reduce((sum, e) => sum + e.amountRaw, 0n);
  const bitcoinFeeTotal = () => feeReceipts.bitcoin.reduce((sum, e) => sum + e.amountRaw, 0n);

  try {
    if (families.evm) {
      const chainSkipReasons = {};

      for (const entry of state.derivedKeys.evm) {
        const address = entry.address;

        for (const chain of inputs.evmChains) {
          if (chainSkipReasons[chain]) {
            logLine(`\n[EVM ${chain}] ${address}`);
            logLine(`  SKIPPED: ${chainSkipReasons[chain]}`);
            continue;
          }

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
                logLine(`  SKIPPED: could not switch wallet to ${chain} — ${e.message}`);
                chainSkipReasons[chain] = `wallet cannot switch to ${chain}`;
                continue;
              }
              await new Promise((r) => setTimeout(r, 300));
              signer = await state.wallet.getEthersSigner(provider);
            } else {
              signer = await state.wallet.getEthersSigner(provider);
            }

            const preview = state.previews.evm.find((p) => p.address === address && p.chain === chain);
            const tokens = preview?.tokens || [];

            const sweepOpts = { tokens, userDestination: destinations.evm };

            let sweepResult;
            let sponsoredForThisWallet = 0n;

            if (live) {
              try {
                const wrapped = await withGasSponsorship(chain, address, async () => {
                  return await sweepEvm(chain, signer, { ...sweepOpts, dryRun: false });
                });
                sweepResult = wrapped.result;
                sponsoredForThisWallet = wrapped.sponsoredTotal;
              } catch (e) {
                if (e.sponsorUnavailable) {
                  logLine(`  SKIPPED: ${e.message}`);
                  chainSkipReasons[chain] = e.message;
                  continue;
                }
                throw e;
              }
            } else {
              sweepResult = await sweepEvm(chain, signer, { ...sweepOpts, dryRun: true });
            }

            if (sponsoredForThisWallet > 0n) {
              if (!sponsoredGasByChain[chain]) sponsoredGasByChain[chain] = {};
              sponsoredGasByChain[chain][address] = sponsoredForThisWallet.toString();
            }

            state.results.evm.push({ chain, address, ...sweepResult });

            const feePortion = BigInt(sweepResult.feeReceivedRaw || '0');
            if (feePortion > 0n) {
              feeReceipts.evm.push({ chain, sourceAddress: address, amountRaw: feePortion });
            }

            for (const s of sweepResult.swaps) {
              const receivedNote = s.received ? ` (user out ${s.received} USDC)` : '';
              const splitNote = s.userShare && s.feeShare
                ? ` [user ${s.userShare} / fee ${s.feeShare}]`
                : '';
              logLine(`  swap ${s.symbol}: ${s.status}${s.txHash ? ' ' + s.txHash : ''}${receivedNote}${splitNote}${s.note ? ' (' + s.note + ')' : ''}${s.error ? ' — ' + s.error : ''}`);
              if (s.status === 'SUCCESS') { successes++; chainHadAnySuccess[chain] = true; }
              if (s.status === 'FAILED' || s.status === 'ERROR') failures++;
            }
            for (const t of sweepResult.transfers) {
              const receivedNote = t.received ? ` (user out ${t.received} USDC)` : '';
              logLine(`  transfer ${t.symbol}: ${t.status}${t.txHash ? ' ' + t.txHash : ''}${receivedNote}`);
              if (t.status === 'SUCCESS') { successes++; chainHadAnySuccess[chain] = true; }
              if (t.status === 'FAILED' || t.status === 'ERROR') failures++;
            }
            for (const e of sweepResult.errors) logLine(`  ERROR: ${e}`);
          } catch (e) {
            logLine(`  FATAL: ${e.message}`);
            reportError(e, { phase: 'sweep_evm', chain });
          }
        }
      }
    }

    if (families.solana && state.derivedKeys.solana.length > 0) {
      const conn = getConnection();
      for (const { candidates, index } of state.derivedKeys.solana) {
        let selected;
        try {
          selected = await selectSolanaKeypair(conn, candidates, logLine);
        } catch (e) {
          logLine(`  WARN: derivation selection failed (${e.message}); using Phantom default`);
          selected = candidates.find((c) => c.name === 'phantom') || candidates[0];
        }

        const { keypair, address } = selected;
        logLine(`\n[Solana] ${address}`);
        try {
          const solLamports = BigInt(await conn.getBalance(keypair.publicKey));
          const SOL_MIN_FOR_ORDER = 25_000_000n;
          if (solLamports < SOL_MIN_FOR_ORDER) {
            logLine(`  SKIPPED: source wallet needs ~0.025 SOL to cover reserve plus order fees (has ${(Number(solLamports) / 1e9).toFixed(4)} SOL)`);
            continue;
          }

          const r = await sweepSolana(conn, keypair, {
            dryRun,
            userDestination: destinations.evm,
          });
          state.results.solana.push({ index, ...r });

          const feePortion = BigInt(r.feeReceivedRaw || '0');
          if (feePortion > 0n) {
            feeReceipts.solana.push({
              sourceAddress: address,
              amountRaw: feePortion,
              orderIds: (r.swaps || []).filter((s) => s.orderId).map((s) => s.orderId),
            });
          }

          for (const s of r.swaps) {
            const mintLabel = s.mint === 'SOL' ? 'SOL' : s.mint.slice(0, 8);
            const receivedNote = s.received ? ` (user expected ${ethers.formatUnits(BigInt(s.received), 6)} USDC on Ethereum)` : '';
            const orderNote = s.orderId ? ` order=${s.orderId.slice(0, 10)}...` : '';
            const note = s.note ? ` (${s.note})` : '';
            logLine(`  bridge ${mintLabel}: ${s.status} ${s.signature || ''}${orderNote}${receivedNote}${note}${s.error ? ' — ' + s.error : ''}`);
            if (s.status === 'SUCCESS') successes++;
            if (s.status === 'FAILED' || s.status === 'ERROR') failures++;
          }
          for (const e of r.errors) logLine(`  ERROR: ${e}`);
        } catch (e) { logLine(`  FATAL: ${e.message}`); }
      }
    }

    if (families.bitcoin && state.derivedKeys.bitcoin.length > 0) {
      for (const { keyPair, address, index } of state.derivedKeys.bitcoin) {
        logLine(`\n[Bitcoin] ${address}`);
        try {
          const r = await sweepBitcoin(address, keyPair, {
            dryRun, logLine,
            userDestination: destinations.evm,
          });
          state.results.bitcoin.push({ index, ...r });

          const feePortion = BigInt(r.feeReceivedRaw || '0');
          if (feePortion > 0n) {
            feeReceipts.bitcoin.push({
              sourceAddress: address,
              amountRaw: feePortion,
              txids: r.txid ? [r.txid] : [],
            });
          }

          const receivedNote = r.expectedUsdcOut && r.expectedUsdcOut !== '0'
            ? ` (user expected ${ethers.formatUnits(BigInt(r.expectedUsdcOut), 6)} USDC on Ethereum)`
            : '';
          logLine(`  bridge btc→eth: ${r.status} ${r.txid || ''}${receivedNote}${r.error ? ' — ' + r.error : ''}`);
          if (r.status === 'SUCCESS') successes++;
          if (r.status === 'ERROR' || r.status === 'BROADCAST_ERROR') failures++;
        } catch (e) { logLine(`  FATAL: ${e.message}`); }
      }
    }

    logLine(`\n=== ${dryRun ? 'DRY RUN' : 'LIVE SWEEP'} COMPLETE ===`);

    // ---- Gas sponsorships ----
    const gasSponsorships = [];
    if (live) {
      const nativePriceCache = {};
      async function getNativePriceUsd(chain) {
        if (nativePriceCache[chain] !== undefined) return nativePriceCache[chain];
        const coinIds = {
          ethereum: 'ethereum', arbitrum: 'ethereum', optimism: 'ethereum',
          base: 'ethereum', polygon: 'matic-network', bnb: 'binancecoin',
        };
        const id = coinIds[chain] || 'ethereum';
        try {
          const resp = await fetch(`https://api.coingecko.com/api/v3/simple/price?ids=${id}&vs_currencies=usd`);
          const data = await resp.json();
          nativePriceCache[chain] = data[id]?.usd || (id === 'ethereum' ? 3000 : id === 'binancecoin' ? 600 : 0.5);
        } catch {
          nativePriceCache[chain] = id === 'ethereum' ? 3000 : id === 'binancecoin' ? 600 : 0.5;
        }
        return nativePriceCache[chain];
      }

      for (const [chain, wallets] of Object.entries(sponsoredGasByChain)) {
        if (!chainHadAnySuccess[chain]) continue;
        let totalWei = 0n;
        for (const amt of Object.values(wallets)) totalWei += BigInt(amt);

        const nativePriceUsd = await getNativePriceUsd(chain);
        const amountNative = Number(totalWei) / 1e18;
        const costUsdCents = Math.round(amountNative * nativePriceUsd * 100);
        const feeUsdCents = computeSponsorshipFeeUsdCents(costUsdCents);

        gasSponsorships.push({
          chain,
          totalSponsoredWei: totalWei.toString(),
          estimatedCostUsdCents: costUsdCents,
          sponsorshipFeeUsdCents: feeUsdCents,
          sponsorshipFeeUsdcRaw: usdCentsToUsdcRaw(feeUsdCents).toString(),
          nativePriceUsd,
          wallets: Object.keys(wallets),
        });
      }
    }

    // ---- Summary ----
    logLine('');
    logLine('═══════════════════════════════════════════════════════════');
    logLine('SWEEP SUMMARY');
    logLine('═══════════════════════════════════════════════════════════');

    const chainsSwept = [];
    for (const chain of inputs.evmChains) {
      if (evmFeeForChain(chain) > 0n) chainsSwept.push(chain);
    }
    if (solanaFeeTotal() > 0n) chainsSwept.push('solana→eth');
    if (bitcoinFeeTotal() > 0n) chainsSwept.push('bitcoin→eth');

    logLine(`  Chains swept:      ${chainsSwept.length ? chainsSwept.join(', ') : '(none)'}`);
    logLine(`  Tokens processed:  ${successes + failures}`);
    logLine(`  Successful swaps:  ${successes}`);
    if (failures > 0) logLine(`  Skipped:           ${failures}`);
    logLine('');

    if (dryRun) {
      logLine('  This was a dry run. No funds were moved.');
      logLine('  Run in Live mode to execute the sweep.');
    } else {
      logLine('  Funds delivered directly to your destination:');
      logLine('');

      let totalUserValue = 0;

      for (const r of state.results.evm) {
        const userPart = BigInt(r.userReceivedRaw || '0');
        if (userPart === 0n) continue;
        const decimals = r.chain === 'bnb' ? 18 : 6;
        logLine(`    ${r.chain.padEnd(10)} ${ethers.formatUnits(userPart, decimals)} USDC`);
        totalUserValue += Number(ethers.formatUnits(userPart, decimals));
      }

      for (const r of state.results.solana) {
        const userPart = BigInt(r.userReceivedRaw || '0');
        if (userPart === 0n) continue;
        logLine(`    ${'solana→eth'.padEnd(10)} ${ethers.formatUnits(userPart, 6)} USDC (via deBridge, est.)`);
        totalUserValue += Number(ethers.formatUnits(userPart, 6));
      }

      for (const r of state.results.bitcoin) {
        const userPart = BigInt(r.userReceivedRaw || '0');
        if (userPart === 0n) continue;
        logLine(`    ${'bitcoin→eth'.padEnd(10)} ${ethers.formatUnits(userPart, 6)} USDC (via THORChain, est.)`);
        totalUserValue += Number(ethers.formatUnits(userPart, 6));
      }

      logLine('');
      logLine(`  Total to you:      ~$${totalUserValue.toFixed(2)}`);
      logLine(`  Destination:       ${destinations.evm || '(not set)'}`);
      logLine(`  Estimated time:    within a few minutes`);
      logLine('');
      logLine('  Thank you for using Sweeper.');
    }

    logLine('═══════════════════════════════════════════════════════════');

    // ---- Record fee on worker ----
    const hasEvmReceipts = feeReceipts.evm.length > 0;
    const hasSolanaReceipts = feeReceipts.solana.length > 0;
    const hasBitcoinReceipts = feeReceipts.bitcoin.length > 0;

    if (live && (hasEvmReceipts || hasSolanaReceipts || hasBitcoinReceipts)) {
      try {
        const receipts = [];

        for (const entry of feeReceipts.evm) {
          const decimals = entry.chain === 'bnb' ? 18 : 6;
          receipts.push({
            family: 'evm', chain: entry.chain, sourceAddress: entry.sourceAddress,
            amountRaw: entry.amountRaw.toString(), decimals, symbol: 'USDC',
            recipient: FEE_WALLET_EVM, userDestination: destinations.evm,
            feeCollectedAtSwap: true,
          });
        }

        for (const entry of feeReceipts.solana) {
          receipts.push({
            family: 'solana', sourceAddress: entry.sourceAddress,
            amountRaw: entry.amountRaw.toString(), decimals: 6, symbol: 'USDC',
            recipient: FEE_WALLET_SOLANA, sourceChain: 'solana',
            destinationChain: 'ethereum', bridge: 'debridge',
            orderIds: entry.orderIds, userDestination: destinations.evm,
            feeCollectedAtSwap: false, requiresManualClaim: true,
          });
        }

        for (const entry of feeReceipts.bitcoin) {
          receipts.push({
            family: 'bitcoin', sourceAddress: entry.sourceAddress,
            amountRaw: entry.amountRaw.toString(), decimals: 6, symbol: 'USDC',
            recipient: FEE_WALLET_EVM, sourceChain: 'bitcoin',
            destinationChain: 'ethereum', bridge: 'thorchain',
            txids: entry.txids, userDestination: destinations.evm,
            feeCollectedAtSwap: true,
          });
        }

        if (receipts.length > 0) {
          await recordFee({
            receipts, gasSponsorships,
            sweepDurationMs: Date.now() - startTime,
            successes, failures,
          });
        }
      } catch (e) {
        logLine(`\nWARN: could not record sweep on the worker: ${e.message}`);
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

  // Kick off the free-claim banner asynchronously so it doesn't block
  // the rest of the page load. The banner renders itself once the
  // worker responds.
  fetchClaimInfo()
    .then(renderFreeClaimBanner)
    .catch((err) => console.warn('Claim info failed:', err.message));

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

  const connectButtons = [
    ['#connect-button-extension',     'extension'],
    ['#connect-button-walletconnect', 'walletconnect'],
    ['#connect-button-ledger',        'ledger'],
    ['#connect-button-trezor',        'trezor'],
  ];
  for (const [sel, type] of connectButtons) {
    const btn = $(sel);
    if (!btn) continue;
    btn.addEventListener('click', () => connectWalletAndStoreForType(type));
  }

  $('#preview-button').addEventListener('click', runPreview);
  $('#run-button').addEventListener('click', () => runSweep(state.mode === 'live'));

  $('#buy-credits-button')?.addEventListener('click', async () => {
    try {
      await requirePayment();
      const newBalance = await fetchBalance({ force: true });
      updateCreditsBadge(newBalance);
    } catch (err) { console.error('Buy credits failed:', err); }
  });

  $('#clear-button').addEventListener('click', async () => {
    if (state.wallet) { try { await state.wallet.dispose(); } catch {} }
    clearAll();
    $('#phrases').value = '';
    $('#dest-evm').value = '';
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
    });
  });

  state.mode = 'dry-run';
});