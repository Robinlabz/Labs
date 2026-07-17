// The indexer: a reorg-safe log poller. Each tick it scans a block window in
// CHUNK-sized getLogs calls, decodes our four events, and writes them. It only
// advances the cursor to (head - CONFIRMATIONS) and re-scans the last window each
// tick, so a tip reorg is corrected on the next pass. All writes are idempotent.
import { ethers } from "ethers";
import { CFG } from "./config.js";
import { iface, TOPICS, ERC20, CURVE, POOL } from "./abi.js";
import {
  db, getCursor, setCursor, upsertCoin, markGraduated, insertTrade,
  coinByCurve, purgeTradesFrom, setGeometry, setGradTargetByCurve,
  setSnapshot, coinGeom,
} from "./db.js";

const WETH = (process.env.WETH || "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73").toLowerCase();
const TOTAL_SUPPLY = 1_000_000_000; // 1B whole tokens — mcap = wethPerToken * supply

// WETH-per-token from a Uniswap sqrtPriceX96, given which side is token0.
function priceFromSqrt(sqrtX96, token0) {
  const Q96 = 2n ** 96n;
  const sqrt = BigInt(sqrtX96);
  const p1per0 = Number((sqrt * sqrt * 10n ** 18n) / (Q96 * Q96)) / 1e18; // token1 per token0
  // If our token IS token0, price(token1=WETH per token0) is WETH-per-token.
  return token0 === WETH ? (p1per0 > 0 ? 1 / p1per0 : 0) : p1per0;
}

// Progress along [startTick → ceiling], clamped 0..1 (mirrors the frontend).
function frac(tick, startTick, gradTick) {
  const span = Math.abs(gradTick - startTick) || 1;
  return Math.max(0, Math.min(1, Math.abs(tick - startTick) / span));
}

const provider = new ethers.JsonRpcProvider(CFG.rpcUrl, undefined, { staticNetwork: true });
const tsCache = new Map(); // block -> unix ts, so we don't re-fetch a block repeatedly

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Public RPCs rate-limit and occasionally 500 under load. Retry with backoff so
// a transient hiccup doesn't abort a scan. Kept small — the loop retries anyway.
async function withRetry(fn, label, tries = 5) {
  let wait = 500;
  for (let i = 1; i <= tries; i++) {
    try { return await fn(); }
    catch (e) {
      if (i === tries) throw e;
      console.warn(`[indexer] ${label} retry ${i}/${tries - 1}: ${e.shortMessage || e.message || e}`);
      await sleep(wait);
      wait = Math.min(wait * 2, 8000);
    }
  }
}

async function blockTs(bn) {
  if (tsCache.has(bn)) return tsCache.get(bn);
  const b = await withRetry(() => provider.getBlock(bn), `getBlock.${bn}`);
  const ts = b ? Number(b.timestamp) : Math.floor(Date.now() / 1000);
  tsCache.set(bn, ts);
  if (tsCache.size > 5000) tsCache.delete(tsCache.keys().next().value);
  return ts;
}

async function nameSymbol(token) {
  try {
    const c = new ethers.Contract(token, ERC20, provider);
    const name = await withRetry(() => c.name(), "erc20.name", 3);
    const symbol = await withRetry(() => c.symbol(), "erc20.symbol", 3);
    return { name, symbol };
  } catch {
    return { name: null, symbol: null };
  }
}

// Pull every relevant log in [from,to]. Robinhood Chain's Blockscout RPC rejects
// an address-array filter ("invalid address"), so we query per contract: the
// factory (Launched), the router (Bought/Sold), and Graduated by topic0 across
// any curve (matched back to its coin by log.address).
async function getLogsRange(from, to) {
  // Sequential (not parallel) — Blockscout 500s if you fan out too many getLogs
  // at once. Each call is retried independently.
  const launched = await withRetry(() =>
    provider.getLogs({ fromBlock: from, toBlock: to, address: CFG.factory, topics: [TOPICS.Launched] }), "getLogs.launched");
  const trades = await withRetry(() =>
    provider.getLogs({ fromBlock: from, toBlock: to, address: CFG.router, topics: [[TOPICS.Bought, TOPICS.Sold]] }), "getLogs.trades");
  // Graduated + GradTargetSet are both curve-emitted with no indexed token, so
  // we query by topic0 across any address and match back by log.address.
  const grads = await withRetry(() =>
    provider.getLogs({ fromBlock: from, toBlock: to, topics: [[TOPICS.Graduated, TOPICS.GradTargetSet]] }), "getLogs.grads");
  // Merge + order by (block, logIndex) for deterministic application.
  return [...launched, ...trades, ...grads].sort((a, b) =>
    a.blockNumber - b.blockNumber || a.index - b.index);
}

