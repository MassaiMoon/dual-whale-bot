// v7 - tracks the Uniswap V3 DUAL/WETH pool (most liquidity), real buyer, safe price, no crash loop
//
// Uniswap V3 Swap amounts are from the POOL's point of view:
//   negative = left the pool (sent to the trader), positive = entered the pool.
// token0 = DUAL, token1 = WETH, so a DUAL buy is amount0 < 0 (DUAL out) and amount1 > 0 (WETH in).
// Verified on-chain 2026-11-25 against DUAL Transfer logs.
// (The old V4 pool 0xe395d0bad31e1f95d4209399efdcc1e221eb369d0be7782fb7704d9a9d5f08c8 used the
//  opposite, swapper-side convention. It is no longer tracked: ~$20K liquidity.)
import fetch from "node-fetch";
import { createRequire } from "module";
const require = createRequire(import.meta.url);
const { ethers } = require("ethers");

// ---------- config (Railway → service → Variables) ----------
const BOT_TOKEN     = process.env.BOT_TOKEN;
const ALCHEMY_KEY   = process.env.ALCHEMY_KEY;
const CHAT_IDS      = (process.env.CHAT_IDS || "-1003979928587,-1002857896980")
                        .split(",").map(s => s.trim()).filter(Boolean);
const MIN_USD       = Number(process.env.MIN_USD || 450);
const ADMIN_CHAT_ID = process.env.ADMIN_CHAT_ID || "";   // optional: private chat for startup notice
const HEADER_IMG    = "AgACAgQAAxkBAAMLahsaxWL-qj5Rttn21HUd_pXCL9wAAoESaxtYctlQSq9wyE-vZM0BAAMCAAN5AAM7BA";

// Replay mode for testing without posting: DRY_RUN_TX=0xhash1,0xhash2  RPC_URL=https://...
const DRY_RUN_TX    = process.env.DRY_RUN_TX || "";
const RPC_URL       = process.env.RPC_URL || "";

// ---------- on-chain constants ----------
const DUAL_POOL     = "0xA7C65b7B4b73a6CBbb998148f224bbEb2f49Ca87"; // Uniswap V3 DUAL/WETH 1%
const DUAL_TOKEN    = "0x6aF487BEb661CCeCD1D045E9561A0dAC9AA5c7db";

const SWAP_IFACE = new ethers.Interface([
  "event Swap(address indexed sender, address indexed recipient, int256 amount0, int256 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick)",
]);
const SWAP_TOPIC     = SWAP_IFACE.getEvent("Swap").topicHash;
const TRANSFER_TOPIC = ethers.id("Transfer(address,address,uint256)");
// Only this pool's swaps are delivered.
const SWAP_FILTER    = { address: DUAL_POOL, topics: [SWAP_TOPIC] };

const PRICE_MAX_AGE_MS = 30 * 60 * 1000;   // don't post with an ETH price older than 30 min

// ---------- state ----------
let ethPriceUsd  = null;
let ethPriceAt   = 0;
const seenTxns   = new Set();
let reconnectDelay = 5000;
let reconnectTimer = null;

// ---------- formatting ----------
const butterflies = usd => "🦋".repeat(Math.min(Math.max(1, Math.round(usd / 100)), 60));
const formatUsd   = n => "$" + Number(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const formatDual  = n => Number(n).toLocaleString("en-US", { maximumFractionDigits: 0 }) + " DUAL";
const shortAddr   = a => a.slice(0, 6) + "..." + a.slice(-4);

function rememberTx(hash) {
  seenTxns.add(hash);
  if (seenTxns.size > 2000) seenTxns.delete(seenTxns.values().next().value); // drop oldest
}

// ---------- ETH price: CoinGecko, then Coinbase ----------
async function getJson(url) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 10_000);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally { clearTimeout(t); }
}

async function getEthPrice() {
  const sources = [
    ["CoinGecko", async () => (await getJson("https://api.coingecko.com/api/v3/simple/price?ids=ethereum&vs_currencies=usd"))?.ethereum?.usd],
    ["Coinbase",  async () => Number((await getJson("https://api.coinbase.com/v2/prices/ETH-USD/spot"))?.data?.amount)],
  ];
  for (const [name, fn] of sources) {
    try {
      const p = await fn();
      if (Number.isFinite(p) && p > 100) {
        ethPriceUsd = p; ethPriceAt = Date.now();
        console.log(`ETH price: $${p} (${name})`);
        return;
      }
      throw new Error("bad value " + p);
    } catch (e) {
      console.error(`ETH price error (${name}):`, e.message);
    }
  }
  console.error("⚠️ All ETH price sources failed; keeping last price", ethPriceUsd);
}

