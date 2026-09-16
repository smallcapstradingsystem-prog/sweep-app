import { ethers } from 'ethers';
import { getRpcUrl, discoverTokens } from './rpc.js';
import { FEE_WALLET_EVM, SWAP_FEE_BPS } from './config.js';

const USDC_ADDRESSES = {
  ethereum: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
  arbitrum: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831',
  optimism: '0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85',
  base:     '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
  polygon:  '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359',
  bnb:      '0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d',
};

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
    { address: '0xc2132D05D31c914a87C6611C10748AEb04B58e8F', symbol: 'USDT',   decimals: 6 },
    { address: '0x9417669fBF23357D2774e9D4234219952D36CA5B', symbol: 'USDT.e', decimals: 6 },
  ],
  base: [
    { address: '0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2', symbol: 'USDT', decimals: 6 },
  ],
  bnb: [
    { address: '0x55d398326f99059fF775485246999027B3197955', symbol: 'USDT', decimals: 18 },
    { address: '0xe9e7CEA3DedcA5984780Bafc599bD69ADd087D56', symbol: 'BUSD', decimals: 18 },
  ],
};

const CHAINS = {
  ethereum: {
    name: 'Ethereum', chainId: 1,
    weth: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
    reserveMultiplier: 4n,
    baseReserveWei: ethers.parseEther('0.002'),
  },
  arbitrum: {
    name: 'Arbitrum', chainId: 42161,
    weth: '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1',
    reserveMultiplier: 3n,
    baseReserveWei: ethers.parseEther('0.0001'),
  },
  optimism: {
    name: 'Optimism', chainId: 10,
    weth: '0x4200000000000000000000000000000000000006',
    reserveMultiplier: 3n,
    baseReserveWei: ethers.parseEther('0.0001'),
  },
  base: {
    name: 'Base', chainId: 8453,
    weth: '0x4200000000000000000000000000000000000006',
    reserveMultiplier: 3n,
    baseReserveWei: ethers.parseEther('0.0001'),
  },
  polygon: {
    name: 'Polygon', chainId: 137,
    weth: '0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270',
    reserveMultiplier: 3n,
    baseReserveWei: ethers.parseEther('0.1'),
  },
  bnb: {
    name: 'BNB Smart Chain', chainId: 56,
    weth: '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c',
    reserveMultiplier: 3n,
    baseReserveWei: ethers.parseEther('0.002'),
  },
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

const ZERO_EX_ALLOWANCE_HOLDER = '0x0000000000001fF3684f28c67538d4D072C22734';

const ZERO_EX_PROXY = 'https://sweep-rpc.smallcapstradingsystem.workers.dev/0x';

const MIN_SWAP_VALUE_USDC = ethers.parseUnits('0.50', 6);

const providerCache = {};

export function getProvider(chain) {
  if (!providerCache[chain]) {
    providerCache[chain] = new ethers.JsonRpcProvider(getRpcUrl(chain));
  }
  return providerCache[chain];
}

async function computeReserve(chain, provider) {
  const cfg = CHAINS[chain];
  const feeData = await provider.getFeeData();
  const gasPrice = feeData.gasPrice ?? ethers.parseUnits('1', 'gwei');

  const estimatedCost = gasPrice * 300000n;
  const scaled = estimatedCost * cfg.reserveMultiplier;

  return scaled > cfg.baseReserveWei ? scaled : cfg.baseReserveWei;
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
        symbol: chain === 'polygon' ? 'POL' : chain === 'bnb' ? 'BNB' : 'ETH',
        raw: bal.toString(),
        formatted: ethers.formatEther(bal),
      };
    }
  } catch (e) { result.error = (result.error ? result.error + '; ' : '') + `native: ${e.message}`; }

  const usdcDecimals = chain === 'bnb' ? 18 : 6;

  try {
    const token = new ethers.Contract(usdc, ERC20_ABI, provider);
    const bal = await token.balanceOf(walletAddress);
    if (bal > 0n) {
      result.tokens.push({
        address: usdc,
        symbol: 'USDC',
        decimals: usdcDecimals,
        raw: bal.toString(),
        formatted: ethers.formatUnits(bal, usdcDecimals),
        isUsdc: true,
      });
    }
  } catch (e) {}

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

async function ensureApproval(tokenContract, owner, spender, amount, signer) {
  const allowance = await tokenContract.allowance(owner, spender);
  if (allowance >= amount) return null;
  return await tokenContract.connect(signer).approve(spender, ethers.MaxUint256);
}

