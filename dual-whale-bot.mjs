// dual-whale-bot.mjs
// DUAL Whale Alert Bot for Telegram
// Monitors DUAL/ETH on Uniswap (Base) and alerts on buys >= $1000

import fetch from "node-fetch";

const BOT_TOKEN  = process.env.BOT_TOKEN;
const CHAT_ID    = "-1003979928587";
const DUAL_TOKEN = "0x6aF487BEb26B6d9f4d9B9A6aBf4E19c8aAb6b3E4"; // DUAL token on Base
const PAIR       = "0x832b55B0fA6397ca9e63B8c15DAdeF3f6E44614c";
const MIN_USD    = 1000;
const POLL_MS    = 30_000;
const HEADER_IMG = "https://i.imgur.com/pxgb6mN.jpeg";

const seenTxns = new Set();

function butterflies(usd) {
  const count = Math.max(1, Math.round(usd / 100));
  return "🦋".repeat(Math.min(count, 60));
}

function formatUsd(n) {
  return "$" + Number(n).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

function formatDual(n) {
  return Number(n).toLocaleString("en-US", { maximumFractionDigits: 0 }) + " DUAL";
}

async function fetchTrades() {
  // Use token-pairs endpoint to get recent trades via pair data
  const url = `https://api.dexscreener.com/latest/dex/pairs/base/${PAIR}`;
  const res  = await fetch(url, {
    headers: { "User-Agent": "Mozilla/5.0" }
  });
  if (!res.ok) throw new Error(`Dexscreener HTTP ${res.status}`);
  const data = await res.json();
  return data.pair ?? null;
}

async function fetchRecentTxns() {
  // Use token endpoint to get trades
  const url = `https://api.dexscreener.com/token-pairs/v1/base/${DUAL_TOKEN}`;
  const res  = await fetch(url, {
    headers: { "User-Agent": "Mozilla/5.0" }
  });
  if (!res.ok) {
    console.error(`Token pairs HTTP ${res.status}`);
    return [];
  }
  const data = await res.json();
  // Find our specific pair
  const pair = Array.isArray(data) 
    ? data.find(p => p.pairAddress?.toLowerCase() === PAIR.toLowerCase())
    : null;
  return pair;
}

// Track price and volume to detect big buys via volume spikes
let lastVolumeH1 = null;
let lastPriceUsd = null;

async function processNewTrades() {
  const pair = await fetchTrades();
  if (!pair) return;

  const currentVolumeH1 = parseFloat(pair?.volume?.h1 ?? 0);
  const currentPrice    = parseFloat(pair?.priceUsd ?? 0);
  const mcap            = pair?.marketCap ?? pair?.fdv ?? 0;

  // On first run, just store baseline
  if (lastVolumeH1 === null) {
    lastVolumeH1 = currentVolumeH1;
    lastPriceUsd = currentPrice;
    console.log(`Baseline set — volume H1: $${currentVolumeH1.toFixed(0)}, price: $${currentPrice}`);
    return;
  }

  const volumeDelta = currentVolumeH1 - lastVolumeH1;
  const priceChange = currentPrice - lastPriceUsd;

  // A big buy shows up as: volume increased AND price went up
  if (volumeDelta >= MIN_USD && priceChange >= 0) {
    const txKey = `${Date.now()}-${volumeDelta.toFixed(0)}`;
    if (!seenTxns.has(txKey)) {
      seenTxns.add(txKey);
      if (seenTxns.size > 500) seenTxns.clear();

      const estDual = volumeDelta / currentPrice;
      await sendAlert(volumeDelta, estDual, currentPrice, mcap);
    }
  }

  lastVolumeH1 = currentVolumeH1;
  lastPriceUsd = currentPrice;
}

async function sendAlert(usd, dualAmt, price, mcap) {
  const caption = [
    `*DUAL Token Buy!*`,
    butterflies(usd),
    ``,
    `💲 ${formatUsd(usd)} USDT`,
    `🔷 ~${formatDual(dualAmt)}`,
    `💵 Price ${formatUsd(price)}`,
    mcap ? `📊 Market Cap ${formatUsd(mcap)}` : null,
    ``,
    `[Chart](https://dexscreener.com/base/${PAIR}) · [Buy DUAL](https://app.uniswap.org/swap?outputCurrency=${DUAL_TOKEN}&chain=base)`,
  ].filter(Boolean).join("\n");

  const url = `https://api.telegram.org/bot${BOT_TOKEN}/sendPhoto`;
  const res  = await fetch(url, {
    method:  "POST",
    headers: { "Content-Type": "application/json" },
    body:    JSON.stringify({
      chat_id:    CHAT_ID,
      photo:      HEADER_IMG,
      caption:    caption,
      parse_mode: "Markdown",
    }),
  });
  const json = await res.json();
  if (!json.ok) console.error("Telegram error:", JSON.stringify(json));
  else console.log(`✅ Alerted: ${formatUsd(usd)} buy`);
}

async function main() {
  if (!BOT_TOKEN) {
    console.error("❌  BOT_TOKEN environment variable is not set.");
    process.exit(1);
  }
  console.log("🦋  DUAL whale bot started — watching for buys ≥ $1,000");
  await processNewTrades();
  setInterval(async () => {
    try { await processNewTrades(); }
    catch (err) { console.error("Poll error:", err.message); }
  }, POLL_MS);
}

main();
