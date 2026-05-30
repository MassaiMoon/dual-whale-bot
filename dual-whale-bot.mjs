// dual-whale-bot.mjs
// DUAL Whale Alert Bot for Telegram
// Monitors DUAL/ETH on Uniswap (Base) and alerts on buys >= $1000

import fetch from "node-fetch";

const BOT_TOKEN  = process.env.BOT_TOKEN;
const CHAT_ID    = "-1003979928587";
const PAIR       = "0x832b55B0fA6397ca9e63B8c15DAdeF3f6E44614c";
const MIN_USD    = 1000;
const POLL_MS    = 30_000;
const HEADER_IMG = "https://i.imgur.com/pxgb6mN.jpeg";

const seenTxns = new Set();

function butterflies(usd) {
  const count = Math.max(1, Math.round(usd / 100));
  return "🦋".repeat(Math.min(count, 60)); // cap at 60 so message doesn't get too long
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
  const url = `https://api.dexscreener.com/latest/dex/trades/${PAIR}`;
  const res  = await fetch(url);
  if (!res.ok) throw new Error(`Dexscreener HTTP ${res.status}`);
  const data = await res.json();
  return data.trades ?? [];
}

async function fetchPairInfo() {
  const url = `https://api.dexscreener.com/latest/dex/pairs/base/${PAIR}`;
  const res  = await fetch(url);
  if (!res.ok) return null;
  const data = await res.json();
  return data.pair ?? null;
}

async function sendAlert(trade, pair) {
  const usd     = parseFloat(trade.volumeUsd ?? 0);
  const dualAmt = parseFloat(trade.amount0 ?? 0);
  const price   = dualAmt > 0 ? usd / dualAmt : 0;
  const mcap    = pair?.marketCap ?? pair?.fdv ?? 0;
  const wallet  = trade.maker
    ? trade.maker.slice(0, 6) + "..." + trade.maker.slice(-4)
    : "unknown";

  const caption = [
    `*DUAL Token Buy!*`,
    butterflies(usd),
    ``,
    `💲 ${formatUsd(usd)} (${formatUsd(usd)} USDT)`,
    `🔷 ${formatDual(dualAmt)}`,
    `👤 [Buyer](https://basescan.org/address/${trade.maker}) / [TX](https://basescan.org/tx/${trade.txHash})`,
    `💵 Price ${formatUsd(price)}`,
    mcap ? `📊 Market Cap ${formatUsd(mcap)}` : null,
    ``,
    `[Chart](https://dexscreener.com/base/${PAIR}) · [Buy DUAL](https://app.uniswap.org/#/swap?outputCurrency=0x6aF487BEb26B6d9f4d9B9A6aBf4E19c8aAb6b3E4)`,
  ].filter(Boolean).join("\n");

  const url  = `https://api.telegram.org/bot${BOT_TOKEN}/sendPhoto`;
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

async function processNewTrades() {
  const [trades, pair] = await Promise.all([fetchTrades(), fetchPairInfo()]);

  for (const t of trades) {
    if (t.type !== "buy")       continue;
    if (seenTxns.has(t.txHash)) continue;
    const usd = parseFloat(t.volumeUsd ?? 0);
    if (usd < MIN_USD)          continue;

    seenTxns.add(t.txHash);
    if (seenTxns.size > 2000) seenTxns.clear();

    await sendAlert(t, pair);
  }
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
