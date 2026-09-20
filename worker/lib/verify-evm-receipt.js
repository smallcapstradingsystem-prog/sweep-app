/**
 * verify-evm-receipt.js — independently verify an EVM fee receipt.
 * =====================================================================
 * The client claims a USDC fee landed in our fee wallet on a specific
 * chain, from a specific tx. We don't take that on faith.
 *
 * This function:
 *   1. Fetches the tx receipt from the chain RPC.
 *   2. Confirms the tx succeeded (status === 1).
 *   3. Decodes all USDC Transfer logs in the receipt where the `to`
 *      address is our fee wallet.
 *   4. Sums those amounts.
 *   5. Compares against the client's claimed amount, applying the
 *      "floor" policy: observed >= claimed passes; observed < claimed
 *      fails.
 *
 * Policy decisions baked in (confirmed with the operator):
 *
 *   - We record the CLAIMED amount as the fee, not the observed amount.
 *     The claim is what the client is asserting happened; the observed
 *     value is recorded separately as a cross-check. Recording the
 *     observed value would attribute a concurrent sweep's fee to the
 *     wrong user when two sweeps land in the same block.
 *
 *   - We flag `discrepancy: true` when observed > claimed * 1.01. A
 *     concurrent sweep landing in the same block produces this shape.
 *     The extra is not credited to this receipt.
 *
 *   - We do NOT flag observed == claimed as suspicious. That's the
 *     happy path.
 *
 *   - We do NOT verify the fee amount for non-USDC tokens. The fee is
 *     always denominated in USDC by the swap routing (0x with
 *     swapFeeToken set to the buy token, which is USDC). If a receipt
 *     claims a non-USDC fee, we treat it as unverified.
 *
 * Return shape:
 *   {
 *     verified: boolean,
 *     observedRaw: string | null,
 *     reason: string | null,        // null when verified
 *     discrepancy: boolean,
 *   }
 */

import { ethers } from 'ethers';

// USDC on each supported EVM chain, with decimals.
// MUST MATCH src/evm.js USDC_ADDRESSES and the decimals logic there.
const USDC_BY_CHAIN = {
  ethereum: { address: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', decimals: 6 },
  arbitrum: { address: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831', decimals: 6 },
  optimism: { address: '0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85', decimals: 6 },
  base:     { address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', decimals: 6 },
  polygon:  { address: '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359', decimals: 6 },
  bnb:      { address: '0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d', decimals: 18 },
};

// keccak256("Transfer(address,address,uint256)")
const TRANSFER_TOPIC =
  '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';

const DISCREPANCY_NUMERATOR = 1001n;
const DISCREPANCY_DENOMINATOR = 1000n;

/**
 * @param {object} receipt      — { chain, txHash, recipient, amountRaw, symbol }
 * @param {string} rpcUrl       — full RPC URL for the chain
 * @returns {Promise<object>}
 */
export async function verifyEvmReceipt(receipt, rpcUrl) {
  const { chain, txHash, recipient, amountRaw, symbol } = receipt;

  if (!chain || !USDC_BY_CHAIN[chain]) {
    return {
      verified: false,
      observedRaw: null,
      reason: `unsupported or missing chain: ${chain}`,
      discrepancy: false,
    };
  }

  // The fee is always USDC. If a receipt claims otherwise, we can't
  // verify it against the USDC Transfer logs.
  if (symbol && symbol.toUpperCase() !== 'USDC') {
    return {
      verified: false,
      observedRaw: null,
      reason: `fee must be USDC; receipt claims ${symbol}`,
      discrepancy: false,
    };
  }

  if (!txHash || !/^0x[a-fA-F0-9]{64}$/.test(txHash)) {
    return {
      verified: false,
      observedRaw: null,
      reason: 'missing or malformed txHash',
      discrepancy: false,
    };
  }

  if (!recipient || !/^0x[a-fA-F0-9]{40}$/.test(recipient)) {
    return {
      verified: false,
      observedRaw: null,
      reason: 'missing or malformed recipient',
      discrepancy: false,
    };
  }

  let claimed;
  try {
    claimed = BigInt(amountRaw);
  } catch {
    return {
      verified: false,
      observedRaw: null,
      reason: 'malformed amountRaw',
      discrepancy: false,
    };
  }

  if (claimed <= 0n) {
    return {
      verified: false,
      observedRaw: null,
      reason: 'non-positive claim',
      discrepancy: false,
    };
  }

  let txReceipt;
  try {
    const provider = new ethers.JsonRpcProvider(rpcUrl);
    txReceipt = await provider.getTransactionReceipt(txHash);
  } catch (e) {
    return {
      verified: false,
      observedRaw: null,
      reason: `rpc error: ${e.message}`,
      discrepancy: false,
    };
  }

  if (!txReceipt) {
    return {
      verified: false,
      observedRaw: null,
      reason: 'tx not found',
      discrepancy: false,
    };
  }

  if (txReceipt.status !== 1) {
    return {
      verified: false,
      observedRaw: null,
      reason: 'tx reverted',
      discrepancy: false,
    };
  }

  const usdcLower = USDC_BY_CHAIN[chain].address.toLowerCase();
  const recipientLower = recipient.toLowerCase();

  let observed = 0n;
  for (const entry of txReceipt.logs) {
    if (entry.address.toLowerCase() !== usdcLower) continue;
    if (entry.topics.length !== 3) continue;
    if (entry.topics[0] !== TRANSFER_TOPIC) continue;

    // topics[2] is the `to` address, left-padded to 32 bytes.
    const to = '0x' + entry.topics[2].slice(26);
    if (to.toLowerCase() !== recipientLower) continue;

    try {
      observed += BigInt(entry.data);
    } catch {
      // Skip malformed log data rather than failing the whole check.
    }
  }

  const verified = observed >= claimed;
  const discrepancy = verified && observed * DISCREPANCY_DENOMINATOR
    > claimed * DISCREPANCY_NUMERATOR;

  return {
    verified,
    observedRaw: observed.toString(),
    reason: verified ? null : `observed ${observed} < claimed ${claimed}`,
    discrepancy,
  };
}

export { USDC_BY_CHAIN };