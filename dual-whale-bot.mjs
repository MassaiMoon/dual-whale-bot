// v3
import fetch from "node-fetch";
import { createRequire } from "module";
const require = createRequire(import.meta.url);
const { ethers } = require("ethers");

const BOT_TOKEN   = process.env.BOT_TOKEN;
const ALCHEMY_KEY = process.env.ALCHEMY_KEY;
const CHAT_IDS    = ["-1003979928587", "-1002857896980"];
const MIN_USD     = 7;
const HEADER_IMG  = "AgACAgQAAxkBAAMLahsaxWL-qj5Rttn21HUd_pXCL9wAAoESaxtYctlQSq9wyE-vZM0BAAMCAAN5AAM7BA";

const DUAL_TOKEN    = "0x6aF487BEb661CCeCD1D045E9561A0dAC9AA5c7db".toLowerCase();
const WETH_TOKEN    = "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2".toLowerCase();
const POOL_MANAGER  = "0x000000000004444c5dc75cB358380D2e3dE08A90"; // Uniswap V4 PoolManager

// V4 Swap event — emitted by PoolManager
const POOL_MANAGER_ABI = [
  "event Swap(bytes32 indexed id, address indexed sender, int128 amount0, int128 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick, uint24 fee)"
];

// The V4 pool ID for DUAL/WETH
const DUAL_POOL_ID = "0xe395d0bad31e1f95d4209399efdcc1e221eb369d0be7782fb7704d9a9d5f08c8";

const DUAL_DECIMALS = 18;
const WETH_DECIMALS = 18;

let ethPriceUsd = 2000;

function butterflies(usd) {
  const count = Math.max(1, Math.round(usd / 100));
  return "🦋".repeat(Math.min(count, 60));
}

function formatUsd(n) {
  return "$" + Number(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function formatDual(n) {
  return Number(n).toLocaleString("en-US", { maximumFractionDigits: 0 }) + " DUAL";
}

function shortAddr(addr) {
  return addr.slice(0, 6) + "..." + addr.slice(-4);
}

async function getEthPrice() {
  try {
    const res  = await fetch("https://api.coingecko.com/api/v3/simple/price?ids=ethereum&vs_currencies=usd");
    const data = await res.json();
    ethPriceUsd = data?.ethereum?.usd ?? ethPriceUsd;
    console.log(`ETH price updated: $${ethPriceUsd}`);
  } catch (e) {
    console.error("ETH price fetch error:", e.message);
  }
}

async function sendAlert({ usd, dualAmt, pricePerDual, sender, txHash }) {
  const caption = [
    `*DUAL Token Buy! 🟢*`,
    butterflies(usd),
    ``,
    `💲 ${formatUsd(usd)} USDT`,
    `🔷 ${formatDual(dualAmt)}`,
    `💵 Price $${pricePerDual.toFixed(8)}`,
    `👤 [${shortAddr(sender)}](https://etherscan.io/address/${sender})`,
    `🔗 [View TX](https://etherscan.io/tx/${txHash})`,
    ``,
    `[Chart](https://dexscreener.com/ethereum/${DUAL_POOL_ID}) · [Buy DUAL](https://app.uniswap.org/swap?outputCurrency=${DUAL_TOKEN})`,
  ].join("\n");

  for (const chatId of CHAT_IDS) {
    const res  = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendPhoto`, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({ chat_id: chatId, photo: HEADER_IMG, caption, parse_mode: "Markdown", disable_web_page_preview: true }),
    });
    const json = await res.json();
    if (!json.ok) console.error(`Telegram error (${chatId}):`, JSON.stringify(json));
    else console.log(`✅ Sent to ${chatId}: ${formatUsd(usd)} buy`);
  }
}

async function main() {
  if (!BOT_TOKEN)   { console.error("❌ BOT_TOKEN not set");   process.exit(1); }
  if (!ALCHEMY_KEY) { console.error("❌ ALCHEMY_KEY not set"); process.exit(1); }

  await getEthPrice();
  setInterval(getEthPrice, 5 * 60 * 1000);

  const provider = new ethers.WebSocketProvider(
    `wss://eth-mainnet.g.alchemy.com/v2/${ALCHEMY_KEY}`
  );

  const poolManager = new ethers.Contract(POOL_MANAGER, POOL_MANAGER_ABI, provider);

  console.log(`🦋 DUAL whale bot started — listening to Uniswap V4 PoolManager for DUAL buys ≥ $${MIN_USD}`);

  poolManager.on("Swap", async (id, sender, amount0, amount1, sqrtPriceX96, liquidity, tick, fee, event) => {
    try {
      // Only process our pool
      if (id.toLowerCase() !== DUAL_POOL_ID.toLowerCase()) return;

      // In V4 WETH/DUAL pool:
      // amount0 = WETH (token0), amount1 = DUAL (token1)
      // Negative amount = token leaving pool (received by user)
      // amount1 < 0 means DUAL leaving pool = user BUYING DUAL
      const wethRaw = BigInt(amount0.toString());
      const dualRaw = BigInt(amount1.toString());

      const isBuy = dualRaw < 0n;
      if (!isBuy) return;

      const dualAmt    = Number(-dualRaw) / 10 ** DUAL_DECIMALS;
      const wethAmt    = Number(-wethRaw) / 10 ** WETH_DECIMALS;
      const usdValue   = wethAmt * ethPriceUsd;
      const pricePerDual = dualAmt > 0 ? usdValue / dualAmt : 0;

      if (usdValue < MIN_USD) return;

      const txHash = event.log.transactionHash;

      console.log(`🔔 Buy: ${formatDual(dualAmt)} for ${formatUsd(usdValue)} | tx: ${txHash.slice(0,10)}...`);

      await sendAlert({ usd: usdValue, dualAmt, pricePerDual, sender, txHash });

    } catch (err) {
      console.error("Swap handler error:", err.message);
    }
  });

  // Keep WebSocket alive
  setInterval(() => {
    provider.getBlockNumber()
      .then(b => console.log(`Block: ${b}`))
      .catch(e => { console.error("Provider ping failed:", e.message); process.exit(1); });
  }, 30_000);

  provider.on("error", (err) => {
    console.error("Provider error:", err.message);
    process.exit(1);
  });
}

main();

