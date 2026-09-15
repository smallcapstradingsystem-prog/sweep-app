import { ethers } from 'ethers';
import { getRpcUrl, discoverTokens } from './rpc.js';

const USDC_ADDRESSES = {
  ethereum: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
  arbitrum: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831',
  optimism: '0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85',
  base:     '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
  polygon:  '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359',
};

// Extra tokens hardcoded until the RPC proxy is deployed.
// Each entry: { address, symbol, decimals }
const EXTRA_TOKENS = {
  ethereum: [
    { address: '0xdAC17F958D2ee523a2206206994597C13D831ec7', symbol: 'USDT', decimals: 6 },
    { address: '0x6B175474E89094C44Da98b954EedeAC495271d0F', symbol: 'DAI',  decimals: 18 },
  ],
  arbitrum: [
    { address: '0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9', symbol: 'USDT', decimals: 6 },
  ],
  optimism: [
    { address: '0x94b008aA00579c1307B0EF2c499aD98a8ce58e58', symbol: 'USDT', decimals: 6 },
  ],
  polygon: [
    { address: '0xc2132D05D31c914a87C6611C10748AEb04B58e8F', symbol: 'USDT', decimals: 6 },
  ],
  base: [
    // Base has no canonical USDT — leave empty
  ],
};

const CHAINS = {
  ethereum: { name: 'Ethereum', chainId: 1, weth: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2', router: '0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45', quoter: '0x61fFE014bA17989E743c5F6cB21bF9697530B21e', feeTiers: [500, 3000, 10000] },
  arbitrum: { name: 'Arbitrum', chainId: 42161, weth: '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1', router: '0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45', quoter: '0x61fFE014bA17989E743c5F6cB21bF9697530B21e', feeTiers: [100, 500, 3000] },
  optimism: { name: 'Optimism', chainId: 10, weth: '0x4200000000000000000000000000000000000006', router: '0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45', quoter: '0x61fFE014bA17989E743c5F6cB21bF9697530B21e', feeTiers: [100, 500, 3000] },
  base: { name: 'Base', chainId: 8453, weth: '0x4200000000000000000000000000000000000006', router: '0x2626664c2603336E57B271c5C0b26F421741e481', quoter: '0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a', feeTiers: [100, 500, 3000] },
  polygon: { name: 'Polygon', chainId: 137, weth: '0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270', router: '0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45', quoter: '0x61fFE014bA17989E743c5F6cB21bF9697530B21e', feeTiers: [100, 500, 3000] },
};

const ERC20_ABI = [
  'function balanceOf(address) view returns (uint256)',
  'function decimals() view returns (uint8)',
  'function symbol() view returns (string)',
  'function approve(address, uint256) returns (bool)',
  'function allowance(address, address) view returns (uint256)',
  'function transfer(address, uint256) returns (bool)',
];
const WETH_ABI = [...ERC20_ABI, 'function deposit() payable'];
const QUOTER_ABI = ['function quoteExactInputSingle((address,address,uint256,uint24,uint160)) returns (uint256,uint160,uint32,uint256)'];
const ROUTER_ABI = ['function exactInputSingle((address,address,uint24,address,uint256,uint256,uint160)) payable returns (uint256)'];

const providerCache = {};

export function getProvider(chain) {
  if (!providerCache[chain]) {
    providerCache[chain] = new ethers.JsonRpcProvider(getRpcUrl(chain));
  }
  return providerCache[chain];
}

export async function previewWallet(chain, walletAddress) {
  const cfg = CHAINS[chain];
  if (!cfg) throw new Error(`Unknown chain: ${chain}`);
  const provider = getProvider(chain);
  const usdc = USDC_ADDRESSES[chain];
  const result = { chain, chainName: cfg.name, address: walletAddress, native: null, tokens: [], gasPrice: null, error: null };

  try {
    const feeData = await provider.getFeeData();
    result.gasPrice = feeData.gasPrice?.toString() ?? '0';
  } catch (e) { result.error = `fee data: ${e.message}`; }

  try {
    const bal = await provider.getBalance(walletAddress);
    if (bal > 0n) {
      result.native = {
        symbol: chain === 'polygon' ? 'POL' : 'ETH',
        raw: bal.toString(),
        formatted: ethers.formatEther(bal),
      };
    }
  } catch (e) { result.error = (result.error ? result.error + '; ' : '') + `native: ${e.message}`; }

  // USDC balance
  try {
    const token = new ethers.Contract(usdc, ERC20_ABI, provider);
    const bal = await token.balanceOf(walletAddress);
    if (bal > 0n) {
      result.tokens.push({ address: usdc, symbol: 'USDC', decimals: 6, raw: bal.toString(), formatted: ethers.formatUnits(bal, 6), isUsdc: true });
    }
  } catch (e) {}

  // Hardcoded extra tokens (USDT, DAI) — bypasses the proxy requirement
  const extras = EXTRA_TOKENS[chain] || [];
  for (const extra of extras) {
    try {
      const token = new ethers.Contract(extra.address, ERC20_ABI, provider);
      const bal = await token.balanceOf(walletAddress);
      if (bal > 0n) {
        result.tokens.push({
          address: extra.address,
          symbol: extra.symbol,
          decimals: extra.decimals,
          raw: bal.toString(),
          formatted: ethers.formatUnits(bal, extra.decimals),
          isUsdc: false,
        });
      }
    } catch (e) {}
  }

  // Auto-discovery via proxy (returns empty array if proxy not configured)
  try {
    const discovered = await discoverTokens(chain, walletAddress);
    for (const t of discovered) {
      if (t.contractAddress.toLowerCase() === usdc.toLowerCase()) continue;
      if (extras.some((x) => x.address.toLowerCase() === t.contractAddress.toLowerCase())) continue;
      result.tokens.push({
        address: t.contractAddress,
        symbol: t.symbol || '???',
        decimals: t.decimals ?? 18,
        raw: t.balance,
        formatted: ethers.formatUnits(BigInt(t.balance), t.decimals ?? 18),
        logo: t.logo,
        isUsdc: false,
      });
    }
  } catch (e) {}

  return result;
}

async function findBestQuote(quoter, tokenIn, tokenOut, amountIn, feeTiers) {
  let best = null;
  for (const fee of feeTiers) {
    try {
      const q = await quoter.quoteExactInputSingle.staticCall({ tokenIn, tokenOut, amountIn, fee, sqrtPriceLimitX96: 0 });
      const out = q[0] ?? q.amountOut;
      if (!best || out > best.out) best = { fee, out };
    } catch (e) {}
  }
  return best;
}

async function ensureApproval(tokenContract, owner, spender, amount, signer) {
  const allowance = await tokenContract.allowance(owner, spender);
  if (allowance >= amount) return null;
  return await tokenContract.connect(signer).approve(spender, amount);
}

export async function sweepEvm(chain, signerOrWallet, destination, opts = {}) {
  const cfg = CHAINS[chain];
  if (!cfg) throw new Error(`Unknown chain: ${chain}`);
  const provider = getProvider(chain);
  const signer = signerOrWallet.connect ? (signerOrWallet.provider ? signerOrWallet : signerOrWallet.connect(provider)) : signerOrWallet;
  const address = await signer.getAddress();
  const usdc = USDC_ADDRESSES[chain];
  const dryRun = !!opts.dryRun;
  const slippageBps = BigInt(opts.slippageBps ?? 100);
  const results = { chain, address, swaps: [], transfers: [], errors: [] };

  // USDC transfer
  try {
    const usdcContract = new ethers.Contract(usdc, ERC20_ABI, signer);
    const bal = await usdcContract.balanceOf(address);
    if (bal > 0n) {
      if (dryRun) {
        results.transfers.push({ symbol: 'USDC', amount: ethers.formatUnits(bal, 6), status: 'DRY_RUN' });
      } else {
        const tx = await usdcContract.transfer(destination, bal);
        const receipt = await tx.wait();
        results.transfers.push({ symbol: 'USDC', amount: ethers.formatUnits(bal, 6), txHash: tx.hash, status: receipt.status === 1 ? 'SUCCESS' : 'FAILED' });
      }
    }
  } catch (e) { results.errors.push(`USDC transfer: ${e.message}`); }

  // ERC-20 tokens (includes hardcoded USDT/DAI + discovered tokens)
  if (opts.tokens && opts.tokens.length > 0) {
    const quoter = new ethers.Contract(cfg.quoter, QUOTER_ABI, provider);
    const router = new ethers.Contract(cfg.router, ROUTER_ABI, signer);
    for (const token of opts.tokens) {
      if (token.address.toLowerCase() === usdc.toLowerCase()) continue;
      try {
        const tokenContract = new ethers.Contract(token.address, ERC20_ABI, signer);
        const bal = await tokenContract.balanceOf(address);
        if (bal === 0n) continue;
        const best = await findBestQuote(quoter, token.address, usdc, bal, cfg.feeTiers);
        if (!best) { results.swaps.push({ symbol: token.symbol, status: 'NO_ROUTE' }); continue; }
        const minOut = best.out - (best.out * slippageBps) / 10000n;
        if (dryRun) {
          results.swaps.push({ symbol: token.symbol, amountIn: ethers.formatUnits(bal, token.decimals), amountOutExpected: ethers.formatUnits(best.out, 6), amountOutMinimum: ethers.formatUnits(minOut, 6), feeTier: best.fee, status: 'DRY_RUN' });
          continue;
        }
        const approveTx = await ensureApproval(tokenContract, address, cfg.router, bal, signer);
        if (approveTx) await approveTx.wait();
        const tx = await router.exactInputSingle({ tokenIn: token.address, tokenOut: usdc, fee: best.fee, recipient: destination, amountIn: bal, amountOutMinimum: minOut, sqrtPriceLimitX96: 0 });
        const receipt = await tx.wait();
        results.swaps.push({ symbol: token.symbol, txHash: tx.hash, status: receipt.status === 1 ? 'SUCCESS' : 'FAILED' });
      } catch (e) { results.swaps.push({ symbol: token.symbol, status: 'ERROR', error: e.message }); }
    }
  }

  // Native token
  try {
    const nativeBal = await provider.getBalance(address);
    const feeData = await provider.getFeeData();
    const gasPrice = feeData.gasPrice ?? 0n;
    const reserve = gasPrice * 300000n;
    const minSwap = ethers.parseEther('0.0001');
    if (nativeBal > reserve + minSwap) {
      const wrapAmount = nativeBal - reserve;
      const quoter = new ethers.Contract(cfg.quoter, QUOTER_ABI, provider);
      const best = await findBestQuote(quoter, cfg.weth, usdc, wrapAmount, cfg.feeTiers);
      if (!best) {
        results.swaps.push({ symbol: 'WETH', status: 'NO_ROUTE' });
      } else if (dryRun) {
        results.swaps.push({ symbol: cfg.name === 'Polygon' ? 'WPOL' : 'WETH', amountIn: ethers.formatEther(wrapAmount), amountOutExpected: ethers.formatUnits(best.out, 6), feeTier: best.fee, status: 'DRY_RUN' });
      } else {
        const weth = new ethers.Contract(cfg.weth, WETH_ABI, signer);
        const wrapTx = await weth.deposit({ value: wrapAmount });
        await wrapTx.wait();
        const approveTx = await ensureApproval(weth, address, cfg.router, wrapAmount, signer);
        if (approveTx) await approveTx.wait();
        const minOut = best.out - (best.out * slippageBps) / 10000n;
        const router = new ethers.Contract(cfg.router, ROUTER_ABI, signer);
        const tx = await router.exactInputSingle({ tokenIn: cfg.weth, tokenOut: usdc, fee: best.fee, recipient: destination, amountIn: wrapAmount, amountOutMinimum: minOut, sqrtPriceLimitX96: 0 });
        const receipt = await tx.wait();
        results.swaps.push({ symbol: cfg.name === 'Polygon' ? 'WPOL' : 'WETH', txHash: tx.hash, status: receipt.status === 1 ? 'SUCCESS' : 'FAILED' });
      }
    }
  } catch (e) { results.errors.push(`native: ${e.message}`); }

  return results;
}

export { CHAINS, USDC_ADDRESSES, ERC20_ABI };