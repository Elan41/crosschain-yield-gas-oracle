import { ethers } from "ethers";

// ── RPC Providers ─────────────────────────────────────────────────────────────
const providers = {
  base: new ethers.JsonRpcProvider(
    process.env.BASE_RPC_URL || "https://mainnet.base.org"
  ),
  ethereum: new ethers.JsonRpcProvider(
    process.env.ETH_RPC_URL || "https://eth.llamarpc.com"
  ),
};

// ── Supported assets ──────────────────────────────────────────────────────────
export const SUPPORTED_ASSETS = ["USDC", "USDT", "ETH", "WBTC", "DAI", "WETH"];
export const SUPPORTED_CHAINS = ["ethereum", "base", "both"];

// ── Pool cache (DeFiLlama — 5 min TTL) ───────────────────────────────────────
let poolCache = null;
let poolCacheTime = 0;
const CACHE_TTL_MS = 5 * 60 * 1000;

// ── Gas cache ─────────────────────────────────────────────────────────────────
const gasCache = { ethereum: null, base: null };
const gasCacheTime = { ethereum: 0, base: 0 };
const GAS_TTL_MS = 60 * 1000;

// ─────────────────────────────────────────────────────────────────────────────
// YIELD AGGREGATOR
// ─────────────────────────────────────────────────────────────────────────────

async function fetchLlamaPools() {
  if (poolCache && Date.now() - poolCacheTime < CACHE_TTL_MS) {
    return poolCache;
  }

  const res = await fetch("https://yields.llama.fi/pools", {
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(12_000),
  });

  if (!res.ok) throw new Error(`DeFiLlama returned HTTP ${res.status}`);

  const data = await res.json();
  poolCache = data.data || [];
  poolCacheTime = Date.now();
  return poolCache;
}

function normaliseChain(chain) {
  const map = { ethereum: "Ethereum", base: "Base" };
  return map[chain] || chain;
}

function normaliseSymbol(symbol) {
  return symbol.toUpperCase();
}

function filterPools(pools, project, chainName, symbol) {
  const llamaChain = normaliseChain(chainName);
  return pools.filter((p) => {
    const symbolMatch =
      p.symbol?.toUpperCase() === normaliseSymbol(symbol) ||
      p.symbol?.toUpperCase().startsWith(normaliseSymbol(symbol));
    return (
      p.project?.toLowerCase().includes(project.toLowerCase()) &&
      p.chain === llamaChain &&
      symbolMatch &&
      p.apy !== null &&
      p.apy !== undefined &&
      !p.ilRisk
    );
  });
}

function pickBestPool(pools) {
  if (!pools.length) return null;
  return pools.sort((a, b) => b.apy - a.apy)[0];
}

function formatPool(pool, protocol, chain) {
  return {
    protocol,
    chain,
    asset: pool.symbol,
    apy: parseFloat(pool.apy.toFixed(4)),
    apyBase: pool.apyBase ? parseFloat(pool.apyBase.toFixed(4)) : null,
    apyReward: pool.apyReward ? parseFloat(pool.apyReward.toFixed(4)) : null,
    tvlUsd: pool.tvlUsd ? Math.round(pool.tvlUsd) : null,
    poolId: pool.pool,
    updatedAt: new Date().toISOString(),
  };
}