const priceIsFresh = () => ethPriceUsd !== null && Date.now() - ethPriceAt < PRICE_MAX_AGE_MS;

// ---------- Telegram ----------
async function tg(method, body) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const res  = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/${method}`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    });
    const json = await res.json();
    if (json.ok) return json;
    const wait = json?.parameters?.retry_after;
    if (wait && attempt === 0) { await new Promise(r => setTimeout(r, (wait + 1) * 1000)); continue; }
    throw new Error(JSON.stringify(json));
  }
}

function buildCaption({ usd, dualAmt, pricePerDual, buyer, txHash }) {
  return [
    `*DUAL Token Buy! 🟢*`,
    butterflies(usd),
    ``,
    `💲 ${formatUsd(usd)}`,
    `🔷 ${formatDual(dualAmt)}`,
    `💵 Price $${pricePerDual.toFixed(8)}`,
    `👤 [${shortAddr(buyer)}](https://etherscan.io/address/${buyer})`,
    `🔗 [View TX](https://etherscan.io/tx/${txHash})`,
    ``,
    `[Chart](https://dexscreener.com/ethereum/${DUAL_POOL}) · [Buy DUAL](https://app.uniswap.org/swap?outputCurrency=${DUAL_TOKEN})`,
  ].join("\n");
}

async function sendAlert(alert) {
  const caption = buildCaption(alert);
  if (DRY_RUN_TX) { console.log("---- DRY RUN caption ----\n" + caption + "\n-------------------------"); return; }
  for (const chatId of CHAT_IDS) {
    try {
      await tg("sendPhoto", { chat_id: chatId, photo: HEADER_IMG, caption, parse_mode: "Markdown" });
      console.log(`✅ Sent to ${chatId}: ${formatUsd(alert.usd)}`);
    } catch (e) {
      console.error(`Telegram error (${chatId}):`, e.message);
    }
  }
}

// ---------- buyer: the address that ends up with the most DUAL in this tx ----------
// The Swap event's `sender` is usually a router; tx.from can be a bot/relayer.
async function findBuyer(provider, txHash, fallback) {
  try {
    const rc  = await provider.getTransactionReceipt(txHash);
    const net = new Map();
    for (const l of rc.logs) {
      if (l.address.toLowerCase() !== DUAL_TOKEN.toLowerCase()) continue;
      if (l.topics[0] !== TRANSFER_TOPIC || l.topics.length < 3) continue;
      const from = ethers.getAddress("0x" + l.topics[1].slice(26));
      const to   = ethers.getAddress("0x" + l.topics[2].slice(26));
      const v    = BigInt(l.data);
      net.set(from, (net.get(from) ?? 0n) - v);
      net.set(to,   (net.get(to)   ?? 0n) + v);
    }
    net.delete(ethers.getAddress(DUAL_POOL));
    let best = null, bestAmt = 0n;
    for (const [addr, amt] of net) if (amt > bestAmt) { best = addr; bestAmt = amt; }
    return best ?? rc.from ?? fallback;
  } catch (e) {
    console.error("Buyer lookup failed:", e.message);
    return fallback;
  }
}

// ---------- one Swap log ----------
async function handleSwapLog(log, provider, startBlock) {
  try {
    if (log.removed) return;                                   // reorged out
    if (startBlock !== undefined && log.blockNumber < startBlock) return;
    if (log.address.toLowerCase() !== DUAL_POOL.toLowerCase()) return; // belt and braces
    if (seenTxns.has(log.transactionHash)) return;

    const ev      = SWAP_IFACE.parseLog(log);
    const amount0 = BigInt(ev.args.amount0);   // DUAL (pool view)
    const amount1 = BigInt(ev.args.amount1);   // WETH (pool view)
    const isBuy   = amount0 < 0n && amount1 > 0n;
    if (!isBuy) return;
    rememberTx(log.transactionHash);

    if (!priceIsFresh()) {
      console.error(`⚠️ Skipping alert for ${log.transactionHash}: ETH price stale or missing`);
      return;
    }

    const dualAmt      = Number(-amount0) / 1e18;
    const ethAmt       = Number(amount1) / 1e18;
    const usd          = ethAmt * ethPriceUsd;
    const pricePerDual = dualAmt > 0 ? usd / dualAmt : 0;

    console.log(`Buy ${formatDual(dualAmt)} for ${ethAmt.toFixed(4)} ETH (${formatUsd(usd)}) tx ${log.transactionHash}`);
    if (usd < MIN_USD) return;

    const buyer = await findBuyer(provider, log.transactionHash, ev.args.sender);
    await sendAlert({ usd, dualAmt, pricePerDual, buyer, txHash: log.transactionHash });
  } catch (err) {
    console.error("Swap handler error:", err.message);
  }
}

