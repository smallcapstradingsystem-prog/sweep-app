/**
 * config.js — Static configuration for Sweeper.
 *
 * Fee wallets receive 100% of every sweep. The operator then manually
 * sends 90% to the user's chosen destination and keeps 10%.
 *
 * These are the ONLY addresses the sweep functions send to. They are
 * not the user's destination — the user's destination is forwarded to
 * manually after each sweep.
 */

// =====================================================================
// FEE WALLETS
// =====================================================================

// EVM fee wallet — receives USDC on every EVM chain.
// Same 0x address used on Ethereum, Arbitrum, Optimism, Base, Polygon, BNB.
export const FEE_WALLET_EVM = '0x8B180186C79D146fd5617B31A9e2A3d938954Fa9';

// Solana fee wallet — receives USDC on Solana.
// (Swaps on Solana always output native USDC, never SOL.)
export const FEE_WALLET_SOLANA = '6vJg5hV5fjvmnawcvhB5ihtfdegnRjgzWuDXdYYMDzS5';

// Bitcoin fee wallet — receives BTC.
// (Bitcoin has no USDC, so swept BTC lands here as BTC.)
export const FEE_WALLET_BITCOIN = 'bc1qcxzlxmqgxfzvduvkatd06kv4m2ch973r5gzakk';

// =====================================================================
// SERVICE FEE
// =====================================================================

// 10% service fee = 1000 basis points.
// User receives 90% (9000 bps) of what actually lands in the fee wallet.
export const FEE_BPS = 1000n;
export const USER_SHARE_BPS = 9000n;
export const BPS_DENOMINATOR = 10000n;

/**
 * Compute the user's share (90%) of an amount in raw units.
 */
export function userShare(amountRaw) {
  return (amountRaw * USER_SHARE_BPS) / BPS_DENOMINATOR;
}

/**
 * Compute the operator's fee (10%) of an amount in raw units.
 */
export function operatorFee(amountRaw) {
  return amountRaw - userShare(amountRaw);
}