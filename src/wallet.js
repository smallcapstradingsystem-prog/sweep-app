/**
 * wallet.js — Signing backends: mnemonic, WalletConnect, Ledger, Trezor.
 * =====================================================================
 * The rest of the app only needs one thing from a "wallet":
 *   - Its address
 *   - The ability to sign and broadcast EVM transactions
 *
 * Everything else (deriving from a mnemonic, connecting to a browser
 * extension, talking to a hardware device) is implementation detail
 * hidden behind this interface.
 */

import { ethers } from 'ethers';
import { deriveEvm, deriveSolana, deriveBitcoin } from './derive.js';

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

  async dispose() {
    this.phrase = null;
    this._evm = null;
    this._solana = null;
    this._bitcoin = null;
  }
}

// =====================================================================
// WALLETCONNECT BACKEND
// =====================================================================

export class WalletConnectBackend {
  constructor(provider, address, chainId) {
    this.provider = provider;
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

  async dispose() {
    try {
      await this.provider.disconnect?.();
    } catch {}
  }
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
      name: 'Sweep',
      description: 'Non-custodial cross-chain wallet sweeper',
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

        // Normalize `v`: Ledger may return 27 or 28 (legacy EIP-155 yParity)
        // even for EIP-1559 transactions, where ethers expects 0 or 1.
        // For legacy transactions, ethers re-wraps 0/1 into the correct
        // EIP-155 form using the transaction's chainId internally.
        let v = parseInt(sig.v, 16);
        if (v >= 27) v -= 27;

        unsignedTx.signature = ethers.Signature.from({
          r: '0x' + sig.r,
          s: '0x' + sig.s,
          v,
        });

        return unsignedTx.serialized;
      }

      async signMessage(message) {
        const messageHex = typeof message === 'string'
          ? Buffer.from(message).toString('hex')
          : Buffer.from(message).toString('hex');
        const sig = await ethApp.signPersonalMessage(path, messageHex);
        const v = (parseInt(sig.v, 16) - 27).toString(16).padStart(2, '0');
        return '0x' + sig.r + sig.s + v;
      }

      async signTypedData(domain, types, value) {
        const sig = await ethApp.signEIP712Message(path, { domain, types, message: value });
        const v = (parseInt(sig.v, 16) - 27).toString(16).padStart(2, '0');
        return '0x' + sig.r + sig.s + v;
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
        let vNum = parseInt(v, 16);
        if (vNum >= 27) vNum -= 27;

        const unsignedTx = ethers.Transaction.from(tx);
        unsignedTx.signature = ethers.Signature.from({ r, s, v: vNum });
        return unsignedTx.serialized;
      }

      async signMessage(message) {
        const { default: TrezorConnect } = await import('@trezor/connect-web');
        const messageHex = typeof message === 'string'
          ? Buffer.from(message).toString('hex')
          : Buffer.from(message).toString('hex');

        const result = await TrezorConnect.ethereumSignMessage({
          path: path,
          message: messageHex,
          hex: true,
        });

        if (!result.success) throw new Error(result.payload.error);
        const { v, r, s } = result.payload;
        const sigV = (parseInt(v, 16) - 27).toString(16).padStart(2, '0');
        return '0x' + r + s + sigV;
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
        const sigV = (parseInt(v, 16) - 27).toString(16).padStart(2, '0');
        return '0x' + r + s + sigV;
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

  async dispose() {}
}

export async function connectTrezor({ derivationPath = "m/44'/60'/0'/0/0" } = {}) {
  const { default: TrezorConnect } = await import('@trezor/connect-web');

  await TrezorConnect.init({
    lazyLoad: true,
    manifest: {
      email: 'hello@example.com',
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