// ---------- WebSocket connection with backoff ----------
function scheduleReconnect() {
  if (reconnectTimer) return;
  console.log(`⏳ Reconnecting in ${reconnectDelay / 1000}s...`);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    reconnectDelay = Math.min(reconnectDelay * 2, 300_000); // max 5 min
    connect();
  }, reconnectDelay);
}

async function connect() {
  console.log("🔌 Connecting to Alchemy...");
  const session = { dead: false, ping: null, beats: 0 };
  let provider;

  const fail = async (why) => {
    if (session.dead) return;
    session.dead = true;
    console.error("Connection lost:", why);
    clearInterval(session.ping);
    try { provider?.removeAllListeners(); } catch {}
    try { await provider?.destroy(); } catch {}
    scheduleReconnect();
  };

  try {
    provider = new ethers.WebSocketProvider(`wss://eth-mainnet.g.alchemy.com/v2/${ALCHEMY_KEY}`);
    provider.on("error", e => fail("provider error: " + (e?.message || e)));

    const startBlock = await provider.getBlockNumber();
    console.log(`✅ Connected. Start block: ${startBlock}. Watching pool ${DUAL_POOL}`);
    reconnectDelay = 5000;

    await provider.on(SWAP_FILTER, log => handleSwapLog(log, provider, startBlock));

    const ws = provider.websocket;
    if (ws && typeof ws.addEventListener === "function") ws.addEventListener("close", () => fail("socket closed"));

    session.ping = setInterval(async () => {
      try {
        const block = await Promise.race([
          provider.getBlockNumber(),
          new Promise((_, rej) => setTimeout(() => rej(new Error("ping timeout")), 15_000)),
        ]);
        if (++session.beats % 20 === 0) console.log(`💓 Block ${block}`); // every ~10 min
      } catch (e) {
        fail("ping failed: " + e.message);
      }
    }, 30_000);
  } catch (err) {
    fail("connect failed: " + err.message);
  }
}

// ---------- replay mode ----------
async function dryRun() {
  if (!RPC_URL) { console.error("DRY_RUN_TX needs RPC_URL"); return; }
  const provider = new ethers.JsonRpcProvider(RPC_URL);
  await getEthPrice();
  for (const hash of DRY_RUN_TX.split(",").map(s => s.trim()).filter(Boolean)) {
    const rc = await provider.getTransactionReceipt(hash);
    const logs = rc.logs.filter(l => l.address.toLowerCase() === DUAL_POOL.toLowerCase() && l.topics[0] === SWAP_TOPIC);
    console.log(`\n${hash}: ${logs.length} Swap log(s) in the DUAL/WETH V3 pool`);
    for (const l of logs) {
      const ev = SWAP_IFACE.parseLog(l);
      console.log(`  amount0(DUAL)=${ethers.formatEther(ev.args.amount0)} amount1(WETH)=${ethers.formatEther(ev.args.amount1)} → ${BigInt(ev.args.amount0) < 0n ? "BUY" : "SELL (ignored)"}`);
      await handleSwapLog(l, provider, undefined);
    }
  }
}

// ---------- main ----------
process.on("unhandledRejection", e => console.error("Unhandled rejection:", e?.message || e));

async function main() {
  if (DRY_RUN_TX) { await dryRun(); return; }

  // Missing config: log and idle instead of exiting, so Railway doesn't restart-loop.
  const missing = [!BOT_TOKEN && "BOT_TOKEN", !ALCHEMY_KEY && "ALCHEMY_KEY"].filter(Boolean);
  if (missing.length) {
    console.error(`❌ Not set: ${missing.join(", ")}. Set them in Railway → service → Variables. Idling.`);
    setInterval(() => {}, 1 << 30);
    return;
  }

  console.log(`🦋 DUAL whale bot v7 — buys ≥ $${MIN_USD} → ${CHAT_IDS.length} chat(s)`);
  await getEthPrice();
  setInterval(getEthPrice, 5 * 60 * 1000);

  if (ADMIN_CHAT_ID) {
    tg("sendMessage", { chat_id: ADMIN_CHAT_ID, text: `🦋 DUAL whale bot v7 started. Min $${MIN_USD}, ${CHAT_IDS.length} chat(s).` })
      .catch(e => console.error("Admin notice failed:", e.message));
  }

  connect();
}

main();