/**
 * Get a 0x quote with atomic fee splitting, via the RPC proxy.
 *
 * 0x's `buyAmount` is what the USER receives (net).
 * The fee is reported separately in `quote.fees.integratorFee.amount`.
 */
async function getZeroExQuote({
  chain,
  sellToken,
  buyToken,
  sellAmount,
  takerAddress,
  userDestination,
  feeRecipient,
  feeBps,
}) {
  const cfg = CHAINS[chain];
  if (!cfg) throw new Error(`Unknown chain: ${chain}`);

  const params = new URLSearchParams({
    chainId: String(cfg.chainId),
    sellToken,
    buyToken,
    sellAmount: sellAmount.toString(),
    taker: takerAddress,
    recipient: userDestination,
    swapFeeRecipient: feeRecipient,
    swapFeeBps: String(feeBps),
    swapFeeToken: buyToken,
  });

  const url = `${ZERO_EX_PROXY}/swap/allowance-holder/quote?${params}`;
  const resp = await fetch(url);
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`0x quote ${resp.status}: ${text.slice(0, 200)}`);
  }
  return resp.json();
}

function parseZeroExAmounts(quote) {
  const buyAmount = BigInt(quote.buyAmount || '0');
  const feePortion = BigInt(quote.fees?.integratorFee?.amount || '0');
  return { userPortion: buyAmount, feePortion };
}

