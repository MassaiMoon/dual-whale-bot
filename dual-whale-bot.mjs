// v2
import fetch from "node-fetch";
import { createRequire } from "module";
const require = createRequire(import.meta.url);
const { ethers } = require("ethers");

const BOT_TOKEN   = process.env.BOT_TOKEN;
const ALCHEMY_KEY = process.env.ALCHEMY_KEY;
const CHAT_IDS    = ["-1003979928587", "-1002857896980"];
const MIN_USD     = 100;
const HEADER_IMG  = "AgACAgQAAxkBAAMLahsaxWL-qj5Rttn21HUd_pXCL9wAAoESaxtYctlQSq9wyE-vZM0BAAMCAAN5AAM7BA";

// DUAL/WETH Uniswap V3 pool on Ethereum (highest liquidity)
const POOL_ADDRESS = "0xe395d0bad31e1f95d4209399efdcc1e221eb369d";
const DUAL_TOKEN   = "0x6aF487BEb661CCeCD1D045E9561A0dAC9AA5c7db";
const WETH_TOKEN   = "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2";

// Uniswap V3 pool ABI — only need Swap event
const POOL_ABI = [
  "event Swap(address indexed sender, address indexed recipient, int256 amount0, int256 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick)"
];

// ERC20 ABI for decimals
const ERC20_ABI = ["function decimals() view returns (uint8)"];

let dualDecimals = 18;
let wethDecimals = 18;
let ethPriceUsd  = 0;

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

async function sendAlert({ usd, dualAmt, pricePerDual, maker, txHash }) {
  const caption = [
    `*DUAL Token Buy! 🟢*`,
    butterflies(usd),
    ``,
    `💲 ${formatUsd(usd)} USDT`,
    `🔷 ${formatDual(dualAmt)}`,
    `💵 Price $${pricePerDual.toFixed(8)}`,
    `👤 [${shortAddr(maker)}](https://etherscan.io/address/${maker})`,
    `🔗 [View TX](https://etherscan.io/tx/${txHash})`,
    ``,
    `[Chart](https://dexscreener.com/ethereum/${POOL_ADDRESS}) · [Buy DUAL](https://app.uniswap.org/swap?outputCurrency=${DUAL_TOKEN})`,
  ].filter(Boolean).join("\n");

  for (const chatId of CHAT_IDS) {
    const url = `https://api.telegram.org/bot${BOT_TOKEN}/sendPhoto`;
    const res  = await fetch(url, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({ chat_id: chatId, photo: HEADER_IMG, caption, parse_mode: "Markdown", disable_web_page_preview: true }),
    });
    const json = await res.json();
    if (!json.ok) console.error(`Telegram error (${chatId}):`, JSON.stringify(json));
    else console.log(`✅ Sent to ${chatId}`);
  }
}

async function main() {
  if (!BOT_TOKEN)   { console.error("❌ BOT_TOKEN not set");   process.exit(1); }
  if (!ALCHEMY_KEY) { console.error("❌ ALCHEMY_KEY not set"); process.exit(1); }

  // Get ETH price and refresh every 5 minutes
  await getEthPrice();
  setInterval(getEthPrice, 5 * 60 * 1000);

  const provider = new ethers.WebSocketProvider(
    `wss://eth-mainnet.g.alchemy.com/v2/${ALCHEMY_KEY}`
  );

  // Get token decimals
  const dualContract = new ethers.Contract(DUAL_TOKEN, ERC20_ABI, provider);
  const wethContract = new ethers.Contract(WETH_TOKEN, ERC20_ABI, provider);
  dualDecimals = await dualContract.decimals();
  wethDecimals = await wethContract.decimals();
  console.log(`DUAL decimals: ${dualDecimals}, WETH decimals: ${wethDecimals}`);

  const pool = new ethers.Contract(POOL_ADDRESS, POOL_ABI, provider);

  console.log(`🦋 DUAL whale bot started — listening for buys ≥ $${MIN_USD} on Ethereum`);

  pool.on("Swap", async (sender, recipient, amount0, amount1, sqrtPriceX96, liquidity, tick, event) => {
    try {
      // In DUAL/WETH pool:
      // amount0 = DUAL (token0), amount1 = WETH (token1)
      // A BUY of DUAL = amount0 is POSITIVE (DUAL leaving pool to buyer)
      // Wait — in Uniswap V3: negative amount = token leaving pool (received by user)
      // So amount0 < 0 means DUAL is leaving pool = user is BUYING DUAL

      const dualRaw = BigInt(amount0.toString());
      const wethRaw = BigInt(amount1.toString());

      const isBuy = dualRaw < 0n; // DUAL leaving pool = buy
      if (!isBuy) return;

      const dualAmt     = Number(-dualRaw) / 10 ** Number(dualDecimals);
      const wethAmt     = Number(wethRaw)  / 10 ** Number(wethDecimals);
      const usdValue    = wethAmt * ethPriceUsd;
      const pricePerDual = usdValue / dualAmt;

      if (usdValue < MIN_USD) return;

      const txHash = event.log.transactionHash;
      const maker  = recipient; // buyer receives DUAL

      console.log(`🔔 Buy detected: ${formatDual(dualAmt)} for ${formatUsd(usdValue)} | tx: ${txHash.slice(0,10)}...`);

      await sendAlert({ usd: usdValue, dualAmt, pricePerDual, maker, txHash });

    } catch (err) {
      console.error("Swap handler error:", err.message);
    }
  });

  // Keep WebSocket alive with ping
  setInterval(() => {
    provider.getBlockNumber().then(b => console.log(`Block: ${b}`)).catch(e => {
      console.error("Provider ping failed:", e.message);
      process.exit(1); // Railway will auto-restart
    });
  }, 30_000);

  provider.on("error", (err) => {
    console.error("Provider error:", err.message);
    process.exit(1);
  });
}

main();
