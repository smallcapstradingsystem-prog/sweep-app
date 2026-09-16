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

export const GAS_SPONSOR_ADDRESS = '0xb79312dd1CC7A67029060614108D9767333afF95';

// =====================================================================
// GAS SPONSORSHIP SHORTFALLS
// =====================================================================
//
// The sponsor sends only the SHORTFALL between the user's current
// native balance and what a single transaction will cost. There is no
// "target" balance.
//
// PER_TX_COST is a conservative estimate of the gas cost for one
// transaction (approve or swap) on each chain:
//
//   ethereum: 0.0008 ETH  (mainnet, expensive)
//   arbitrum: 0.00002 ETH
//   optimism: 0.00002 ETH
//   base:     0.00002 ETH
//   polygon:  0.01 POL
//   bnb:      0.0002 BNB
//
// Solana is deliberately NOT in this table. Solana tx fees are ~$0.001,
// and part of the deBridge order's cost is refundable rent. Sponsoring
// it would be sponsoring a loan for no economic reason. Solana sweeps
// require the user to already hold a small SOL balance; if they don't,
// the sweep is skipped client-side.
//
// The retry loop handles cases where the estimate is too low — the
// client will re-request sponsorship and try again, up to 5 times.
// =====================================================================

export const GAS_PER_TX_COST = {
  ethereum: '0.0008',
  arbitrum: '0.00002',
  optimism: '0.00002',
  base:     '0.00002',
  polygon:  '0.01',
  bnb:      '0.0002',
};

// The retry loop needs to know when a wallet has *enough* to attempt a
// swap. We use the same per-tx cost as the threshold. If the wallet's
// balance is below this, sponsor the shortfall to reach it.
export const GAS_TRIGGERS = { ...GAS_PER_TX_COST };

// Maximum number of sponsorship+swap retry attempts per chain per wallet.
export const MAX_SPONSOR_ATTEMPTS = 5;

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