async function applyLog(log) {
  let parsed;
  try { parsed = iface.parseLog(log); } catch { return; }
  if (!parsed) return;
  const ts = await blockTs(log.blockNumber);
  const a = parsed.args;

  if (parsed.name === "Launched") {
    const token = a.token.toLowerCase();
    const curve = a.curve.toLowerCase();
    const pool = a.pool.toLowerCase();
    const { name, symbol } = await nameSymbol(token);
    upsertCoin.run({
      token, curve, pool, dev: a.dev.toLowerCase(), name, symbol,
      launch_block: log.blockNumber, launch_ts: ts, launch_tx: log.transactionHash,
      dev_bought: a.devBought.toString(),
    });
    // Read the curve geometry once (it never changes except gradTarget) + an
    // initial snapshot, so the coin shows correct progress the moment it lands.
    await readGeometry(token, curve, pool);
    await snapshotToken(token, ts);
    return;
  }

  if (parsed.name === "Bought" || parsed.name === "Sold") {
    const buy = parsed.name === "Bought";
    const token = a.token.toLowerCase();
    insertTrade.run({
      tx: log.transactionHash, log_index: log.index,
      token, side: buy ? "buy" : "sell",
      actor: (buy ? a.buyer : a.seller).toLowerCase(),
      eth: (buy ? a.ethIn : a.ethOut).toString(),
      tokens: (buy ? a.tokensOut : a.tokensIn).toString(),
      fee: a.fee.toString(), block: log.blockNumber, ts,
    });
    // The pool moved — flag this token so we re-snapshot it once per chunk.
    return { touched: token, ts };
  }

  if (parsed.name === "GradTargetSet") {
    const curve = log.address.toLowerCase();
    if (!coinByCurve.get(curve)) return;
    setGradTargetByCurve.run({ curve, grad_target: Number(a.targetTick) });
    return;
  }

  if (parsed.name === "Graduated") {
    // Emitted by the curve; log.address is the curve. Only act if we know it.
    const curve = log.address.toLowerCase();
    if (!coinByCurve.get(curve)) return;
    markGraduated.run({
      curve, grad_block: log.blockNumber, grad_ts: ts,
      raised_weth: a.raisedWeth.toString(), bond: a.bond.toLowerCase(),
    });
  }
}

// Read the curve's fixed geometry (ticks) + token0 orientation, once.
async function readGeometry(token, curve, pool) {
  try {
    const c = new ethers.Contract(curve, CURVE, provider);
    const p = new ethers.Contract(pool, POOL, provider);
    const [startTick, minGradTick, gradTick, gradTarget, token0] = await Promise.all([
      withRetry(() => c.startTick(), "curve.startTick", 3),
      withRetry(() => c.minGradTick(), "curve.minGradTick", 3),
      withRetry(() => c.gradTick(), "curve.gradTick", 3),
      withRetry(() => c.gradTarget(), "curve.gradTarget", 3),
      withRetry(() => p.token0(), "pool.token0", 3),
    ]);
    setGeometry.run({
      token, start_tick: Number(startTick), min_grad_tick: Number(minGradTick),
      grad_tick: Number(gradTick), grad_target: Number(gradTarget), token0: token0.toLowerCase(),
    });
  } catch (e) {
    console.warn(`[indexer] geometry read failed for ${token}: ${e.shortMessage || e.message}`);
  }
}

// Refresh one coin's live snapshot (progress + mcap) from its pool tick.
async function snapshotToken(token, ts) {
  const g = coinGeom.get(token);
  if (!g || !g.pool || g.start_tick === null || g.token0 === null) return;
  try {
    const p = new ethers.Contract(g.pool, POOL, provider);
    const slot0 = await withRetry(() => p.slot0(), "pool.slot0", 3);
    const tick = Number(slot0.tick);
    const wethPerToken = priceFromSqrt(slot0.sqrtPriceX96, g.token0);
    setSnapshot.run({
      token, last_tick: tick,
      progress: frac(tick, g.start_tick, g.grad_tick),
      mcap_eth: wethPerToken * TOTAL_SUPPLY, snap_ts: ts,
    });
  } catch (e) {
    console.warn(`[indexer] snapshot failed for ${token}: ${e.shortMessage || e.message}`);
  }
}

let head = 0;
export const getHead = () => head;

// One scan pass. Returns the number of logs applied.
export async function tick() {
  head = await provider.getBlockNumber();
  const safeHead = head - CFG.confirmations;
  if (safeHead < CFG.startBlock) return 0;

  const stored = getCursor();
  // Start at the stored cursor minus a reorg window (re-scan the tip); first run
  // starts at the configured deploy block.
  const reorgWindow = Math.max(CFG.confirmations * 4, 12);
  let from = stored === null ? CFG.startBlock : Math.max(CFG.startBlock, stored - reorgWindow + 1);
  if (from > safeHead) return 0;

  // Delete any trades in the re-scanned window so orphaned-block rows can't linger.
  if (stored !== null) {
    const del = db.transaction(() => purgeTradesFrom.run(from));
    del();
  }

  let applied = 0;
  for (let lo = from; lo <= safeHead; lo += CFG.chunk) {
    const hi = Math.min(lo + CFG.chunk - 1, safeHead);
    const logs = await getLogsRange(lo, hi);
    // Apply sequentially — each log may make its own enrichment RPC calls, and
    // firing them all at once trips the public RPC's rate limit.
    const touched = new Map(); // token -> latest ts, deduped so a busy pool is read once
    for (const log of logs) {
      const r = await applyLog(log);
      if (r?.touched) touched.set(r.touched, r.ts);
    }
    // One snapshot per pool that traded this chunk — bounds RPC to ACTIVITY, not
    // coin count. A pool with 500 trades is still one slot0 read.
    for (const [token, ts] of touched) await snapshotToken(token, ts);
    applied += logs.length;
    setCursor(hi);
  }
  return applied;
}

export async function runLoop() {
  const startFrom = getCursor();
  console.log(`[indexer] rpc=${CFG.rpcUrl}`);
  console.log(`[indexer] factory=${CFG.factory} router=${CFG.router}`);
  console.log(`[indexer] cursor=${startFrom ?? `(fresh, from block ${CFG.startBlock})`}`);
  for (;;) {
    try {
      const n = await tick();
      if (n) console.log(`[indexer] cursor=${getCursor()} head=${head} (+${n} logs)`);
    } catch (e) {
      console.error(`[indexer] tick error: ${e.message || e}`);
    }
    await new Promise((r) => setTimeout(r, CFG.pollMs));
  }
}
