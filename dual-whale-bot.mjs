// v4
import fetch from "node-fetch";
import { createRequire } from "module";
const require = createRequire(import.meta.url);
const { ethers } = require("ethers");

const BOT_TOKEN   = process.env.BOT_TOKEN;
const ALCHEMY_KEY  = process.env.ALCHEMY_KEY;
const CHAT_IDS    = ["-1003979928587", "-1002857896980"];
const MIN_USD     = 750;
const HEADER_IMG  = "AgACAgQAAxkBAAMLahsaxWL-qj5Rttn21HUd_pXCL9wAAoESaxtYctlQSq9wyE-vZM0BAAMCAAN5AAM7BA";

const DUAL_TOKEN   = "0x6aF487BEb661CCeCD1D045E9561A0dAC9AA5c7db";
const POOL_MANAGER = "0x000000000004444c5dc75cB358380D2e3dE08A90";

// Normalize pool ID — pad to 32 bytes if needed
const RAW_POOL_ID  = "0xe395d0bad31e1f95d4209399efdcc1e221eb369d0be7782fb7704d9a9d5f08c8";
const DUAL_POOL_ID = RAW_POOL_ID.toLowerCase();

const DUAL_DECIMALS = 18;
const WETH_DECIMALS = 18;

let ethPriceUsd = 2000;

const POOL_MANAGER_ABI = [
  "event Swap(bytes32 indexed id, address indexed sender, int128 amount0, int128 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick, uint24 fee)"
];

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
    `[Chart](https://dexscreener.com/ethereum/${RAW_POOL_ID}) · [Buy DUAL](https://app.uniswap.org/swap?outputCurrency=${DUAL_TOKEN})`,
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
  if (!ALCHEMY_KEY)  { console.error("❌ ALCHEMY_KEY not set");  process.exit(1); }

  await getEthPrice();
  setInterval(getEthPrice, 5 * 60 * 1000);

  const provider = new ethers.WebSocketProvider(
    `wss://eth-mainnet.g.alchemy.com/v2/${ALCHEMY_KEY}`
  );

  const poolManager = new ethers.Contract(POOL_MANAGER, POOL_MANAGER_ABI, provider);

  let startBlock = await provider.getBlockNumber();
  console.log(`🦋 DUAL whale bot v4 — listening to Uniswap V4 PoolManager for DUAL buys ≥ $${MIN_USD}`);
  console.log(`Pool ID: ${DUAL_POOL_ID}`);
  console.log(`Starting from block: ${startBlock}`);

  poolManager.on("Swap", async (id, sender, amount0, amount1, sqrtPriceX96, liquidity, tick, fee, event) => {
    try {
      const incomingId = id.toLowerCase();
      
      // Debug: log every swap event so we can see what IDs come through
      console.log(`Swap event — id: ${incomingId.slice(0,18)}... match: ${incomingId === DUAL_POOL_ID}`);

      if (incomingId !== DUAL_POOL_ID) return;

      // WETH is token0, DUAL is token1
      const wethRaw = BigInt(amount0.toString());
      const dualRaw = BigInt(amount1.toString());

      // amount1 < 0 = DUAL leaving pool = BUY
      const isBuy = dualRaw < 0n;
      console.log(`DUAL pool swap — amount0: ${amount0}, amount1: ${amount1}, isBuy: ${isBuy}`);
      if (!isBuy) return;

      const dualAmt    = Number(-dualRaw) / 10 ** DUAL_DECIMALS;
      const wethAmt    = Number(wethRaw)  / 10 ** WETH_DECIMALS;
      const usdValue   = wethAmt * ethPriceUsd;
      const pricePerDual = dualAmt > 0 ? usdValue / dualAmt : 0;

      console.log(`🔔 Buy: ${formatDual(dualAmt)} for ${formatUsd(usdValue)}`);

      if (usdValue < MIN_USD) {
        console.log(`Below threshold ($${usdValue.toFixed(2)} < $${MIN_USD}), skipping`);
        return;
      }

      const txHash = event.log.transactionHash;
      await sendAlert({ usd: usdValue, dualAmt, pricePerDual, sender, txHash });

    } catch (err) {
      console.error("Swap handler error:", err.message, err.stack);
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
