/**
 * wallet.js — Signing backends: mnemonic, WalletConnect, Ledger, Trezor, Browser Extension.
 *
 * All EVM-capable backends expose a `switchChain(chainId)` method and a
 * `getCurrentChainId()` method. switchChain asks the wallet to move to
 * the target chain; getCurrentChainId reports what the wallet says it's
 * on now. Callers should switch, then verify, then sign — never trust
 * that switchChain alone did the right thing.
 *
 * Backends that don't have a chain concept (mnemonic, hardware wallets)
 * return null from getCurrentChainId. switchAndVerifyChain treats that
 * as "no verification possible" and lets the sweep proceed — those
 * backends sign whatever chainId is on the tx they're given.
 */

import { ethers } from 'ethers';
import { deriveEvm, deriveSolana, deriveBitcoin } from './derive.js';

// =====================================================================
// HELPERS
// =====================================================================

/**
 * Normalize a signature `v` value to 0 or 1 (yParity).
 *
 * Different signers return `v` in different conventions:
 *   - 0 or 1        → already yParity (some Ledger firmware, Trezor)
 *   - 27 or 28      → legacy EIP-155 (most Ledger firmware)
 *   - 25, 26        → EIP-1559 with chain-id encoding in some firmwares
 *   - 35+           → EIP-155 with chain id (rare, shouldn't appear here)
 *
 * Ethers v6 expects 0 or 1 on `Signature.v` for typed transactions.
 */
function normalizeV(rawV) {
  const v = typeof rawV === 'string' ? parseInt(rawV, 16) : Number(rawV);
  if (v === 0 || v === 1) return v;
  if (v === 27 || v === 28) return v - 27;
  if (v === 25 || v === 26) return v - 25;
  throw new Error(`Unexpected signature v value: ${v} (raw: ${rawV})`);
}

function noopSwitchChain() {
  return { ok: true, chainId: null };
}

/**
 * Ask an EVM-capable backend to switch to `targetChainId`, retrying a
 * few times, and verify by reading the provider's reported chain.
 *
 * Returns:
 *   { ok: true,  chainId: <number> }  — verified on target chain
 *   { ok: true,  chainId: null }      — backend has no chain concept;
 *                                       caller should proceed, signer
 *                                       will use the tx's chainId
 *   { ok: false, chainId: <number|null>, reason: <string> }
 *
 * The retry loop is small — 3 attempts at 400ms — because a failure
 * here almost always means the user declined the prompt, not a
 * transient network issue. We retry just enough to survive a stale
 * session and then give up cleanly.
 */
export async function switchAndVerifyChain(backend, targetChainId, logLine) {
  const target = Number(targetChainId);
  const maxAttempts = 3;
  const retryDelayMs = 400;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    let switchResult;
    try {
      switchResult = await backend.switchChain(target);
    } catch (e) {
      if (logLine) {
        logLine(`  switchChain attempt ${attempt}/${maxAttempts} threw: ${e.message}`);
      }
      if (attempt < maxAttempts) {
        await new Promise((r) => setTimeout(r, retryDelayMs));
        continue;
      }
      return { ok: false, reason: e.message, chainId: null };
    }

    // Some backends return { ok: false } instead of throwing.
    if (switchResult && switchResult.ok === false) {
      if (logLine) {
        logLine(`  switchChain attempt ${attempt}/${maxAttempts} rejected: ${switchResult.reason || 'unknown'}`);
      }
      if (attempt < maxAttempts) {
        await new Promise((r) => setTimeout(r, retryDelayMs));
        continue;
      }
      return { ok: false, reason: switchResult.reason || 'rejected', chainId: null };
    }

    // Read what the wallet actually thinks its chain is.
    let observed;
    try {
      observed = await backend.getCurrentChainId();
    } catch (e) {
      if (logLine) {
        logLine(`  getCurrentChainId attempt ${attempt}/${maxAttempts} failed: ${e.message}`);
      }
      if (attempt < maxAttempts) {
        await new Promise((r) => setTimeout(r, retryDelayMs));
        continue;
      }
      return { ok: false, reason: `could not read chain: ${e.message}`, chainId: null };
    }

    // ─── Fix ───
    //
    // A null from getCurrentChainId means the backend has no chain
    // concept — the switch was a no-op and the signer will use the
    // chainId on the tx. Nothing to verify, proceed. This covers
    // MnemonicWallet, LedgerBackend, and TrezorBackend.
    if (observed === null) {
      return { ok: true, chainId: null };
    }

    if (observed === target) {
      return { ok: true, chainId: observed };
    }

    if (logLine) {
      logLine(`  Wallet reports chain ${observed}, expected ${target} (attempt ${attempt}/${maxAttempts})`);
    }
    if (attempt < maxAttempts) {
      await new Promise((r) => setTimeout(r, retryDelayMs));
    }
  }

  // Final verification read — one last chance before giving up.
  let observed = null;
  try {
    observed = await backend.getCurrentChainId();
  } catch { /* ignore */ }

  // If we somehow end up here with a null (backend changed mid-run),
  // treat it as the no-chain-concept case rather than a failure.
  if (observed === null) {
    return { ok: true, chainId: null };
  }

  return {
    ok: false,
    reason: `wallet on chain ${observed ?? 'unknown'}, expected ${target}`,
    chainId: observed,
  };
}

