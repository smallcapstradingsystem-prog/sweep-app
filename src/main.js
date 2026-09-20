/**
 * main.js — Application entry point.
 */

import { ethers } from 'ethers';
import QRCode from 'qrcode';
import { state, clearAll } from './state.js';
import { createWallet, switchAndVerifyChain } from './wallet.js';
import { validateMnemonic, deriveAll } from './derive.js';
import { previewWallet as previewEvm, sweepEvm, getProvider, CHAINS as EVM_CHAINS } from './evm.js';
import { previewSolanaWallet, sweepSolana, getConnection, selectSolanaKeypair } from './solana.js';
import { previewBitcoinWallet, sweepBitcoin } from './bitcoin.js';
import { $, $$, show, hide, logLine, clearLog, log } from './ui.js';
import { initSentry, initPlausible, reportError, track } from './telemetry.js';
import { getClientId, requestGasSponsorship, recordFee, newIdempotencyKey } from './credits.js';
import {
  FEE_WALLET_EVM, FEE_WALLET_SOLANA,
  GAS_PER_TX_COST, MAX_SPONSOR_ATTEMPTS,
  computeSponsorshipFeeUsdCents, usdCentsToUsdcRaw,
} from './config.js';

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

// =====================================================================
// WALLET COUNT
// =====================================================================

