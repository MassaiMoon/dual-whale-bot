import fetch from "node-fetch";

const BOT_TOKEN      = process.env.BOT_TOKEN;
const CHAT_IDS = ["-1003979928587", "-1002857896980"];
const MIN_USD        = 750;
const POLL_MS        = 30_000;
const HEADER_IMG = "AgACAgQAAxkBAAMLahsaxWL-qj5Rttn21HUd_pXCL9wAAoESaxtYctlQSq9wyE-vZM0BAAMCAAN5AAM7BA";

const CHAINS = [
  {
    name:        "ethereum",
    token:       "0x6aF487BEb661CCeCD1D045E9561A0dAC9AA5c7db",
    explorer:    "https://etherscan.io",
    label:       "ETH",
  },
  {
    name:        "base",
    token:       "0x832b55B0fA6397ca9e63B8c15DAdeF3f6E44614c",
    explorer:    "https://basescan.org",
    label:       "BASE",
  },
];

const seenTxns   = new Set();
const lastVolume = {};  // keyed by chain name

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

async function fetchPair(chain, token) {
  const url = `https://api.dexscreener.com/token-pairs/v1/${chain}/${token}`;
  const res  = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
  if (!res.ok) throw new Error(`Dexscreener ${chain} HTTP ${res.status}`);
  const data = await res.json();
  if (!Array.isArray(data) || data.length === 0) return null;
  return data.sort((a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0))[0];
}

async function fetchTrades(chain, pairAddress) {
  const url = `https://api.dexscreener.com/latest/dex/trades/${chain}/${pairAddress}`;
  const res  = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
  if (!res.ok) return [];
  const data = await res.json();
  return data.trades ?? [];
}

async function processChain({ name, token, explorer, label }) {
  const pair = await fetchPair(name, token);
  if (!pair) { console.log(`[${label}] No pair data`); return; }

  const pairAddress  = pair.pairAddress;
  const currentPrice = parseFloat(pair?.priceUsd ?? 0);
  const mcap         = pair?.marketCap ?? pair?.fdv ?? 0;

  const trades = await fetchTrades(name, pairAddress);

  if (trades.length > 0) {
    console.log(`[${label}] ${trades.length} trades, price: $${currentPrice.toFixed(8)}`);
    for (const t of trades) {
      if (t.type !== "buy") continue;
      if (seenTxns.has(t.txHash)) continue;
      const usd = parseFloat(t.volumeUsd ?? 0);
      if (usd < MIN_USD) continue;

      seenTxns.add(t.txHash);
      if (seenTxns.size > 2000) seenTxns.clear();

      const dualAmt = parseFloat(t.amount0 ?? 0);
      await sendAlert({ usd, dualAmt, price: currentPrice, mcap, pairAddress, maker: t.maker, txHash: t.txHash, explorer, label, chain: name });
    }
  } else {
    // Volume-delta fallback
    const currentVol = parseFloat(pair?.volume?.h1 ?? 0);
    console.log(`[${label}] vol H1: $${currentVol.toFixed(0)}, price: $${currentPrice.toFixed(8)}`);

    if (lastVolume[name] === undefined) {
      lastVolume[name] = currentVol;
      console.log(`[${label}] Baseline set ✅`);
      return;
    }

    const delta = currentVol - lastVolume[name];
    lastVolume[name] = currentVol;

    if (delta >= MIN_USD) {
      const txKey = `${name}-${Math.round(Date.now()/30000)}-${Math.round(delta)}`;
      if (!seenTxns.has(txKey)) {
        seenTxns.add(txKey);
        if (seenTxns.size > 2000) seenTxns.clear();
        const estDual = currentPrice > 0 ? delta / currentPrice : 0;
        await sendAlert({ usd: delta, dualAmt: estDual, price: currentPrice, mcap, pairAddress, maker: null, txHash: null, explorer, label, chain: name });
      }
    }
  }
}

async function sendAlert({ usd, dualAmt, price, mcap, pairAddress, maker, txHash, explorer, label, chain }) {
  const caption = [
    `*DUAL Token Buy!* _[${label}]_`,
    butterflies(usd),
    ``,
    `💲 ${formatUsd(usd)} USDT`,
    `🔷 ~${formatDual(dualAmt)}`,
    `💵 Price $${price.toFixed(8)}`,
    mcap ? `📊 Market Cap ${formatUsd(mcap)}` : null,
    maker ? `👤 [${shortAddr(maker)}](${explorer}/address/${maker})` : null,
    txHash ? `🔗 [View TX](${explorer}/tx/${txHash})` : null,
    ``,
    `[Chart](https://dexscreener.com/${chain}/${pairAddress}) · [Buy DUAL](https://app.uniswap.org/swap?outputCurrency=${CHAINS.find(c=>c.name===chain)?.token})`,
  ].filter(Boolean).join("\n");

  for (const chatId of CHAT_IDS) {
    const url = `https://api.telegram.org/bot${BOT_TOKEN}/sendPhoto`;
    const res  = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, photo: HEADER_IMG, caption, parse_mode: "Markdown", disable_web_page_preview: true }),
    });
    const json = await res.json();
    if (!json.ok) console.error(`Telegram error (${chatId}):`, JSON.stringify(json));
    else console.log(`✅ Alerted: ${formatUsd(usd)} buy on ${label} -> ${chatId}`);
  }
}

async function main() {
  if (!BOT_TOKEN) { console.error("❌  BOT_TOKEN not set."); process.exit(1); }
  console.log("🦋  DUAL whale bot started — watching ETH + BASE buys ≥ $" + MIN_USD);

  const run = async () => {
    for (const chain of CHAINS) {
      try { await processChain(chain); }
      catch (err) { console.error(`[${chain.label}] Error:`, err.message); }
    }
  };

  await run();
  setInterval(run, POLL_MS);
}

main();
