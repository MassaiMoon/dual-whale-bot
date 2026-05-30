import fetch from "node-fetch";

const BOT_TOKEN  = process.env.BOT_TOKEN;
const CHAT_ID    = "-1003979928587";
const DUAL_TOKEN = "0x6aF487BEb26B6d9f4d9B9A6aBf4E19c8aAb6b3E4";
const PAIR       = "0x832b55B0fA6397ca9e63B8c15DAdeF3f6E44614c";
const MIN_USD    = 1;
const POLL_MS    = 30_000;
const HEADER_IMG = "https://i.imgur.com/pxgb6mN.jpeg";

const seenTxns = new Set();

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

async function fetchPair() {
  // Use token address endpoint — more reliable than pair address
  const url = `https://api.dexscreener.com/token-pairs/v1/base/${DUAL_TOKEN}`;
  const res  = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
  if (!res.ok) throw new Error(`Dexscreener HTTP ${res.status}`);
  const data = await res.json();
  // data is an array of pairs — find the one matching our pair address
  if (!Array.isArray(data) || data.length === 0) return null;
  // prefer our specific pair, otherwise use highest liquidity pair
  const match = data.find(p => p.pairAddress?.toLowerCase() === PAIR.toLowerCase())
    ?? data.sort((a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0))[0];
  console.log(`Using pair: ${match.pairAddress} (${match.baseToken?.symbol}/${match.quoteToken?.symbol})`);
  return match;
}

let lastVolumeH1 = null;
let lastPriceUsd = null;

async function processNewTrades() {
  const pair = await fetchPair();
  if (!pair) { console.log("No pair data"); return; }

  const currentVolumeH1 = parseFloat(pair?.volume?.h1 ?? 0);
  const currentPrice    = parseFloat(pair?.priceUsd ?? 0);
  const mcap            = pair?.marketCap ?? pair?.fdv ?? 0;

  console.log(`Poll — vol H1: $${currentVolumeH1.toFixed(0)}, price: $${currentPrice}`);

  if (lastVolumeH1 === null) {
    lastVolumeH1 = currentVolumeH1;
    lastPriceUsd = currentPrice;
    console.log("Baseline set ✅");
    return;
  }

  const volumeDelta = currentVolumeH1 - lastVolumeH1;

  if (volumeDelta >= MIN_USD) {
    const txKey = `${Math.round(Date.now()/30000)}-${Math.round(volumeDelta)}`;
    if (!seenTxns.has(txKey)) {
      seenTxns.add(txKey);
      if (seenTxns.size > 500) seenTxns.clear();
      const estDual = currentPrice > 0 ? volumeDelta / currentPrice : 0;
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
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: CHAT_ID, photo: HEADER_IMG, caption, parse_mode: "Markdown" }),
  });
  const json = await res.json();
  if (!json.ok) console.error("Telegram error:", JSON.stringify(json));
  else console.log(`✅ Alerted: ${formatUsd(usd)} buy`);
}

async function main() {
  if (!BOT_TOKEN) { console.error("❌  BOT_TOKEN not set."); process.exit(1); }
  console.log("🦋  DUAL whale bot started — watching for buys ≥ $" + MIN_USD);
  await processNewTrades();
  setInterval(async () => {
    try { await processNewTrades(); }
    catch (err) { console.error("Poll error:", err.message); }
  }, POLL_MS);
}

main();
