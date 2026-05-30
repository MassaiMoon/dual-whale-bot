import fetch from "node-fetch";

const BOT_TOKEN       = process.env.BOT_TOKEN;
const CHAT_ID         = "-1003979928587";
const DUAL_TOKEN_BASE = "0x832b55B0fA6397ca9e63B8c15DAdeF3f6E44614c";
const DUAL_TOKEN_ETH  = "0x6aF487BEb661CCeCD1D045E9561A0dAC9AA5c7db";
const MIN_USD         = 1000;
const POLL_MS         = 30_000;
const HEADER_IMG      = "https://i.postimg.cc/XqpFwTGR/f9abbb99-dcae-4b93-a3a1-2456749da4e2.jpg";

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
  if (!addr) return "unknown";
  return addr.slice(0, 6) + "..." + addr.slice(-4);
}

async function fetchRecentBuys(chain, tokenAddress) {
  const url = `https://api.dexscreener.com/token-pairs/v1/${chain}/${tokenAddress}`;
  const res  = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
  if (!res.ok) return { pair: null, trades: [] };
  const data = await res.json();
  if (!Array.isArray(data) || data.length === 0) return { pair: null, trades: [] };
  const pair = data.sort((a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0))[0];
  return { pair, trades: [] };
}

async function fetchTrades(chain, pairAddress) {
  const url = `https://api.dexscreener.com/latest/dex/trades/${chain}/${pairAddress}`;
  const res  = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
  if (!res.ok) return [];
  const data = await res.json();
  return data.trades ?? [];
}

async function processChain(chain, tokenAddress, explorerBase) {
  const { pair } = await fetchRecentBuys(chain, tokenAddress);
  if (!pair) { console.log(`No pair data for ${chain}`); return; }

  const pairAddress = pair.pairAddress;
  const currentPrice = parseFloat(pair?.priceUsd ?? 0);
  const mcap = pair?.marketCap ?? pair?.fdv ?? 0;

  // Try to get individual trades
  const trades = await fetchTrades(chain, pairAddress);

  if (trades.length > 0) {
    // Trade-level approach — precise wallet + amount
    for (const t of trades) {
      if (t.type !== "buy") continue;
      if (seenTxns.has(t.txHash)) continue;
      const usd = parseFloat(t.volumeUsd ?? 0);
      if (usd < MIN_USD) continue;

      seenTxns.add(t.txHash);
      if (seenTxns.size > 2000) seenTxns.clear();

      const dualAmt = parseFloat(t.amount0 ?? 0);
      const maker   = t.maker ?? null;
      await sendAlert({ usd, dualAmt, price: currentPrice, mcap, pairAddress, maker, txHash: t.txHash, chain, explorerBase });
    }
  } else {
    // Fallback: volume-delta approach
    const volKey = `vol_${chain}`;
    const currentVol = parseFloat(pair?.volume?.h1 ?? 0);

    if (!seenTxns.has(volKey + "_baseline")) {
      seenTxns.set ? null : null;
      globalThis[volKey] = currentVol;
      seenTxns.add(volKey + "_baseline");
      console.log(`${chain} baseline set — vol H1: $${currentVol.toFixed(0)}`);
      return;
    }

    const lastVol = globalThis[volKey] ?? currentVol;
    const delta   = currentVol - lastVol;
    globalThis[volKey] = currentVol;

    console.log(`${chain} poll — vol H1: $${currentVol.toFixed(0)}, price: $${currentPrice.toFixed(8)}`);

    if (delta >= MIN_USD) {
      const txKey = `${chain}-${Math.round(Date.now()/30000)}-${Math.round(delta)}`;
      if (!seenTxns.has(txKey)) {
        seenTxns.add(txKey);
        if (seenTxns.size > 2000) seenTxns.clear();
        const estDual = currentPrice > 0 ? delta / currentPrice : 0;
        await sendAlert({ usd: delta, dualAmt: estDual, price: currentPrice, mcap, pairAddress, maker: null, txHash: null, chain, explorerBase });
      }
    }
  }
}

async function sendAlert({ usd, dualAmt, price, mcap, pairAddress, maker, txHash, chain, explorerBase }) {
  const walletLine = maker
    ? `👤 [${shortAddr(maker)}](${explorerBase}/address/${maker})`
    : null;
  const txLine = txHash
    ? `🔗 [View TX](${explorerBase}/tx/${txHash})`
    : null;

  const caption = [
    `*DUAL Token Buy!*`,
    butterflies(usd),
    ``,
    `💲 ${formatUsd(usd)} USDT`,
    `🔷 ~${formatDual(dualAmt)}`,
    `💵 Price $${price.toFixed(8)}`,
    mcap ? `📊 Market Cap ${formatUsd(mcap)}` : null,
    walletLine,
    txLine,
    ``,
    `[Chart](https://dexscreener.com/${chain}/${pairAddress}) · [Buy DUAL](https://app.uniswap.org/swap?outputCurrency=${DUAL_TOKEN_ETH})`,
  ].filter(Boolean).join("\n");

  const url = `https://api.telegram.org/bot${BOT_TOKEN}/sendPhoto`;
  const res  = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: CHAT_ID, photo: HEADER_IMG, caption, parse_mode: "Markdown" }),
  });
  const json = await res.json();
  if (!json.ok) console.error("Telegram error:", JSON.stringify(json));
  else console.log(`✅ Alerted: ${formatUsd(usd)} buy on ${chain}`);
}

async function main() {
  if (!BOT_TOKEN) { console.error("❌  BOT_TOKEN not set."); process.exit(1); }
  console.log("🦋  DUAL whale bot started — watching for buys ≥ $" + MIN_USD);

  const run = async () => {
    try { await processChain("base", DUAL_TOKEN_BASE, "https://basescan.org"); } 
    catch (err) { console.error("Base poll error:", err.message); }
    try { await processChain("ethereum", DUAL_TOKEN_ETH, "https://etherscan.io"); }
    catch (err) { console.error("ETH poll error:", err.message); }
  };

  await run();
  setInterval(run, POLL_MS);
}

main();
