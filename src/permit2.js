/**
 * permit2.js — Uniswap Permit2 integration (kept for future use).
 * =====================================================================
 * Permit2 lets a user authorize a spender to pull tokens with an
 * off-chain signature instead of an on-chain `approve` transaction.
 *
 * IMPORTANT: Permit2 only helps when the ROUTER natively supports it.
 * SwapRouter02 (used in evm.js today) does NOT — it pulls tokens via
 * `transferFrom`, which requires a normal `approve`.
 *
 * To actually benefit from Permit2, the app would need to swap through
 * Universal Router, which accepts a PERMIT2_PERMIT command bundled with
 * the swap. That migration is a separate project.
 *
 * Until then, this module is dead code — safe to keep in the bundle as
 * preparation for that migration. It exports a working implementation
 * of the Permit2 signature + submit flow, so when you swap to Universal
 * Router, the client-side plumbing is ready.
 *
 * What's implemented:
 *   - isApprovedToPermit2     — check if a token is already approved
 *   - approveTokenToPermit2   — one-time approve to Permit2
 *   - signPermitSingle        — sign a permit for one token
 *   - signPermitBatch         — sign a batch permit for N tokens
 *   - submitPermitSingle      — send the permit to the chain
 *   - submitPermitBatch       — send a batch permit to the chain
 *   - ensurePermit2BatchApproval — high-level: check + sign + submit
 *   - PERMIT2_ADDRESS
 *
 * Reference:
 *   https://docs.uniswap.org/contracts/permit2/overview
 */

import { ethers } from 'ethers';
import { AllowanceTransfer, PERMIT2_ADDRESS } from '@uniswap/permit2-sdk';

// =====================================================================
// CONSTANTS
// =====================================================================
//
// The SDK exports `MaxAllowanceTransferAmount` and `MaxAllowanceExpiration`
// in some versions but not all. Fall back to explicit values if missing.
//
const MAX_UINT160 = (2n ** 160n) - 1n;
const MAX_UINT48  = (2n ** 48n) - 1n;

const MAX_AMOUNT =
  typeof AllowanceTransfer.MaxAllowanceTransferAmount !== 'undefined'
    ? AllowanceTransfer.MaxAllowanceTransferAmount
    : MAX_UINT160;

const MAX_EXPIRATION =
  typeof AllowanceTransfer.MaxAllowanceExpiration !== 'undefined'
    ? AllowanceTransfer.MaxAllowanceExpiration
    : Number(MAX_UINT48);

// Permit2 canonical deployments are at the same address on every EVM
// chain. If you ever find a chain where this doesn't hold, extend this
// map with an override.
const PERMIT2_DEPLOYED = {
  1: PERMIT2_ADDRESS,       // Ethereum mainnet
  10: PERMIT2_ADDRESS,      // Optimism
  137: PERMIT2_ADDRESS,     // Polygon
  8453: PERMIT2_ADDRESS,    // Base
  42161: PERMIT2_ADDRESS,   // Arbitrum One
};

// =====================================================================
// ABIs
// =====================================================================

const PERMIT2_ABI = [
  // Read a single allowance
  'function allowance(address owner, address token, address spender) view returns (uint160 amount, uint48 expiration, uint48 nonce)',
  // Standard ERC20 approve to Permit2 (one-time)
  'function approve(address token, address spender, uint160 amount, uint48 expiration)',
  // Single permit
  'function permit(address owner, tuple(tuple(address token, uint160 amount, uint48 expiration, uint48 nonce) details, address spender, uint256 sigDeadline) permitSingle, bytes calldata signature)',
  // Batch permit
  'function permit(address owner, tuple(tuple(address token, uint160 amount, uint48 expiration, uint48 nonce)[] details, address spender, uint256 sigDeadline) permitBatch, bytes calldata signature)',
  // Transfer via allowance set by a permit
  'function transferFrom(address from, address to, uint160 amount, address token)',
];

const ERC20_ABI = [
  'function approve(address, uint256) returns (bool)',
  'function allowance(address, address) view returns (uint256)',
];