export async function getYieldRates(asset, chain) {
  const fetchedAt = new Date().toISOString();
  const symbol = asset.toUpperCase();
  const chains = chain === "both" ? ["ethereum", "base"] : [chain];
  const protocols = ["aave-v3", "compound-v3", "morpho"];

  const pools = await fetchLlamaPools();

  const results = [];
  const errors = {};

  for (const c of chains) {
    for (const proto of protocols) {
      try {
        const matched = filterPools(pools, proto, c, symbol);
        const best = pickBestPool(matched);
        if (best) results.push(formatPool(best, proto, c));
      } catch (err) {
        errors[`${proto}-${c}`] = err.message;
      }
    }
  }

  results.sort((a, b) => b.apy - a.apy);

  const best = results[0] || null;

  return {
    asset: symbol,
    chainsChecked: chains,
    bestOpportunity: best
      ? {
          protocol: best.protocol,
          chain: best.chain,
          apy: best.apy,
          summary: `${best.apy.toFixed(2)}% APY on ${best.protocol} (${best.chain})`,
        }
      : null,
    allRates: results,
    ...(Object.keys(errors).length && { errors }),
    fetchedAt,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// GAS FORECASTER
// ─────────────────────────────────────────────────────────────────────────────

async function fetchGasForChain(chainName) {
  if (gasCache[chainName] && Date.now() - gasCacheTime[chainName] < GAS_TTL_MS) {
    return gasCache[chainName];
  }

  const provider = providers[chainName];

  const feeData = await provider.getFeeData();
  const block = await provider.getBlock("latest");
  const baseFee = block.baseFeePerGas;

  if (!baseFee) throw new Error(`No base fee available for ${chainName}`);

  const baseFeeGwei = parseFloat(ethers.formatUnits(baseFee, "gwei"));

  const prioritySlow     = baseFeeGwei * 0.10;
  const priorityStandard = baseFeeGwei * 0.25;
  const priorityFast     = baseFeeGwei * 0.60;
  const priorityInstant  = baseFeeGwei * 1.00;

  const GAS_UNITS = { ethTransfer: 21_000, erc20Transfer: 65_000, defiSwap: 150_000 };

  function estimateCostUsd(totalGwei, gasUnits, ethPriceUsd) {
    const costEth = (totalGwei * 1e-9) * gasUnits;
    return parseFloat((costEth * ethPriceUsd).toFixed(4));
  }

  let ethPriceUsd = 2500;
  try {
    const priceRes = await fetch(
      "https://api.coingecko.com/api/v3/simple/price?ids=ethereum&vs_currencies=usd",
      { signal: AbortSignal.timeout(5_000) }
    );
    if (priceRes.ok) {
      const priceData = await priceRes.json();
      ethPriceUsd = priceData.ethereum?.usd || ethPriceUsd;
    }
  } catch { /* use fallback */ }

  const result = {
    chain: chainName,
    baseFeeGwei: parseFloat(baseFeeGwei.toFixed(4)),
    tiers: {
      slow: {
        totalGwei: parseFloat((baseFeeGwei + prioritySlow).toFixed(4)),
        estimatedWaitBlocks: 10,
        estimatedWaitSeconds: chainName === "base" ? 20 : 120,
        estimatedCostUsd: {
          ethTransfer:   estimateCostUsd(baseFeeGwei + prioritySlow, GAS_UNITS.ethTransfer, ethPriceUsd),
          erc20Transfer: estimateCostUsd(baseFeeGwei + prioritySlow, GAS_UNITS.erc20Transfer, ethPriceUsd),
          defiSwap:      estimateCostUsd(baseFeeGwei + prioritySlow, GAS_UNITS.defiSwap, ethPriceUsd),
        },
      },
      standard: {
        totalGwei: parseFloat((baseFeeGwei + priorityStandard).toFixed(4)),
        estimatedWaitBlocks: 3,
        estimatedWaitSeconds: chainName === "base" ? 6 : 36,
        estimatedCostUsd: {
          ethTransfer:   estimateCostUsd(baseFeeGwei + priorityStandard, GAS_UNITS.ethTransfer, ethPriceUsd),
          erc20Transfer: estimateCostUsd(baseFeeGwei + priorityStandard, GAS_UNITS.erc20Transfer, ethPriceUsd),
          defiSwap:      estimateCostUsd(baseFeeGwei + priorityStandard, GAS_UNITS.defiSwap, ethPriceUsd),
        },
      },
      fast: {
        totalGwei: parseFloat((baseFeeGwei + priorityFast).toFixed(4)),
        estimatedWaitBlocks: 1,
        estimatedWaitSeconds: chainName === "base" ? 2 : 12,
        estimatedCostUsd: {
          ethTransfer:   estimateCostUsd(baseFeeGwei + priorityFast, GAS_UNITS.ethTransfer, ethPriceUsd),
          erc20Transfer: estimateCostUsd(baseFeeGwei + priorityFast, GAS_UNITS.erc20Transfer, ethPriceUsd),
          defiSwap:      estimateCostUsd(baseFeeGwei + priorityFast, GAS_UNITS.defiSwap, ethPriceUsd),
        },
      },
      instant: {
        totalGwei: parseFloat((baseFeeGwei * 2 + priorityInstant).toFixed(4)),
        estimatedWaitBlocks: 0,
        estimatedWaitSeconds: chainName === "base" ? 2 : 12,
        estimatedCostUsd: {
          ethTransfer:   estimateCostUsd(baseFeeGwei * 2 + priorityInstant, GAS_UNITS.ethTransfer, ethPriceUsd),
          erc20Transfer: estimateCostUsd(baseFeeGwei * 2 + priorityInstant, GAS_UNITS.erc20Transfer, ethPriceUsd),
          defiSwap:      estimateCostUsd(baseFeeGwei * 2 + priorityInstant, GAS_UNITS.defiSwap, ethPriceUsd),
        },
      },
    },
    recommendation: baseFeeGwei < 5 ? "CHEAP — good time to transact" :
                    baseFeeGwei < 20 ? "MODERATE — standard conditions" :
                    baseFeeGwei < 60 ? "EXPENSIVE — consider waiting" :
                    "VERY EXPENSIVE — wait if possible",
    ethPriceUsd,
    fetchedAt: new Date().toISOString(),
  };

  gasCache[chainName] = result;
  gasCacheTime[chainName] = Date.now();
  return result;
}

export async function getGasForecast(chain) {
  const chains = chain === "both" ? ["ethereum", "base"] : [chain];

  const results = await Promise.allSettled(
    chains.map((c) => fetchGasForChain(c))
  );

  const data = {};
  const errors = {};

  results.forEach((r, i) => {
    const c = chains[i];
    if (r.status === "fulfilled") data[c] = r.value;
    else errors[c] = r.reason?.message || "Unknown error";
  });

  let crossChainTip = null;
  if (data.ethereum && data.base) {
    const ethBase = data.ethereum.baseFeeGwei;
    const baseBase = data.base.baseFeeGwei;
    crossChainTip = baseBase < ethBase
      ? `Base is ${((1 - baseBase / ethBase) * 100).toFixed(0)}% cheaper than Ethereum right now`
      : `Ethereum and Base gas fees are comparable right now`;
  }

  return {
    chainsChecked: chains,
    ...(crossChainTip && { crossChainTip }),
    ...(data.ethereum && { ethereum: data.ethereum }),
    ...(data.base && { base: data.base }),
    ...(Object.keys(errors).length && { errors }),
  };
}
