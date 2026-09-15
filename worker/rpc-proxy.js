/**
 * rpc-proxy.js — Cloudflare Worker
 * =====================================================================
 * Two responsibilities:
 *   1. /rpc/:chain       — proxy JSON-RPC calls, hide the API key
 *   2. /tokens/:chain/:address — return ERC-20 holdings for a wallet
 *
 * Deploy:
 *   wrangler secret put ALCHEMY_KEY
 *   wrangler secret put HELIUS_KEY
 *   wrangler deploy -c rpc-proxy.toml
 *
 * No logging of payloads. Only: timestamp, IP, route, status.
 */

const RPC_ENDPOINTS = {
  ethereum: (env) => `https://eth-mainnet.g.alchemy.com/v2/${env.ALCHEMY_KEY}`,
  arbitrum: (env) => `https://arb-mainnet.g.alchemy.com/v2/${env.ALCHEMY_KEY}`,
  optimism: (env) => `https://opt-mainnet.g.alchemy.com/v2/${env.ALCHEMY_KEY}`,
  base:     (env) => `https://base-mainnet.g.alchemy.com/v2/${env.ALCHEMY_KEY}`,
  polygon:  (env) => `https://polygon-mainnet.g.alchemy.com/v2/${env.ALCHEMY_KEY}`,
  solana:   (env) => `https://mainnet.helius-rpc.com/?api-key=${env.HELIUS_KEY}`,
};

const ALCHEMY_NETWORKS = {
  ethereum: 'eth-mainnet',
  arbitrum: 'arb-mainnet',
  optimism: 'opt-mainnet',
  base:     'base-mainnet',
  polygon:  'polygon-mainnet',
};

const rateLimitMap = new Map();
const RATE_WINDOW_MS = 60_000;
const RATE_MAX = 120;

function checkRate(ip) {
  const now = Date.now();
  const entry = rateLimitMap.get(ip) || { count: 0, reset: now + RATE_WINDOW_MS };
  if (now > entry.reset) {
    entry.count = 0;
    entry.reset = now + RATE_WINDOW_MS;
  }
  entry.count++;
  rateLimitMap.set(ip, entry);
  return entry.count <= RATE_MAX;
}

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, solana-client, x-client-info, x-sdk-version, authorization',
  'Access-Control-Max-Age': '86400',
};

export default {
  async fetch(request, env) {
    const ip = request.headers.get('cf-connecting-ip') || 'unknown';
    const url = new URL(request.url);
    const { pathname } = url;

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: CORS });
    }

    if (!checkRate(ip)) {
      return jsonResponse({ error: 'rate limited' }, 429);
    }

    try {
      const rpcMatch = pathname.match(/^\/rpc\/(\w+)$/);
      if (rpcMatch) {
        if (request.method !== 'POST') return jsonResponse({ error: 'POST required' }, 405);
        return await handleRpc(rpcMatch[1], request, env, ip);
      }

      const tokensMatch = pathname.match(/^\/tokens\/(\w+)\/(.+)$/);
      if (tokensMatch) {
        if (request.method !== 'GET') return jsonResponse({ error: 'GET required' }, 405);
        return await handleTokens(tokensMatch[1], tokensMatch[2], env, ip);
      }

      return jsonResponse({ error: 'not found' }, 404);
    } catch (err) {
      console.error('worker error', { ip, pathname, message: err.message });
      return jsonResponse({ error: 'internal error' }, 500);
    }
  },
};

async function handleRpc(chain, request, env, ip) {
  const endpointFn = RPC_ENDPOINTS[chain];
  if (!endpointFn) return jsonResponse({ error: `unknown chain: ${chain}` }, 400);

  const body = await request.text();
  const target = endpointFn(env);

  const resp = await fetch(target, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
  });

  console.log(JSON.stringify({
    ts: new Date().toISOString(),
    ip,
    route: 'rpc',
    chain,
    status: resp.status,
  }));

  const text = await resp.text();
  return new Response(text, {
    status: resp.status,
    headers: { 'Content-Type': 'application/json', ...CORS },
  });
}

async function handleTokens(chain, address, env, ip) {
  const network = ALCHEMY_NETWORKS[chain];
  if (!network) {
    return jsonResponse({ error: `token discovery not supported for ${chain}` }, 400);
  }

  if (!/^0x[a-fA-F0-9]{40}$/.test(address)) {
    return jsonResponse({ error: 'invalid address' }, 400);
  }

  const endpoint = `https://${network}.g.alchemy.com/v2/${env.ALCHEMY_KEY}`;

  const balancesResp = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'alchemy_getTokenBalances',
      params: [address, 'erc20'],
    }),
  });

  const balancesJson = await balancesResp.json();
  const rawTokens = balancesJson?.result?.tokenBalances || [];

  const nonZero = rawTokens.filter((t) => {
    if (!t.tokenBalance || t.tokenBalance === '0x') return false;
    try {
      return BigInt(t.tokenBalance) > 0n;
    } catch {
      return false;
    }
  });

  const metadata = [];
  const BATCH = 50;
  for (let i = 0; i < nonZero.length; i += BATCH) {
    const chunk = nonZero.slice(i, i + BATCH);
    const results = await Promise.all(chunk.map(async (t) => {
      try {
        const metaResp = await fetch(endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'alchemy_getTokenMetadata',
            params: [t.contractAddress],
          }),
        });
        const metaJson = await metaResp.json();
        const m = metaJson?.result || {};
        return {
          contractAddress: t.contractAddress,
          balance: t.tokenBalance,
          decimals: m.decimals ?? 18,
          symbol: m.symbol || '???',
          name: m.name || '',
          logo: m.logo || null,
        };
      } catch {
        return null;
      }
    }));
    metadata.push(...results.filter(Boolean));
  }

  console.log(JSON.stringify({
    ts: new Date().toISOString(),
    ip,
    route: 'tokens',
    chain,
    count: metadata.length,
  }));

  return jsonResponse({ tokens: metadata });
}

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS },
  });
}