// =====================================================================
// HELPERS
// =====================================================================

function getPermit2Address(chainId) {
  const addr = PERMIT2_DEPLOYED[Number(chainId)];
  if (!addr) {
    throw new Error(`Permit2 is not deployed at a known address on chain ${chainId}`);
  }
  return addr;
}

/**
 * Check whether Permit2 can be used on this chain at all.
 */
export function isPermit2Supported(chainId) {
  return typeof PERMIT2_DEPLOYED[Number(chainId)] === 'string';
}

// =====================================================================
// ALLOWANCE CHECKS
// =====================================================================

/**
 * Check if a token is already approved to Permit2 for this owner, and
 * the allowance is at least `neededAmount`.
 *
 * Returns:
 *   { approved: boolean, current: bigint, expiration: number }
 */
export async function isApprovedToPermit2(provider, owner, token, neededAmount) {
  const permit2 = new ethers.Contract(PERMIT2_ADDRESS, PERMIT2_ABI, provider);
  const [amount, expiration] = await permit2.allowance(owner, token, PERMIT2_ADDRESS);

  const now = Math.floor(Date.now() / 1000);
  const notExpired = Number(expiration) === 0 || Number(expiration) > now;
  const enoughAmount = BigInt(amount) >= BigInt(neededAmount);

  return {
    approved: notExpired && enoughAmount,
    current: BigInt(amount),
    expiration: Number(expiration),
  };
}

/**
 * Approve a single token to Permit2. This is a standard ERC20 approve
 * and costs one transaction per token, once per wallet.
 *
 * After this, the wallet can use Permit2's signature-based transfer
 * instead of requiring additional approve calls.
 */
export async function approveTokenToPermit2(signer, token) {
  const erc20 = new ethers.Contract(token, ERC20_ABI, signer);
  const tx = await erc20.approve(PERMIT2_ADDRESS, ethers.MaxUint256);
  return tx;
}

// =====================================================================
// PERMIT SIGNING
// =====================================================================

/**
 * Sign a PermitSingle (one token) for `spender`.
 *
 * Returns { permitData, signature }.
 * The permitData includes the current nonce read from the chain.
 * The signature is EIP-712 typed-data, signable by any wallet.
 */
export async function signPermitSingle(signer, { token, amount, spender, expirationSeconds = 3600 }) {
  const owner = await signer.getAddress();
  const provider = signer.provider;
  const chainId = Number((await provider.getNetwork()).chainId);

  getPermit2Address(chainId); // throws if not deployed

  const permit2 = new ethers.Contract(PERMIT2_ADDRESS, PERMIT2_ABI, provider);
  const [, , nonce] = await permit2.allowance(owner, token, PERMIT2_ADDRESS);

  const sigDeadline = Math.floor(Date.now() / 1000) + expirationSeconds;

  const permitSingle = {
    details: {
      token,
      amount: amount ?? MAX_AMOUNT,
      expiration: MAX_EXPIRATION,
      nonce: Number(nonce),
    },
    spender,
    sigDeadline,
  };

  const { domain, types, values } = AllowanceTransfer.getPermitData(
    permitSingle,
    PERMIT2_ADDRESS,
    chainId
  );

  const signature = await signer.signTypedData(domain, types, values);

  return { permitData: permitSingle, signature };
}

/**
 * Sign a PermitBatch (N tokens) for `spender`.
 *
 * All tokens must be approved to Permit2 first (see approveTokenToPermit2).
 * The batch permit covers them in one signature.
 */