// =====================================================================
// MNEMONIC BACKEND
// =====================================================================

export class MnemonicWallet {
  constructor(phrase) {
    this.phrase = phrase;
    this._evm = null;
    this._solana = null;
    this._bitcoin = null;
  }

  async getAddress() {
    if (!this._evm) this._evm = deriveEvm(this.phrase);
    return this._evm.address;
  }

  async getEthersSigner(provider) {
    if (!this._evm) this._evm = deriveEvm(this.phrase);
    return this._evm.wallet.connect(provider);
  }

  getSolanaKeypair() {
    if (!this._solana) this._solana = deriveSolana(this.phrase);
    return this._solana.keypair;
  }

  getBitcoinKeyPair() {
    if (!this._bitcoin) this._bitcoin = deriveBitcoin(this.phrase);
    return this._bitcoin.keyPair;
  }

  async switchChain(_targetChainId) {
    return noopSwitchChain();
  }

  async getCurrentChainId() {
    return null;
  }

  async dispose() {
    this.phrase = null;
    this._evm = null;
    this._solana = null;
    this._bitcoin = null;
  }
}

// =====================================================================
// BROWSER EXTENSION BACKEND
// =====================================================================

export class BrowserExtensionBackend {
  constructor(ethersProvider, rawProvider, address, chainId) {
    this.provider = ethersProvider;
    this.rawProvider = rawProvider;
    this.address = address;
    this.chainId = chainId;
  }

  async getAddress() {
    return this.address;
  }

  async getEthersSigner(_provider) {
    return this.provider.getSigner();
  }

  getSolanaKeypair() {
    throw new Error('Browser extensions do not support Solana in this build');
  }

  getBitcoinKeyPair() {
    throw new Error('Browser extensions do not support Bitcoin in this build');
  }

  async switchChain(chainId) {
    const target = Number(chainId);
    const hex = '0x' + target.toString(16);

    if (this.chainId === target) {
      try {
        const reported = await this.getCurrentChainId();
        if (reported === target) {
          return { ok: true, chainId: reported };
        }
      } catch {
        // Fall through to the real switch.
      }
    }

    try {
      await this.rawProvider.request({
        method: 'wallet_switchEthereumChain',
        params: [{ chainId: hex }],
      });
    } catch (e) {
      if (e.code === 4902 || (e.message && e.message.includes('Unrecognized chain ID'))) {
        return {
          ok: false,
          reason: `wallet does not have chain ${target} configured`,
        };
      }
      return { ok: false, reason: e.message || 'switch rejected' };
    }

    let observed = null;
    try {
      observed = await this.getCurrentChainId();
    } catch (e) {
      return { ok: false, reason: `could not read chain after switch: ${e.message}` };
    }

    if (observed !== null) {
      this.chainId = observed;
    }

    if (observed !== target) {
      return {
        ok: false,
        reason: `wallet reports chain ${observed}, expected ${target}`,
        chainId: observed,
      };
    }

    return { ok: true, chainId: observed };
  }

  async getCurrentChainId() {
    const hex = await this.rawProvider.request({ method: 'eth_chainId' });
    return parseInt(hex, 16);
  }

  async dispose() {
  }
}

export async function connectBrowserExtension() {
  if (typeof window === 'undefined' || !window.ethereum) {
    throw new Error(
      'No browser wallet detected. Install MetaMask, Rabby, or another EIP-1193 wallet extension and reload the page.'
    );
  }

  const raw = window.ethereum;

  let target = raw;
  if (Array.isArray(raw.providers) && raw.providers.length > 0) {
    target = raw.providers.find((p) => p.isMetaMask) || raw.providers[0];
  }

  const accounts = await target.request({ method: 'eth_requestAccounts' });
  if (!accounts || accounts.length === 0) {
    throw new Error('No accounts returned by the browser wallet');
  }
  const address = accounts[0];

  const chainIdHex = await target.request({ method: 'eth_chainId' });
  const chainId = parseInt(chainIdHex, 16);

  const ethersProvider = new ethers.BrowserProvider(target);

  return new BrowserExtensionBackend(ethersProvider, target, address, chainId);
}

