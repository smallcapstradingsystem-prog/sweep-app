import { ethers } from 'ethers';
import { AllowanceTransfer, PERMIT2_ADDRESS, MaxAllowanceTransferAmount, MaxAllowanceExpiration } from '@uniswap/permit2-sdk';

const PERMIT2_ABI = [
  'function approve(address token, address spender, uint160 amount, uint48 expiration) external',
  'function allowance(address owner, address token, address spender) external view returns (uint160 amount, uint48 expiration, uint48 nonce)',
];
const ERC20_ABI = [
  'function approve(address, uint256) returns (bool)',
  'function allowance(address, address) view returns (uint256)',
];

export async function isApprovedToPermit2(provider, owner, token, neededAmount) {
  const permit2 = new ethers.Contract(PERMIT2_ADDRESS, PERMIT2_ABI, provider);
  const [amount, expiration] = await permit2.allowance(owner, token, PERMIT2_ADDRESS);
  const now = Math.floor(Date.now() / 1000);
  if (Number(expiration) > 0 && Number(expiration) < now) return false;
  return BigInt(amount) >= BigInt(neededAmount);
}

export async function approveTokenToPermit2(signer, token) {
  const erc20 = new ethers.Contract(token, ERC20_ABI, signer);
  return await erc20.approve(PERMIT2_ADDRESS, ethers.MaxUint256);
}

export async function signPermitBatch(signer, tokens, spender) {
  const owner = await signer.getAddress();
  const provider = signer.provider;
  const permit2 = new ethers.Contract(PERMIT2_ADDRESS, PERMIT2_ABI, provider);
  const chainId = (await provider.getNetwork()).chainId;
  const details = await Promise.all(tokens.map(async (t) => {
    const [, , nonce] = await permit2.allowance(owner, t.address, PERMIT2_ADDRESS);
    return { token: t.address, amount: MaxAllowanceTransferAmount, expiration: MaxAllowanceExpiration, nonce: Number(nonce) };
  }));
  const sigDeadline = Math.floor(Date.now() / 1000) + 3600;
  const permitBatchData = { details, spender, sigDeadline };
  const { domain, types, values } = AllowanceTransfer.getPermitData(permitBatchData, PERMIT2_ADDRESS, Number(chainId));
  const signature = await signer.signTypedData(domain, types, values);
  return { permitBatchData, signature };
}

export async function ensurePermit2BatchApproval(signer, tokens, opts = {}) {
  if (tokens.length === 0) return { txs: 0, skipped: true };
  const owner = await signer.getAddress();
  const provider = signer.provider;
  const needApproval = [];
  for (const t of tokens) {
    const ok = await isApprovedToPermit2(provider, owner, t.address, t.amount);
    if (!ok) needApproval.push(t);
  }
  if (needApproval.length === 0) return { txs: 0, skipped: true, tokens: tokens.length };
  if (opts.dryRun) return { txs: needApproval.length, dryRun: true, tokens: needApproval.length };
  for (const t of needApproval) {
    const tx = await approveTokenToPermit2(signer, t.address);
    await tx.wait();
  }
  return { txs: needApproval.length, tokens: needApproval.length };
}

export { PERMIT2_ADDRESS };