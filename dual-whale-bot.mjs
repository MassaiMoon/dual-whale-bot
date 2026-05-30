import fetch from "node-fetch";

const BOT_TOKEN  = process.env.BOT_TOKEN;
const CHAT_ID    = "-1003979928587";
const DUAL_TOKEN = "0x6aF487BEb661CCeCD1D045E9561A0dAC9AA5c7db";
const MIN_USD    = 750;
const POLL_MS    = 30_000;
const HEADER_IMG = "https://i.postimg.cc/XqpFwTGR/f9abbb99-dcae-4b93-a3a1-2456749da4e2.jpg";

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

function shortAddr(addr) {
  if (!addr) return null;
  return addr.slice(0, 6) + "..." + addr.slice(-4);
}

async function fetchPair() {
  const url = `https://api.dexscreener.com/token-pairs/v1/ethereum/${DUAL_TOKEN}`;
  const res  = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
  if (!res.ok) throw new Error(`Dexscreener HTTP ${res.status}`);
  const data = await res.json();
  if (!Array.isArray(data) || data.length === 0) return null;
  return data.sort((a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0))[0];
}

async function fetchTrades(pairAddress) {
  const url = `https://api.dexscreener.com/latest/dex/trades/ethereum/${pairAddress}`;
  const res  = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
  if (!res.ok) return [];
  const data = await res.json();
  return data.trades ?? [];
}

let lastVolumeH1 = null;

async function processNewTrades() {
  const pair = await fetchPair();
  if (!pair) { console.log("No pair data"); return; }

  const pairAddress  = pair.pairAddress;
  const currentPrice = parseFloat(pair?.priceUsd ?? 0);
  const mcap         = pair?.marketCap ?? pair?.fdv ?? 0;

  // Try trade-level first (gives us wallet addresses)
  const trades = await fetchTrades(pairAddress);

  if (trades.length > 0) {
    console.log(`Poll — ${trades.length} trades found, price: $${currentPrice.toFixed(8)}`);
    for (const t of trades) {
      if (t.type !== "buy") continue;
      if (seenTxns.has(t.txHash)) continue;
      const usd = parseFloat(t.volumeUsd ?? 0);
      if (usd < MIN_USD) continue;

      seenTxns.add(t.txHash);
      if (seenTxns.size > 2000) seenTxns.clear();

      const dualAmt = parseFloat(t.amount0 ?? 0);
      await sendAlert({ usd, dualAmt, price: currentPrice, mcap, pairAddress, maker: t.maker, txHash: t.txHash });
    }
  } else {
    // Fallback: volume delta
    const currentVol = parseFloat(pair?.volume?.h1 ?? 0);
    console.log(`Poll — vol H1: $${currentVol.toFixed(0)}, price: $${currentPrice.toFixed(8)}`);

    if (lastVolumeH1 === null) {
      lastVolumeH1 = currentVol;
      console.log("Baseline set ✅");
      return;
    }

    const delta = currentVol - lastVolumeH1;
    lastVolumeH1 = currentVol;

    if (delta >= MIN_USD) {
      const txKey = `${Math.round(Date.now()/30000)}-${Math.round(delta)}`;
      if (!seenTxns.has(txKey)) {
        seenTxns.add(txKey);
        if (seenTxns.size > 2000) seenTxns.clear();
        const estDual = currentPrice > 0 ? delta / currentPrice : 0;
        await sendAlert({ usd: delta, dualAmt: estDual, price: currentPrice, mcap, pairAddress, maker: null, txHash: null });
      }
    }
  }
}

async function sendAlert({ usd, dualAmt, price, mcap, pairAddress, maker, txHash }) {
  const caption = [
    `*DUAL Token Buy!*`,
    butterflies(usd),
    ``,
    `💲 ${formatUsd(usd)} USDT`,
    `🔷 ~${formatDual(dualAmt)}`,
    `💵 Price $${price.toFixed(8)}`,
    mcap ? `📊 Market Cap ${formatUsd(mcap)}` : null,
    maker ? `👤 [${shortAddr(maker)}](https://etherscan.io/address/${maker})` : null,
    txHash ? `🔗 [View TX](https://etherscan.io/tx/${txHash})` : null,
    ``,
    `[Chart](https://dexscreener.com/ethereum/${pairAddress}) · [Buy DUAL](https://app.uniswap.org/swap?outputCurrency=${DUAL_TOKEN})`,
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
  console.log("🦋  DUAL whale bot started — watching ETH buys ≥ $" + MIN_USD);
  await processNewTrades();
  setInterval(async () => {
    try { await processNewTrades(); }
    catch (err) { console.error("Poll error:", err.message); }
  }, POLL_MS);
}

main();