export async function signPermitBatch(signer, tokens, spender, expirationSeconds = 3600) {
  const owner = await signer.getAddress();
  const provider = signer.provider;
  const chainId = Number((await provider.getNetwork()).chainId);

  getPermit2Address(chainId);

  const permit2 = new ethers.Contract(PERMIT2_ADDRESS, PERMIT2_ABI, provider);

  const details = await Promise.all(
    tokens.map(async (t) => {
      const [, , nonce] = await permit2.allowance(owner, t.address, PERMIT2_ADDRESS);
      return {
        token: t.address,
        amount: t.amount ?? MAX_AMOUNT,
        expiration: MAX_EXPIRATION,
        nonce: Number(nonce),
      };
    })
  );

  const sigDeadline = Math.floor(Date.now() / 1000) + expirationSeconds;

  const permitBatch = {
    details,
    spender,
    sigDeadline,
  };

  const { domain, types, values } = AllowanceTransfer.getPermitData(
    permitBatch,
    PERMIT2_ADDRESS,
    chainId
  );

  const signature = await signer.signTypedData(domain, types, values);

  return { permitData: permitBatch, signature };
}

// =====================================================================
// PERMIT SUBMISSION
// =====================================================================

/**
 * Submit a single permit to the chain. This sets the allowance for the
 * spender. After submission, the spender can call `transferFrom` on
 * Permit2 to pull tokens.
 */
export async function submitPermitSingle(signer, { permitData, signature }) {
  const permit2 = new ethers.Contract(PERMIT2_ADDRESS, PERMIT2_ABI, signer);
  const owner = await signer.getAddress();
  const tx = await permit2[
    'permit(address,((address,uint160,uint48,uint48),address,uint256),bytes)'
  ](owner, permitData, signature);
  return tx;
}

/**
 * Submit a batch permit. Sets allowances for multiple tokens in one tx.
 */
export async function submitPermitBatch(signer, { permitData, signature }) {
  const permit2 = new ethers.Contract(PERMIT2_ADDRESS, PERMIT2_ABI, signer);
  const owner = await signer.getAddress();
  const tx = await permit2[
    'permit(address,((address,uint160,uint48,uint48)[],address,uint256),bytes)'
  ](owner, permitData, signature);
  return tx;
}

// =====================================================================
// HIGH-LEVEL
// =====================================================================

/**
 * Ensure multiple tokens are approved to Permit2, using a batched
 * permit where possible. Returns the number of approve txs actually
 * broadcast, or { skipped: true } if everything was already approved.
 *
 * This is a two-step process in Permit2:
 *
 *   1. Standard ERC20 `approve` to Permit2 (once per token, ever)
 *   2. Permit2 `permit` for the spender (per batch, signed off-chain,
 *      submitted on-chain in one tx)
 *
 * Steps 1 and 2 each cost gas. The savings kick in when a wallet does
 * multiple swaps of the same tokens over time — the standard approve
 * is paid once and reused.
 */
export async function ensurePermit2BatchApproval(signer, tokens, spender, opts = {}) {
  if (tokens.length === 0) return { txs: 0, skipped: true };

  const owner = await signer.getAddress();
  const provider = signer.provider;

  // Step 1: find which tokens still need a standard ERC20 approve to Permit2
  const needApproval = [];
  for (const t of tokens) {
    const { approved } = await isApprovedToPermit2(provider, owner, t.address, t.amount ?? 1n);
    if (!approved) needApproval.push(t);
  }

  if (opts.dryRun) {
    return {
      txs: needApproval.length + 1, // approvals + one batch permit
      dryRun: true,
      needApproval: needApproval.length,
    };
  }

  // Step 2: standard ERC20 approvals, one tx each
  let approveTxs = 0;
  for (const t of needApproval) {
    const tx = await approveTokenToPermit2(signer, t.address);
    await tx.wait();
    approveTxs++;
  }

  // Step 3: sign and submit one batch permit for the spender
  let permitTxs = 0;
  if (needApproval.length > 0) {
    const { permitData, signature } = await signPermitBatch(signer, needApproval, spender);
    const tx = await submitPermitBatch(signer, { permitData, signature });
    await tx.wait();
    permitTxs = 1;
  }

  return { txs: approveTxs + permitTxs, tokens: tokens.length, needApproval: needApproval.length };
}

// =====================================================================
// EXPORTS
// =====================================================================

export { PERMIT2_ADDRESS, MAX_AMOUNT, MAX_EXPIRATION };