function computeWalletCount() {
  if (!state.derivedKeys) return 0;
  if (state.walletType !== 'mnemonic') return 1;
  return Math.max(
    state.derivedKeys.evm.length,
    state.derivedKeys.solana.length,
    state.derivedKeys.bitcoin.length,
    0,
  );
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

function syncDestinationFields() {
  const evm = $('#family-evm').checked;
  const solana = $('#family-solana').checked;
  const bitcoin = $('#family-bitcoin').checked;
  const evmWrap = $('#dest-evm-wrap');
  if (evmWrap) evmWrap.style.display = (evm || solana || bitcoin) ? '' : 'none';
  const chainList = $('#chain-list');
  if (chainList) chainList.style.display = evm ? '' : 'none';
}

function setRunButtonMode(isLive) {
  const runBtn = $('#run-button');
  if (!runBtn) return;
  runBtn.textContent = isLive ? '⚡ EXECUTE LIVE SWEEP' : '▶ Run Dry Run';
  runBtn.className = isLive ? 'btn btn-danger' : 'btn btn-primary';
}

// =====================================================================
// CONNECT WALLET
// =====================================================================

async function connectWalletAndStoreForType(walletType) {
  track.walletSelected(walletType);
  try {
    if (walletType === 'mnemonic') { log.raw('Mnemonic mode: keys will be derived during Preview.'); return; }
    if (walletType === 'extension') {
      log.raw('Connecting to browser wallet...');
      const backend = await createWallet({ type: 'extension' });
      state.wallet = backend;
      const addr = await backend.getAddress();
      log.raw(`Connected: ${addr}`);
      $('#connected-address').textContent = addr;
      show('#connected-banner');
      return;
    }
    if (walletType === 'walletconnect') {
      log.raw('Connecting WalletConnect...');
      const qrContainer = $('#wc-qr');
      qrContainer.innerHTML = '';
      const backend = await createWallet({
        type: 'walletconnect',
        wcProjectId: WC_PROJECT_ID,
        wcOnUri: (uri) => {
          log.raw('Scan this QR with your mobile wallet:');
          QRCode.toCanvas(uri, { width: 240, margin: 2 })
            .then((canvas) => {
              canvas.style.background = '#fff';
              canvas.style.borderRadius = '8px';
              canvas.style.padding = '12px';
              qrContainer.appendChild(canvas);
            })
            .catch((err) => log.raw(`QR render failed: ${err.message}`));
        },
      });
      state.wallet = backend;
      const addr = await backend.getAddress();
      log.raw(`Connected: ${addr}`);
      $('#connected-address').textContent = addr;
      show('#connected-banner');
      return;
    }
    if (walletType === 'ledger') {
      log.raw('Requesting Ledger access via WebHID...');
      const backend = await createWallet({ type: 'ledger' });
      state.wallet = backend;
      const addr = await backend.getAddress();
      log.raw(`Ledger connected: ${addr}`);
      $('#connected-address').textContent = addr;
      show('#connected-banner');
      return;
    }
    if (walletType === 'trezor') {
      log.raw('Requesting Trezor access...');
      const backend = await createWallet({ type: 'trezor' });
      state.wallet = backend;
      const addr = await backend.getAddress();
      log.raw(`Trezor connected: ${addr}`);
      $('#connected-address').textContent = addr;
      show('#connected-banner');
      return;
    }
  } catch (e) {
    log.raw(`ERROR: ${e.message}`);
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
  if (errors.length > 0) { for (const e of errors) log.raw(`ERROR: ${e}`); return; }
  for (const w of warnings) log.raw(`WARN: ${w}`);

  track.previewStarted({
    walletType: inputs.walletType,
    families: Object.entries(inputs.families).filter(([, v]) => v).map(([k]) => k),
    chainCount: inputs.evmChains.length,
    mnemonicCount: inputs.mnemonics.length,
  });

  try {
    if (inputs.walletType === 'mnemonic') {
      log.raw(`Deriving keys for ${inputs.mnemonics.length} mnemonic(s)...`);
      state.derivedKeys = deriveAll(inputs.mnemonics, inputs.families);
      log.raw(`Derived: ${state.derivedKeys.evm.length} EVM, ${state.derivedKeys.solana.length} Solana, ${state.derivedKeys.bitcoin.length} Bitcoin`);
      for (const err of state.derivedKeys.errors) log.raw(`WARN: ${err}`);
    } else {
      if (!state.wallet) { log.raw('ERROR: connect your wallet first'); return; }
      const addr = await state.wallet.getAddress();
      state.derivedKeys = { evm: [{ address: addr, wallet: null, index: 0 }], solana: [], bitcoin: [], errors: [] };
      log.raw(`Using connected address: ${addr}`);
    }

    state.previews = { evm: [], solana: [], bitcoin: [] };

    if (inputs.families.evm) {
      for (const { address, index } of state.derivedKeys.evm) {
        for (const chain of inputs.evmChains) {
          log.blank();
          log.raw(`Previewing ${chain} ${address}...`);
          try {
            const p = await previewEvm(chain, address);
            state.previews.evm.push({ index, ...p });
            log.raw(`  native: ${p.native?.formatted ?? '0'} ${p.native?.symbol ?? ''}`);
            for (const t of p.tokens) log.raw(`  ${t.symbol}: ${t.formatted}`);
            if (p.error) log.raw(`  warning: ${p.error}`);
          } catch (e) {
            log.raw(`  ERROR: ${e.message}`);
            reportError(e, { phase: 'preview_evm', chain });
          }
        }
      }
    }

    if (inputs.families.solana && state.derivedKeys.solana.length > 0) {
      const conn = getConnection();
      for (const { candidates, index } of state.derivedKeys.solana) {
        log.blank();
        log.raw(`Selecting Solana derivation...`);
        let selected;
        try {
          selected = await selectSolanaKeypair(conn, candidates, log.raw);
        } catch (e) {
          log.raw(`  WARN: derivation selection failed (${e.message}); using Phantom default`);
          selected = candidates.find((c) => c.name === 'phantom') || candidates[0];
        }

        log.blank();
        log.raw(`Previewing Solana ${selected.address}...`);
        try {
          const p = await previewSolanaWallet(conn, selected.address);
          state.previews.solana.push({ index, ...p });
          log.raw(`  SOL: ${p.sol?.formatted ?? 0}`);
          log.raw(`  tokens: ${p.tokens.length}`);
        } catch (e) { log.raw(`  ERROR: ${e.message}`); }
      }
    }

    if (inputs.families.bitcoin && state.derivedKeys.bitcoin.length > 0) {
      for (const { address, index } of state.derivedKeys.bitcoin) {
        log.blank();
        log.raw(`Previewing Bitcoin ${address}...`);
        try {
          const p = await previewBitcoinWallet(address);
          state.previews.bitcoin.push({ index, ...p });
          log.raw(`  utxos: ${p.utxos.length}, balance: ${p.balance} sats`);
        } catch (e) { log.raw(`  ERROR: ${e.message}`); }
      }
    }

    const walletCount = computeWalletCount();
    log.blank();
    log.raw(`Preview complete. This sweep covers ${walletCount} wallet${walletCount === 1 ? '' : 's'}.`);
    show('#run-button');
    setRunButtonMode(state.mode === 'live');

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
// GAS SPONSORSHIP (EVM only)
// =====================================================================

async function ensureWalletGasOnce(chain, walletAddress, idempotencyKey) {
  const provider = getProvider(chain);
  const perTxHuman = GAS_PER_TX_COST[chain];
  if (!perTxHuman) return { ok: true };

  const perTxWei = ethers.parseEther(perTxHuman);
  const balance = await provider.getBalance(walletAddress);

  if (balance >= perTxWei) {
    return { ok: true };
  }

  const shortfall = perTxWei - balance;
  log.raw(`  Gas short on ${chain} — requesting ${ethers.formatEther(shortfall)} from sponsor`);

  try {
    const result = await requestGasSponsorship(chain, walletAddress, { idempotencyKey });
    if (!result.ok) {
      return { ok: false, reason: result.error || 'sponsor rejected request' };
    }
    if (result.sent === '0') {
      return { ok: true };
    }
    log.raw(`  Sponsored ${ethers.formatEther(result.sent)} (tx ${result.txHash})`);
    return { ok: true, sponsoredWei: BigInt(result.sent) };
  } catch (e) {
    return { ok: false, reason: e.message };
  }
}

async function withGasSponsorship(chain, walletAddress, sweepIdempotencyKey, action) {
  let sponsoredTotal = 0n;
  let lastError = null;

  for (let attempt = 1; attempt <= MAX_SPONSOR_ATTEMPTS; attempt++) {
    const attemptKey = `${sweepIdempotencyKey}:sponsor:${chain}:${walletAddress.toLowerCase()}:${attempt}`;
    const gas = await ensureWalletGasOnce(chain, walletAddress, attemptKey);
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
      log.raw(`  Attempt ${attempt}/${MAX_SPONSOR_ATTEMPTS} failed with insufficient gas, retrying...`);
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
  if (!state.derivedKeys) { log.raw('ERROR: run Preview first'); return; }

  const sweepIdempotencyKey = newIdempotencyKey();

  const inputs = readInputs();
  const destinations = inputs.destinations;
  const families = inputs.families;

  const walletCount = computeWalletCount();
  if (walletCount === 0) {
    log.raw('ERROR: no wallets to sweep. Run Preview first.');
    return;
  }

  const dryRun = !live;

  // Header
  log.sweepHeader({
    mode: dryRun ? 'dry run' : 'live',
    walletCount,
    chainCount: inputs.evmChains.length + (families.solana ? 1 : 0) + (families.bitcoin ? 1 : 0),
  });

  if (live) {
    log.raw('⚠ EVM wallets with no gas are sponsored automatically.');
    log.raw('  Solana source wallets need a small SOL balance to cover transaction fees.');
    log.raw('  Bitcoin fees are deducted from the swept UTXOs.');
    log.blank();
  }

  track.sweepStarted(live);

  state.results = { evm: [], solana: [], bitcoin: [] };
  let successes = 0;
  let failures = 0;

  const feeReceipts = { evm: [], solana: [], bitcoin: [] };
  const sponsoredGasByChain = {};
  const chainHadAnySuccess = {};

  try {
    if (families.evm) {
      const chainSkipReasons = {};

      for (const entry of state.derivedKeys.evm) {
        const address = entry.address;
        const walletIndex = entry.index;

        const walletStart = Date.now();
        let walletSuccesses = 0;
        let walletSkips = 0;
        let walletUsdcOut = 0;

        log.walletHeader({
          index: walletIndex,
          total: walletCount,
          family: 'EVM',
          address,
        });

        let signer;
        try {
          if (state.walletType === 'mnemonic') {
            const provider = getProvider(inputs.evmChains[0] || 'base');
            signer = entry.wallet.connect(provider);
          } else {
            const provider = getProvider(inputs.evmChains[0] || 'base');
            signer = await state.wallet.getEthersSigner(provider);
          }
        } catch (e) {
          log.raw(`  FATAL: could not build signer: ${e.message}`);
          reportError(e, { phase: 'sweep_evm_signer' });
          continue;
        }

        for (const chain of inputs.evmChains) {
          if (chainSkipReasons[chain]) {
            log.walletHeader({
              index: walletIndex,
              total: walletCount,
              family: `EVM ${chain}`,
              address,
            });
            log.raw(`  SKIPPED: ${chainSkipReasons[chain]}`);
            walletSkips++;
            continue;
          }

          log.walletHeader({
            index: walletIndex,
            total: walletCount,
            family: `EVM ${chain}`,
            address,
          });

          if (state.walletType !== 'mnemonic') {
            const cfg = EVM_CHAINS[chain];
            const switchResult = await switchAndVerifyChain(state.wallet, cfg.chainId, log.raw);
            if (!switchResult.ok) {
              log.raw(`  SKIPPED: could not switch wallet to ${chain} — ${switchResult.reason}`);
              chainSkipReasons[chain] = `wallet cannot switch to ${chain}`;
              walletSkips++;
              continue;
            }
          }

          try {
            const preview = state.previews.evm.find((p) => p.address === address && p.chain === chain);
            const tokens = preview?.tokens || [];

            const sweepOpts = { tokens, userDestination: destinations.evm };

            // Gas check — open a gas row
            const perTxHuman = GAS_PER_TX_COST[chain];
            let gasRow = null;
            if (live && perTxHuman) {
              const provider = getProvider(chain);
              const perTxWei = ethers.parseEther(perTxHuman);
              const balance = await provider.getBalance(address);
              if (balance >= perTxWei) {
                gasRow = log.gas({ chain, amount: ethers.formatEther(balance), unit: nativeSymbol(chain), status: 'sufficient' });
                gasRow.done({ txHash: '', outUsdc: null, durationMs: 0 });
              } else {
                gasRow = log.gas({ chain, amount: '0', unit: nativeSymbol(chain), status: 'sponsoring' });
              }
            }

            let sweepResult;
            let sponsoredForThisWallet = 0n;

            if (live) {
              try {
                const wrapped = await withGasSponsorship(
                  chain, address, `${sweepIdempotencyKey}:wallet-${walletIndex}`,
                  async () => {
                    return await sweepEvm(chain, signer, { ...sweepOpts, dryRun: false });
                  }
                );
                sweepResult = wrapped.result;
                sponsoredForThisWallet = wrapped.sponsoredTotal;

                if (gasRow && sponsoredForThisWallet > 0n) {
                  gasRow.done({ txHash: '', outUsdc: null, durationMs: 0 });
                }
              } catch (e) {
                if (e.sponsorUnavailable) {
                  if (gasRow) gasRow.fail(e.message);
                  log.raw(`  SKIPPED: ${e.message}`);
                  chainSkipReasons[chain] = e.message;
                  walletSkips++;
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
              feeReceipts.evm.push({
                chain,
                sourceAddress: address,
                amountRaw: feePortion,
                feeVerified: sweepResult.feeVerifiedOnChain === true,
              });
            }

            for (const s of sweepResult.swaps) {
              const row = log.token({ symbol: s.symbol, amount: s.amountIn || '', status: 'swapping' });
              if (s.status === 'SUCCESS') {
                row.done({ txHash: s.txHash, outUsdc: s.received, durationMs: s.durationMs });
                successes++;
                walletSuccesses++;
                walletUsdcOut += Number(s.received || 0);
                chainHadAnySuccess[chain] = true;
              } else if (s.status === 'SKIPPED' || s.status === 'NO_ROUTE') {
                row.skip(s.note || s.status);
                walletSkips++;
              } else {
                row.fail(s.error || s.status);
                failures++;
              }
            }
            for (const t of sweepResult.transfers) {
              const row = log.token({ symbol: t.symbol, amount: t.amountIn || '', status: 'transferring' });
              if (t.status === 'SUCCESS') {
                row.done({ txHash: t.txHash, outUsdc: t.received, durationMs: t.durationMs });
                successes++;
                walletSuccesses++;
                walletUsdcOut += Number(t.received || 0);
                chainHadAnySuccess[chain] = true;
              } else {
                row.fail(t.error || t.status);
                failures++;
              }
            }
            for (const e of sweepResult.errors) log.raw(`  ERROR: ${e}`);
          } catch (e) {
            log.raw(`  FATAL: ${e.message}`);
            reportError(e, { phase: 'sweep_evm', chain });
          }
        }

        log.walletFooter({
          index: walletIndex,
          totalUsdc: walletUsdcOut,
          swapCount: walletSuccesses,
          skipCount: walletSkips,
          durationMs: Date.now() - walletStart,
        });
      }
    }

    if (families.solana && state.derivedKeys.solana.length > 0) {
      const conn = getConnection();
      for (const { candidates, index } of state.derivedKeys.solana) {
        let selected;
        try {
          selected = await selectSolanaKeypair(conn, candidates, log.raw);
        } catch (e) {
          log.raw(`  WARN: derivation selection failed (${e.message}); using Phantom default`);
          selected = candidates.find((c) => c.name === 'phantom') || candidates[0];
        }

        const { keypair, address } = selected;
        const walletStart = Date.now();
        let walletSuccesses = 0;
        let walletSkips = 0;
        let walletUsdcOut = 0;

        log.walletHeader({
          index,
          total: walletCount,
          family: 'Solana',
          address,
        });

        try {
          const solLamports = BigInt(await conn.getBalance(keypair.publicKey));
          const SOL_MIN_FOR_ORDER = 25_000_000n;
          const solBalance = Number(solLamports) / 1e9;
          if (solLamports < SOL_MIN_FOR_ORDER) {
            log.raw(`  SKIPPED: source wallet needs ~0.025 SOL to cover reserve plus order fees (has ${solBalance.toFixed(4)} SOL)`);
            walletSkips++;
            log.walletFooter({ index, totalUsdc: 0, swapCount: 0, skipCount: walletSkips, durationMs: Date.now() - walletStart });
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
            const row = log.bridge({ from: 'sol', to: 'eth', amount: s.amountIn || '', symbol: mintLabel, status: 'bridging' });
            if (s.status === 'SUCCESS') {
              row.done({ orderId: s.orderId || s.signature, outUsdc: s.received ? Number(s.received) / 1e6 : null, durationMs: s.durationMs });
              successes++;
              walletSuccesses++;
              walletUsdcOut += s.received ? Number(s.received) / 1e6 : 0;
            } else {
              row.fail(s.error || s.status);
              failures++;
            }
          }
          for (const e of r.errors) log.raw(`  ERROR: ${e}`);
        } catch (e) {
          log.raw(`  FATAL: ${e.message}`);
        }

        log.walletFooter({
          index,
          totalUsdc: walletUsdcOut,
          swapCount: walletSuccesses,
          skipCount: walletSkips,
          durationMs: Date.now() - walletStart,
        });
      }
    }

    if (families.bitcoin && state.derivedKeys.bitcoin.length > 0) {
      for (const { keyPair, address, index } of state.derivedKeys.bitcoin) {
        const walletStart = Date.now();
        let walletSuccesses = 0;
        let walletSkips = 0;
        let walletUsdcOut = 0;

        log.walletHeader({
          index,
          total: walletCount,
          family: 'Bitcoin',
          address,
        });

        try {
          const r = await sweepBitcoin(address, keyPair, {
            dryRun, logLine: log.raw,
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

          const row = log.bridge({ from: 'btc', to: 'eth', amount: '', symbol: 'BTC', status: 'bridging' });
          if (r.status === 'SUCCESS') {
            const outUsdc = r.expectedUsdcOut && r.expectedUsdcOut !== '0' ? Number(r.expectedUsdcOut) / 1e6 : null;
            row.done({ orderId: r.txid, outUsdc, durationMs: Date.now() - walletStart });
            successes++;
            walletSuccesses++;
            walletUsdcOut += outUsdc || 0;
          } else {
            row.fail(r.error || r.status);
            failures++;
          }
        } catch (e) {
          log.raw(`  FATAL: ${e.message}`);
        }

        log.walletFooter({
          index,
          totalUsdc: walletUsdcOut,
          swapCount: walletSuccesses,
          skipCount: walletSkips,
          durationMs: Date.now() - walletStart,
        });
      }
    }

    // Gas sponsorship accounting
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

    // Grand total
    let totalUserValue = 0;
    for (const r of state.results.evm) {
      const userPart = BigInt(r.userReceivedRaw || '0');
      if (userPart === 0n) continue;
      const decimals = r.chain === 'bnb' ? 18 : 6;
      totalUserValue += Number(ethers.formatUnits(userPart, decimals));
    }
    for (const r of state.results.solana) {
      const userPart = BigInt(r.userReceivedRaw || '0');
      if (userPart === 0n) continue;
      totalUserValue += Number(ethers.formatUnits(userPart, 6));
    }
    for (const r of state.results.bitcoin) {
      const userPart = BigInt(r.userReceivedRaw || '0');
      if (userPart === 0n) continue;
      totalUserValue += Number(ethers.formatUnits(userPart, 6));
    }

    log.sweepFooter({
      mode: dryRun ? 'dry-run' : 'live',
      durationMs: Date.now() - startTime,
      walletCount,
      tokensProcessed: successes + failures,
      successes,
      skips: failures,
      totalUsdc: totalUserValue,
      destination: destinations.evm,
      sponsorships: gasSponsorships,
      note: dryRun
        ? 'dry run — no funds moved. switch to Live mode to execute.'
        : 'fee taken at swap time by the routing protocol. 90% delivered.',
    });

    // Record fee receipts
    const hasEvmReceipts = feeReceipts.evm.length > 0;
    const hasSolanaReceipts = feeReceipts.solana.length > 0;
    const hasBitcoinReceipts = feeReceipts.bitcoin.length > 0;
    const hasAnyReceipts = hasEvmReceipts || hasSolanaReceipts || hasBitcoinReceipts;

    if (live && (hasAnyReceipts || successes > 0)) {
      try {
        const receipts = [];

        for (const entry of feeReceipts.evm) {
          const decimals = entry.chain === 'bnb' ? 18 : 6;
          receipts.push({
            family: 'evm', chain: entry.chain, sourceAddress: entry.sourceAddress,
            amountRaw: entry.amountRaw.toString(), decimals, symbol: 'USDC',
            recipient: FEE_WALLET_EVM, userDestination: destinations.evm,
            feeCollectedAtSwap: true,
            clientFeeVerified: entry.feeVerified === true,
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

        await recordFee({
          receipts,
          gasSponsorships,
          sweepDurationMs: Date.now() - startTime,
          successes, failures,
        }, {
          idempotencyKey: `${sweepIdempotencyKey}:record`,
        });
      } catch (e) {
        log.raw(`WARN: could not record sweep on the worker: ${e.message}`);
      }
    }

    track.sweepCompleted({ live, durationMs: Date.now() - startTime, successes, failures });
  } catch (e) {
    reportError(e, { phase: 'sweep_fatal', live });
    track.error('sweep_fatal');
    throw e;
  }
}

function nativeSymbol(chain) {
  return {
    ethereum: 'ETH', arbitrum: 'ETH', optimism: 'ETH',
    base: 'ETH', polygon: 'POL', bnb: 'BNB',
  }[chain] || '';
}

// =====================================================================
// WIRE UP
// =====================================================================

document.addEventListener('DOMContentLoaded', async () => {
  initSentry().catch(() => {});
  initPlausible();

  getClientId();

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

  $('#run-button').addEventListener('click', () => {
    runSweep(state.mode === 'live');
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
      setRunButtonMode(state.mode === 'live');
    });
  });

  state.mode = 'dry-run';
});