// =====================================================================
// WALLETCONNECT BACKEND
// =====================================================================

export class WalletConnectBackend {
  constructor(provider, address, chainId) {
    this.provider = provider;
    this.rawProvider = provider.provider || provider;
    this.address = address;
    this.chainId = chainId;
  }

  async getAddress() {
    return this.address;
  }

  async getEthersSigner(_provider) {
    return this.provider.getSigner();
  }

  getSolanaKeypair() {
    throw new Error('WalletConnect does not support Solana in this build');
  }

  getBitcoinKeyPair() {
    throw new Error('WalletConnect does not support Bitcoin in this build');
  }

  async switchChain(chainId) {
    const target = Number(chainId);
    const hex = '0x' + target.toString(16);

    if (this.chainId === target) {
      try {
        const reported = await this.getCurrentChainId();
        if (reported === target) {
          this.chainId = reported;
          return { ok: true, chainId: reported };
        }
      } catch {
        // fall through
      }
    }

    const raw = this.rawProvider;
    if (!raw || typeof raw.request !== 'function') {
      return { ok: false, reason: 'WalletConnect provider not available' };
    }

    try {
      await raw.request({
        method: 'wallet_switchEthereumChain',
        params: [{ chainId: hex }],
      });
    } catch (e) {
      if (e.code === 4902 || (e.message && e.message.includes('Unrecognized chain ID'))) {
        try {
          await raw.request({
            method: 'wallet_addEthereumChain',
            params: [chainParamsFor(target)],
          });
        } catch (addErr) {
          return {
            ok: false,
            reason: `wallet does not have chain ${target} and could not add it: ${addErr.message}`,
          };
        }
      } else {
        return { ok: false, reason: e.message || 'switch rejected' };
      }
    }

    let observed = null;
    try {
      observed = await this.getCurrentChainId();
    } catch (e) {
      return { ok: false, reason: `could not read chain after switch: ${e.message}` };
    }

    if (observed !== null) {
      this.chainId = observed;
    }

    if (observed !== target) {
      return {
        ok: false,
        reason: `wallet reports chain ${observed}, expected ${target}`,
        chainId: observed,
      };
    }

    return { ok: true, chainId: observed };
  }

  async getCurrentChainId() {
    const raw = this.rawProvider;
    if (!raw) return null;

    if (typeof raw.chainId === 'number' && Number.isFinite(raw.chainId)) {
      return raw.chainId;
    }

    if (typeof raw.request === 'function') {
      try {
        const hex = await raw.request({ method: 'eth_chainId' });
        return parseInt(hex, 16);
      } catch {
        return null;
      }
    }

    return null;
  }

  async dispose() {
    try {
      await this.provider.disconnect?.();
    } catch {}
  }
}

function chainParamsFor(chainId) {
  const TABLE = {
    1:     { chainName: 'Ethereum',        nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 } },
    10:    { chainName: 'Optimism',        nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 } },
    56:    { chainName: 'BNB Chain',       nativeCurrency: { name: 'BNB',   symbol: 'BNB', decimals: 18 } },
    137:   { chainName: 'Polygon',         nativeCurrency: { name: 'POL',   symbol: 'POL', decimals: 18 } },
    8453:  { chainName: 'Base',            nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 } },
    42161: { chainName: 'Arbitrum One',    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 } },
  };
  const meta = TABLE[chainId] || { chainName: `Chain ${chainId}`, nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 } };
  return {
    chainId: '0x' + chainId.toString(16),
    chainName: meta.chainName,
    nativeCurrency: meta.nativeCurrency,
    rpcUrls: [],
    blockExplorerUrls: [],
  };
}

