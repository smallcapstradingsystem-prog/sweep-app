/**
 * operator-view.js — shared receipt formatter.
 * =====================================================================
 * Used by payment-worker (to render the initial operator view at record
 * time) and by reconciler-worker (to re-render after receipts are
 * updated with real settled amounts). Keeping this in one place means
 * the two never drift.
 *
 * Input: `receipts` array and `gasSponsorships` array as stored on the
 * sweep record. Output: a multi-line string.
 */

export function buildOperatorView(receipts, gasSponsorships) {
  const lines = [];
  lines.push('SWEEP RECEIPT');
  lines.push('═'.repeat(60));
  lines.push('');

  const sponsorFeeForChain = (chain) => {
    let total = 0n;
    for (const gs of gasSponsorships || []) {
      if (gs.chain === chain) total += BigInt(gs.sponsorshipFeeUsdcRaw);
    }
    return total;
  };

  for (const r of receipts) {
    const chainLabel = r.family === 'evm' ? `EVM ${r.chain}` : r.family;
    const received = BigInt(r.amountRaw);
    const sponsorFee = r.family === 'evm' ? sponsorFeeForChain(r.chain) : 0n;

    lines.push(`[${chainLabel}]`);

    if (r.verified === true) {
      lines.push(`  Verification:      ✓ verified on-chain`);
      if (r.observedRaw) {
        const observed = BigInt(r.observedRaw);
        if (r.discrepancy) {
          lines.push(`  ⚠ Observed:        ${formatAmount(observed, r.decimals)} (claimed ${formatAmount(received, r.decimals)}) — concurrent sweep likely`);
        } else {
          lines.push(`  Observed:          ${formatAmount(observed, r.decimals)}`);
        }
      }
      if (r.reconciledAt) {
        lines.push(`  Reconciled:        ${r.reconciledAt}`);
      }
    } else if (r.verifyReason === 'settled-later') {
      lines.push(`  Verification:      ⏳ pending reconciliation (settles hours after sweep)`);
    } else if (r.verifyReason === 'reconcile-timeout') {
      lines.push(`  Verification:      ✗ reconciliation timed out — needs manual review`);
    } else if (r.unverifiable === true) {
      lines.push(`  Verification:      ⚠ unverified (${r.verifyReason || 'unknown'}) — cannot prove either way`);
    } else {
      lines.push(`  Verification:      ✗ NOT verified (${r.verifyReason || 'unknown'})`);
    }

    lines.push(`  Fee wallet:        ${r.recipient}`);
    lines.push(`  ${r.symbol} claimed:   ${formatAmount(received, r.decimals)}`);
    if (sponsorFee > 0n) {
      lines.push(`  Sponsorship fee:  -${formatAmount(sponsorFee, r.decimals)} ${r.symbol}`);
    }
    lines.push(`  User destination:  ${r.userDestination}`);
    lines.push('');
  }

  lines.push('═'.repeat(60));
  return lines.join('\n');
}

function formatAmount(raw, decimals) {
  const s = raw.toString();
  const neg = s.startsWith('-');
  const digits = neg ? s.slice(1) : s;
  const padded = digits.padStart(decimals + 1, '0');
  const whole = padded.slice(0, padded.length - decimals);
  const frac = padded.slice(padded.length - decimals);
  return `${neg ? '-' : ''}${whole}.${frac}`;
}