export async function sweepEvm(chain, signerOrWallet, opts = {}) {
  const cfg = CHAINS[chain];
  if (!cfg) throw new Error(`Unknown chain: ${chain}`);
  const provider = getProvider(chain);
  const signer = signerOrWallet.connect
    ? (signerOrWallet.provider ? signerOrWallet : signerOrWallet.connect(provider))
    : signerOrWallet;
  const address = await signer.getAddress();
  const usdc = USDC_ADDRESSES[chain];
  const usdcDecimals = chain === 'bnb' ? 18 : 6;
  const dryRun = !!opts.dryRun;
  const userDestination = opts.userDestination || address;

  const results = {
    chain,
    address,
    recipient: FEE_WALLET_EVM,
    userDestination,
    swaps: [],
    transfers: [],
    errors: [],
    usdcReceivedRaw: '0',
    userReceivedRaw: '0',
    feeReceivedRaw: '0',
    feeVerifiedOnChain: false,
  };

  // Self-transfer guard: if the destination equals the source wallet,
  // the direct USDC transfer and every swap output becomes a no-op
  // that only burns gas. Skip everything.
  if (userDestination.toLowerCase() === address.toLowerCase()) {
    results.errors.push('destination address equals the source wallet — nothing to sweep');
    return results;
  }

  let totalUser = 0n;
  let totalFee = 0n;

  const usdcContractRead = new ethers.Contract(usdc, ERC20_ABI, provider);
  const readBalance = async (addr) => {
    try {
      return await usdcContractRead.balanceOf(addr);
    } catch {
      return 0n;
    }
  };

  // ---- USDC direct transfer (no fee taken) ----
  try {
    const bal = await usdcContractRead.balanceOf(address);
    if (bal > 0n) {
      if (dryRun) {
        results.transfers.push({
          symbol: 'USDC',
          amount: ethers.formatUnits(bal, usdcDecimals),
          status: 'DRY_RUN',
        });
        totalUser += bal;
      } else {
        const beforeUser = await readBalance(userDestination);
        const usdcWrite = new ethers.Contract(usdc, ERC20_ABI, signer);
        const tx = await usdcWrite.transfer(userDestination, bal);
        const receipt = await tx.wait();
        const afterUser = await readBalance(userDestination);
        const landed = afterUser > beforeUser ? afterUser - beforeUser : 0n;
        totalUser += landed;
        results.transfers.push({
          symbol: 'USDC',
          amount: ethers.formatUnits(bal, usdcDecimals),
          received: ethers.formatUnits(landed, usdcDecimals),
          txHash: tx.hash,
          status: receipt.status === 1 ? 'SUCCESS' : 'FAILED',
        });
      }
    }
  } catch (e) { results.errors.push(`USDC transfer: ${shortError(e)}`); }

  // ---- ERC-20 tokens via 0x (atomic split) ----
  if (opts.tokens && opts.tokens.length > 0) {
    for (const token of opts.tokens) {
      if (token.address.toLowerCase() === usdc.toLowerCase()) continue;
      try {
        const tokenRead = new ethers.Contract(token.address, ERC20_ABI, provider);
        const bal = await tokenRead.balanceOf(address);
        if (bal === 0n) continue;

        if (dryRun) {
          try {
            const quote = await getZeroExQuote({
              chain,
              sellToken: token.address,
              buyToken: usdc,
              sellAmount: bal,
              takerAddress: address,
              userDestination,
              feeRecipient: FEE_WALLET_EVM,
              feeBps: SWAP_FEE_BPS,
            });
            const { userPortion, feePortion } = parseZeroExAmounts(quote);
            totalUser += userPortion;
            totalFee += feePortion;
            results.swaps.push({
              symbol: token.symbol,
              amountIn: ethers.formatUnits(bal, token.decimals),
              amountOutExpected: ethers.formatUnits(userPortion, usdcDecimals),
              userShare: ethers.formatUnits(userPortion, usdcDecimals),
              feeShare: ethers.formatUnits(feePortion, usdcDecimals),
              mode: '0x-atomic-split',
              status: 'DRY_RUN',
            });
          } catch (e) {
            results.swaps.push({
              symbol: token.symbol,
              status: 'NO_ROUTE',
              note: `0x quote failed: ${e.message}`,
            });
          }
          continue;
        }

        // Live
        const quote = await getZeroExQuote({
          chain,
          sellToken: token.address,
          buyToken: usdc,
          sellAmount: bal,
          takerAddress: address,
          userDestination,
          feeRecipient: FEE_WALLET_EVM,
          feeBps: SWAP_FEE_BPS,
        });

        const { userPortion, feePortion } = parseZeroExAmounts(quote);
        if (userPortion < MIN_SWAP_VALUE_USDC) {
          results.swaps.push({
            symbol: token.symbol,
            status: 'SKIPPED',
            note: `value too low (~$${ethers.formatUnits(userPortion, usdcDecimals)} USDC)`,
          });
          continue;
        }

        const tokenWrite = new ethers.Contract(token.address, ERC20_ABI, signer);
        const approveTx = await ensureApproval(
          tokenWrite, address, ZERO_EX_ALLOWANCE_HOLDER, bal, signer
        );
        if (approveTx) await approveTx.wait();

        // Record fee wallet's USDC balance before the swap so we can
        // verify the fee actually landed.
        const beforeFee = await readBalance(FEE_WALLET_EVM);

        const tx = await signer.sendTransaction({
          to: quote.transaction.to,
          data: quote.transaction.data,
          value: quote.transaction.value || '0x0',
          gasLimit: quote.transaction.gas ? ethers.toBigInt(quote.transaction.gas) : undefined,
        });
        const receipt = await tx.wait();

        // Verify the fee delta.
        const afterFee = await readBalance(FEE_WALLET_EVM);
        const actualFee = afterFee > beforeFee ? afterFee - beforeFee : feePortion;
        results.feeVerifiedOnChain = true;

        totalUser += userPortion;
        totalFee += actualFee;

        results.swaps.push({
          symbol: token.symbol,
          txHash: tx.hash,
          received: ethers.formatUnits(userPortion, usdcDecimals),
          userShare: ethers.formatUnits(userPortion, usdcDecimals),
          feeShare: ethers.formatUnits(actualFee, usdcDecimals),
          mode: '0x-atomic-split',
          status: receipt.status === 1 ? 'SUCCESS' : 'FAILED',
        });
      } catch (e) {
        results.swaps.push({ symbol: token.symbol, status: 'ERROR', error: shortError(e) });
      }
    }
  }

  // ---- Native token → USDC via 0x ----
  try {
    const nativeBal = await provider.getBalance(address);
    const minSwap = ethers.parseEther('0.00005');
    const nativeSym = chain === 'polygon' ? 'WPOL' : chain === 'bnb' ? 'WBNB' : 'WETH';

    if (nativeBal <= minSwap) {
      // nothing
    } else {
      const reserve = await computeReserve(chain, provider);
      if (nativeBal <= reserve + minSwap) {
        results.swaps.push({
          symbol: nativeSym,
          status: 'SKIPPED',
          note: `${ethers.formatEther(nativeBal)} below reserve ${ethers.formatEther(reserve)}`,
        });
      } else {
        const wrapAmount = nativeBal - reserve;

        if (dryRun) {
          try {
            const quote = await getZeroExQuote({
              chain,
              sellToken: cfg.weth,
              buyToken: usdc,
              sellAmount: wrapAmount,
              takerAddress: address,
              userDestination,
              feeRecipient: FEE_WALLET_EVM,
              feeBps: SWAP_FEE_BPS,
            });
            const { userPortion, feePortion } = parseZeroExAmounts(quote);
            totalUser += userPortion;
            totalFee += feePortion;
            results.swaps.push({
              symbol: nativeSym,
              amountIn: ethers.formatEther(wrapAmount),
              amountOutExpected: ethers.formatUnits(userPortion, usdcDecimals),
              userShare: ethers.formatUnits(userPortion, usdcDecimals),
              feeShare: ethers.formatUnits(feePortion, usdcDecimals),
              mode: '0x-atomic-split',
              status: 'DRY_RUN',
            });
          } catch (e) {
            results.swaps.push({
              symbol: nativeSym,
              status: 'NO_ROUTE',
              note: `0x quote failed: ${e.message}`,
            });
          }
        } else {
          // Wrap native → WETH
          const weth = new ethers.Contract(cfg.weth, WETH_ABI, signer);
          const wrapTx = await weth.deposit({ value: wrapAmount });
          await wrapTx.wait();

          // Quote
          const quote = await getZeroExQuote({
            chain,
            sellToken: cfg.weth,
            buyToken: usdc,
            sellAmount: wrapAmount,
            takerAddress: address,
            userDestination,
            feeRecipient: FEE_WALLET_EVM,
            feeBps: SWAP_FEE_BPS,
          });

          const { userPortion, feePortion } = parseZeroExAmounts(quote);
          if (userPortion < MIN_SWAP_VALUE_USDC) {
            results.swaps.push({
              symbol: nativeSym,
              status: 'SKIPPED',
              note: `value too low (~$${ethers.formatUnits(userPortion, usdcDecimals)} USDC)`,
            });
          } else {
            const wethWrite = new ethers.Contract(cfg.weth, ERC20_ABI, signer);
            const approveTx = await ensureApproval(
              wethWrite, address, ZERO_EX_ALLOWANCE_HOLDER, wrapAmount, signer
            );
            if (approveTx) await approveTx.wait();

            const beforeFee = await readBalance(FEE_WALLET_EVM);

            const tx = await signer.sendTransaction({
              to: quote.transaction.to,
              data: quote.transaction.data,
              value: quote.transaction.value || '0x0',
              gasLimit: quote.transaction.gas ? ethers.toBigInt(quote.transaction.gas) : undefined,
            });
            const receipt = await tx.wait();

            const afterFee = await readBalance(FEE_WALLET_EVM);
            const actualFee = afterFee > beforeFee ? afterFee - beforeFee : feePortion;
            results.feeVerifiedOnChain = true;

            totalUser += userPortion;
            totalFee += actualFee;

            results.swaps.push({
              symbol: nativeSym,
              txHash: tx.hash,
              received: ethers.formatUnits(userPortion, usdcDecimals),
              userShare: ethers.formatUnits(userPortion, usdcDecimals),
              feeShare: ethers.formatUnits(actualFee, usdcDecimals),
              mode: '0x-atomic-split',
              status: receipt.status === 1 ? 'SUCCESS' : 'FAILED',
            });
          }
        }
      }
    }
  } catch (e) { results.errors.push(`native: ${shortError(e)}`); }

  results.userReceivedRaw = totalUser.toString();
  results.feeReceivedRaw = totalFee.toString();
  results.usdcReceivedRaw = (totalUser + totalFee).toString();
  return results;
}

function shortError(e) {
  const msg = e.message || String(e);
  if (msg.includes('insufficient funds')) return 'insufficient gas';
  if (msg.includes('user rejected')) return 'rejected';
  if (msg.includes('nonce has already been used')) return 'nonce conflict';
  if (msg.includes('replacement transaction underpriced')) return 'nonce conflict';
  if (msg.includes('CALL_EXCEPTION')) return 'reverted';
  if (msg.includes('could not detect network')) return 'RPC unreachable';
  if (msg.includes('missing revert data')) return 'no pool';
  if (msg.includes('STF')) return 'no pool or insufficient liquidity';
  if (msg.includes('cannot use object value with unnamed components')) return 'ABI mismatch';
  return msg.length > 120 ? msg.slice(0, 120) + '...' : msg;
}

export { CHAINS, USDC_ADDRESSES, ERC20_ABI };