export async function connectWalletConnect({
  projectId,
  chains = [1, 42161, 10, 8453, 137],
  onUri,
  onConnect,
  onDisconnect,
}) {
  if (!projectId) throw new Error('WalletConnect requires a projectId');

  const { EthereumProvider } = await import('@walletconnect/ethereum-provider');

  const wcProvider = await EthereumProvider.init({
    projectId,
    chains: chains,
    optionalChains: chains,
    showQrModal: false,
    methods: [
      'eth_sendTransaction',
      'eth_signTransaction',
      'eth_sign',
      'personal_sign',
      'eth_signTypedData',
      'eth_signTypedData_v4',
      'wallet_switchEthereumChain',
      'wallet_addEthereumChain',
    ],
    events: ['chainChanged', 'accountsChanged'],
    metadata: {
      name: 'PoolPort LiquiFi',
      description: 'Non-custodial cross-chain wallet consolidation',
      url: window.location.origin,
      icons: [`${window.location.origin}/favicon.ico`],
    },
  });

  wcProvider.on('display_uri', (uri) => {
    if (onUri) onUri(uri);
  });

  await wcProvider.connect();

  if (onConnect) onConnect(wcProvider);

  wcProvider.on('disconnect', () => {
    if (onDisconnect) onDisconnect();
  });

  const accounts = wcProvider.accounts || [];
  if (accounts.length === 0) throw new Error('No accounts returned by WalletConnect');
  const address = accounts[0];

  const ethersProvider = new ethers.BrowserProvider(wcProvider);

  return new WalletConnectBackend(ethersProvider, address, wcProvider.chainId);
}

// =====================================================================
// LEDGER BACKEND
// =====================================================================

export class LedgerBackend {
  constructor(transport, ethApp, address, derivationPath) {
    this.transport = transport;
    this.ethApp = ethApp;
    this.address = address;
    this.derivationPath = derivationPath;
  }

  async getAddress() {
    return this.address;
  }

  async getEthersSigner(provider) {
    const address = this.address;
    const ethApp = this.ethApp;
    const path = this.derivationPath;

    class LedgerSigner extends ethers.AbstractSigner {
      constructor(provider) {
        super(provider);
        this.address = address;
      }

      async getAddress() {
        return this.address;
      }

      connect(provider) {
        return new LedgerSigner(provider);
      }

      async signTransaction(tx) {
        const unsignedTx = ethers.Transaction.from(tx);
        const unsignedHex = unsignedTx.unsignedSerialized.slice(2);

        const sig = await ethApp.signTransaction(path, unsignedHex);

        const v = normalizeV(sig.v);

        unsignedTx.signature = ethers.Signature.from({
          r: '0x' + sig.r,
          s: '0x' + sig.s,
          v,
        });

        return unsignedTx.serialized;
      }

      async signMessage(message) {
        const messageHex = typeof message === 'string'
          ? Buffer.from(message, 'utf8').toString('hex')
          : Buffer.from(message).toString('hex');
        const sig = await ethApp.signPersonalMessage(path, messageHex);
        const v = normalizeV(sig.v);
        return ethers.Signature.from({ r: '0x' + sig.r, s: '0x' + sig.s, v }).serialized;
      }

      async signTypedData(domain, types, value) {
        const sig = await ethApp.signEIP712Message(path, { domain, types, message: value });
        const v = normalizeV(sig.v);
        return ethers.Signature.from({ r: '0x' + sig.r, s: '0x' + sig.s, v }).serialized;
      }

      async sendTransaction(tx) {
        const signed = await this.signTransaction(tx);
        return this.provider.broadcastTransaction(signed);
      }
    }

    return new LedgerSigner(provider);
  }

  getSolanaKeypair() {
    throw new Error('Ledger Solana support not implemented in this build');
  }

  getBitcoinKeyPair() {
    throw new Error('Ledger Bitcoin support not implemented in this build');
  }

  async switchChain(_targetChainId) {
    return noopSwitchChain();
  }

  async getCurrentChainId() {
    return null;
  }

  async dispose() {
    try {
      await this.transport.close();
    } catch {}
  }
}

export async function connectLedger({ derivationPath = "44'/60'/0'/0/0" } = {}) {
  if (!navigator.hid) {
    throw new Error('WebHID is not supported in this browser. Use Chrome or Edge.');
  }

  const [{ default: TransportWebHID }, { default: Eth }] = await Promise.all([
    import('@ledgerhq/hw-transport-webhid'),
    import('@ledgerhq/hw-app-eth'),
  ]);

  const transport = await TransportWebHID.create();
  const ethApp = new Eth(transport);

  const result = await ethApp.getAddress(derivationPath, false, false);

  return new LedgerBackend(transport, ethApp, result.address, derivationPath);
}

// =====================================================================
// TREZOR BACKEND
// =====================================================================

export class TrezorBackend {
  constructor(address, derivationPath) {
    this.address = address;
    this.derivationPath = derivationPath;
  }

  async getAddress() {
    return this.address;
  }

