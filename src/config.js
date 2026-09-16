/**
 * config.js — Static configuration for Sweeper.
 */

// =====================================================================
// FEE WALLETS
// =====================================================================

export const FEE_WALLET_EVM = '0x8B180186C79D146fd5617B31A9e2A3d938954Fa9';
export const FEE_WALLET_SOLANA = '6vJg5hV5fjvmnawcvhB5ihtfdegnRjgzWuDXdYYMDzS5';
export const FEE_WALLET_BITCOIN = 'bc1qcxzlxmqgxfzvduvkatd06kv4m2ch973r5gzakk';

// =====================================================================
// GAS SPONSOR WALLET (hot, only funds user gas)
// =====================================================================
//
// Public address only — the private key lives on Cloudflare as the
// GAS_SPONSOR_KEY secret. This wallet's job is to send small amounts
// of native gas to user wallets that can't pay for their own sweeps.
//
// It is entirely separate from the fee wallet. If this key leaks, an
// attacker can drain the sponsor wallet but never touch user USDC.
// =====================================================================

export const GAS_SPONSOR_ADDRESS = '0xb79312dd1CC7A67029060614108D9767333afF95';

// =====================================================================
// GAS SPONSORSHIP TARGETS
// =====================================================================
//
// When a user's wallet balance is below TARGET, the sponsor tops them
// up to TARGET. This gives a small safety buffer beyond what a single
// sweep costs (approve + swap + swap ...).
//
// TARGETS are in wei-equivalent native token units:
//   Ethereum mainnet: 0.003 ETH  (mainnet gas is expensive)
//   Arbitrum / OP / Base: 0.0002 ETH
//   Polygon: 0.1 POL
//   BNB Chain: 0.002 BNB
// =====================================================================

export const GAS_TARGETS = {
  ethereum: '0.003',
  arbitrum: '0.0002',
  optimism: '0.0002',
  base:     '0.0002',
  polygon:  '0.1',
  bnb:      '0.002',
};

// The trigger below which we sponsor. If the wallet's balance is
// already >= TRIGGER, we do nothing (even if it's below TARGET — it
// means the wallet was funded externally).
export const GAS_TRIGGERS = {
  ethereum: '0.001',
  arbitrum: '0.00005',
  optimism: '0.00005',
  base:     '0.00005',
  polygon:  '0.02',
  bnb:      '0.0005',
};

// =====================================================================
// SERVICE FEE (10% of user's sweep output)
// =====================================================================

export const FEE_BPS = 1000n;
export const USER_SHARE_BPS = 9000n;
export const BPS_DENOMINATOR = 10000n;

export function userShare(amountRaw) {
  return (amountRaw * USER_SHARE_BPS) / BPS_DENOMINATOR;
}

export function operatorFee(amountRaw) {
  return amountRaw - userShare(amountRaw);
}

// =====================================================================
// GAS SPONSORSHIP FEE (deducted from user's 90%)
// =====================================================================
//
// Charged in USD cents, subtracted from the user's share.
// Rule:
//   - If actual gas cost < $1.00, charge $1.00 flat
//   - If actual gas cost >= $1.00, charge 2× actual
//
// Amounts are returned in USDC raw units (6 decimals) for convenience.
// =====================================================================

export function computeSponsorshipFeeUsdCents(actualGasCostUsdCents) {
  if (actualGasCostUsdCents < 100) return 100;      // $1 minimum
  return actualGasCostUsdCents * 2;                 // 2× actual
}

export function usdCentsToUsdcRaw(cents) {
  // 1 cent = 0.01 USDC = 10000 raw units (6 decimals)
  return BigInt(cents) * 10000n;
}