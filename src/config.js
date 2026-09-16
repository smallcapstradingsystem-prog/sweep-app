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
// 0X FEE PARAMS (EVM atomic-split)
// =====================================================================
//
// 0x's AllowanceHolder endpoint accepts:
//   - recipient         — where the non-fee portion of the output goes
//   - swapFeeRecipient  — where the fee goes
//   - swapFeeBps        — how much, in basis points (1000 = 10%)
//   - swapFeeToken      — which token the fee is denominated in
//
// 0x caps swapFeeBps at 1000 (10%) by default. Going higher requires
// contacting 0x support for a custom rate.
// =====================================================================

export const SWAP_FEE_BPS = 1000;  // 10%

// =====================================================================
// GAS SPONSOR WALLET (hot, only funds user gas)
// =====================================================================

export const GAS_SPONSOR_ADDRESS = '0xb79312dd1CC7A67029060614108D9767333afF95';

// =====================================================================
// GAS SPONSORSHIP SHORTFALLS
// =====================================================================
//
// EVM-only. Solana and Bitcoin don't use sponsorship:
//   - Solana: order fees are ~$0.001 and partly refundable rent; the
//     sweep is simply skipped if the wallet doesn't already hold enough.
//   - Bitcoin: the network fee is deducted from the swept UTXOs.
// =====================================================================

export const GAS_PER_TX_COST = {
  ethereum: '0.0008',
  arbitrum: '0.00002',
  optimism: '0.00002',
  base:     '0.00002',
  polygon:  '0.01',
  bnb:      '0.0002',
};

export const GAS_TRIGGERS = { ...GAS_PER_TX_COST };

export const MAX_SPONSOR_ATTEMPTS = 5;

// =====================================================================
// SERVICE FEE (10% of user's sweep output)
// =====================================================================
//
// NOTE: In the direct-to-user model, the 10% fee is taken at swap time
// by 0x / deBridge / THORChain — never by Sweeper. These helpers are
// retained for backwards compatibility with code paths that still
// compute user-share arithmetically (dry-run estimates, receipts that
// predate the atomic split).
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
// Rule:
//   - If actual gas cost < $1.00, charge $1.00 flat
//   - If actual gas cost >= $1.00, charge 2× actual
// =====================================================================

export function computeSponsorshipFeeUsdCents(actualGasCostUsdCents) {
  if (actualGasCostUsdCents < 100) return 100;
  return actualGasCostUsdCents * 2;
}

export function usdCentsToUsdcRaw(cents) {
  return BigInt(cents) * 10000n; // 1 cent = 0.01 USDC = 10000 raw units
}