  async getEthersSigner(provider) {
    const address = this.address;
    const path = this.derivationPath;

    class TrezorSigner extends ethers.AbstractSigner {
      constructor(provider) {
        super(provider);
        this.address = address;
      }

      async getAddress() {
        return this.address;
      }

      connect(provider) {
        return new TrezorSigner(provider);
      }

      async signTransaction(tx) {
        const { default: TrezorConnect } = await import('@trezor/connect-web');

        const resolved = await ethers.resolveProperties(tx);

        const result = await TrezorConnect.ethereumSignTransaction({
          path: path,
          transaction: {
            to: resolved.to || '',
            value: ethers.toQuantity(resolved.value || 0n),
            data: resolved.data || '0x',
            chainId: resolved.chainId,
            nonce: ethers.toQuantity(resolved.nonce),
            gasLimit: ethers.toQuantity(resolved.gasLimit),
            gasPrice: resolved.gasPrice ? ethers.toQuantity(resolved.gasPrice) : undefined,
            maxFeePerGas: resolved.maxFeePerGas ? ethers.toQuantity(resolved.maxFeePerGas) : undefined,
            maxPriorityFeePerGas: resolved.maxPriorityFeePerGas ? ethers.toQuantity(resolved.maxPriorityFeePerGas) : undefined,
          },
        });

        if (!result.success) throw new Error(result.payload.error);

        const { v, r, s } = result.payload;
        const vNum = normalizeV(v);

        const unsignedTx = ethers.Transaction.from(tx);
        unsignedTx.signature = ethers.Signature.from({ r, s, v: vNum });
        return unsignedTx.serialized;
      }

      async signMessage(message) {
        const { default: TrezorConnect } = await import('@trezor/connect-web');
        const messageHex = typeof message === 'string'
          ? Buffer.from(message, 'utf8').toString('hex')
          : Buffer.from(message).toString('hex');

        const result = await TrezorConnect.ethereumSignMessage({
          path: path,
          message: messageHex,
          hex: true,
        });

        if (!result.success) throw new Error(result.payload.error);
        const { v, r, s } = result.payload;
        const vNum = normalizeV(v);
        return ethers.Signature.from({ r, s, v: vNum }).serialized;
      }

      async signTypedData(domain, types, value) {
        const { default: TrezorConnect } = await import('@trezor/connect-web');
        const result = await TrezorConnect.ethereumSignTypedData({
          path: path,
          data: { domain, types, primaryType: Object.keys(types)[0], message: value },
          metamask_v4_compat: true,
        });

        if (!result.success) throw new Error(result.payload.error);
        const { v, r, s } = result.payload;
        const vNum = normalizeV(v);
        return ethers.Signature.from({ r, s, v: vNum }).serialized;
      }

      async sendTransaction(tx) {
        const signed = await this.signTransaction(tx);
        return this.provider.broadcastTransaction(signed);
      }
    }

    return new TrezorSigner(provider);
  }

  getSolanaKeypair() {
    throw new Error('Trezor Solana support not implemented in this build');
  }

  getBitcoinKeyPair() {
    throw new Error('Trezor Bitcoin support not implemented in this build');
  }

  async switchChain(_targetChainId) {
    return noopSwitchChain();
  }

  async getCurrentChainId() {
    return null;
  }

  async dispose() {}
}

export async function connectTrezor({ derivationPath = "m/44'/60'/0'/0/0" } = {}) {
  const { default: TrezorConnect } = await import('@trezor/connect-web');

  await TrezorConnect.init({
    lazyLoad: true,
    manifest: {
      email: 'info@poolport.xyz',
      appUrl: window.location.origin,
    },
  });

  const result = await TrezorConnect.ethereumGetAddress({
    path: derivationPath,
    showOnTrezor: true,
  });

  if (!result.success) {
    throw new Error(result.payload.error);
  }

  return new TrezorBackend(result.payload.address, derivationPath);
}

// =====================================================================
// UNIFIED CONSTRUCTOR
// =====================================================================

export async function createWallet(config) {
  switch (config.type) {
    case 'mnemonic':
      if (!config.phrase) throw new Error('Mnemonic requires a phrase');
      return new MnemonicWallet(config.phrase);

    case 'extension':
      return await connectBrowserExtension();

    case 'walletconnect':
      return await connectWalletConnect({
        projectId: config.wcProjectId,
        onUri: config.wcOnUri,
      });

    case 'ledger':
      return await connectLedger({
        derivationPath: config.derivationPath,
      });

    case 'trezor':
      return await connectTrezor({
        derivationPath: config.derivationPath,
      });

    default:
      throw new Error(`Unknown wallet type: ${config.type}`);
  }
}