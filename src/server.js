import express from "express";
import { paymentMiddleware } from "x402-express";
import { getYieldRates, getGasForecast, SUPPORTED_ASSETS, SUPPORTED_CHAINS } from "./oracle.js";

const app = express();
const PORT = process.env.PORT || 3001;

const RECEIVING_WALLET = process.env.RECEIVING_WALLET || "0x1db618e6bfc35bd48b91431a55c4948b27e7a539";
const NETWORK = process.env.NETWORK || "base";

if (!RECEIVING_WALLET) {
  console.error("❌  RECEIVING_WALLET env var is required");
  process.exit(1);
}

app.use(express.json());

// ── Pricing ───────────────────────────────────────────────────────────────────
const PRICING = {
  yield: "$0.10",
  gas:   "$0.05",
};

// ── Health check ──────────────────────────────────────────────────────────────
app.get('/health', (req, res) => res.json({ status: 'ok' }));

// ── Service info ──────────────────────────────────────────────────────────────
app.get("/", (_req, res) => {
  res.json({
    name: "Cross-Chain Yield & Gas Oracle — Node 3",
    description:
      "Two high-demand oracles in one node. " +
      "Yield aggregator pulls live APY from Aave v3, Compound v3, and Morpho " +
      "across Base and Ethereum. Gas forecaster returns optimal fee tiers with " +
      "USD cost estimates for ETH transfers, ERC-20 transfers, and DeFi swaps.",
    endpoints: {
      "GET /assets":           "Supported yield assets. Free.",
      "POST /yield":           `Best APY rates across protocols and chains. ${PRICING.yield} USDC.`,
      "POST /gas":             `Gas fee forecast with 4 speed tiers + USD costs. ${PRICING.gas} USDC.`,
    },
    yieldProtocols: ["Aave v3", "Compound v3", "Morpho"],
    supportedAssets: SUPPORTED_ASSETS,
    supportedChains: SUPPORTED_CHAINS,
    dataSource: "DeFiLlama public yields API (5-min cache), public RPC nodes",
    payment: {
      protocol: "x402",
      network: NETWORK,
      asset: "USDC",
      facilitator: "https://x402.org/facilitator",
    },
  });
});

// ── Free: list supported assets ───────────────────────────────────────────────
app.get("/assets", (_req, res) => {
  res.json({
    assets: SUPPORTED_ASSETS,
    chains: SUPPORTED_CHAINS,
    protocols: ["aave-v3", "compound-v3", "morpho"],
  });
});

// ── Paid: POST /yield ─────────────────────────────────────────────────────────
app.post(
  "/yield",
  paymentMiddleware(
    RECEIVING_WALLET,
    {
      "/yield": {
        price: PRICING.yield,
        network: NETWORK,
        config: {
          description:
            "Cross-chain yield aggregator — best APY across Aave, Compound, Morpho on Base + Ethereum",
        },
      },
    },
    { url: "https://x402.org/facilitator" }
  ),
  async (req, res) => {
    const { asset = "USDC", chain = "both" } = req.body;

    if (!SUPPORTED_ASSETS.includes(asset.toUpperCase())) {
      return res.status(400).json({
        error: `Unsupported asset '${asset}'. Supported: ${SUPPORTED_ASSETS.join(", ")}`,
      });
    }

    if (!SUPPORTED_CHAINS.includes(chain.toLowerCase())) {
      return res.status(400).json({
        error: `Unsupported chain '${chain}'. Supported: ${SUPPORTED_CHAINS.join(", ")}`,
      });
    }

    try {
      const result = await getYieldRates(asset.toUpperCase(), chain.toLowerCase());
      res.json(result);
    } catch (err) {
      console.error(`Yield error [${asset}/${chain}]:`, err.message);
      res.status(502).json({
        error: "Failed to fetch yield data from upstream.",
        detail: err.message,
      });
    }
  }
);

// ── Paid: POST /gas ───────────────────────────────────────────────────────────
app.post(
  "/gas",
  paymentMiddleware(
    RECEIVING_WALLET,
    {
      "/gas": {
        price: PRICING.gas,
        network: NETWORK,
        config: {
          description:
            "Gas fee forecast — 4 speed tiers with USD cost estimates for Base + Ethereum",
        },
      },
    },
    { url: "https://x402.org/facilitator" }
  ),
  async (req, res) => {
    const { chain = "both" } = req.body;

    if (!SUPPORTED_CHAINS.includes(chain.toLowerCase())) {
      return res.status(400).json({
        error: `Unsupported chain '${chain}'. Supported: ${SUPPORTED_CHAINS.join(", ")}`,
      });
    }

    try {
      const result = await getGasForecast(chain.toLowerCase());
      res.json(result);
    } catch (err) {
      console.error(`Gas error [${chain}]:`, err.message);
      res.status(502).json({
        error: "Failed to fetch gas data from RPC.",
        detail: err.message,
      });
    }
  }
);

app.listen(PORT, () => {
  console.log(`\n⛽ Cross-Chain Yield & Gas Oracle running on port ${PORT}`);
  console.log(`   Networks : Base + Ethereum`);
  console.log(`   Wallet   : ${RECEIVING_WALLET}`);
  console.log(`   Yield    : ${PRICING.yield} USDC per /yield call`);
  console.log(`   Gas      : ${PRICING.gas} USDC per /gas call\n`);
});
