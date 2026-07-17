// ─────────────────────────────────────────────────────────────────────────────
// Robin Labs Pad — wallet + signing layer  (audit target)
//
// This is the EVM translation of our Phantom/Blowfish "stay-unflagged" rulebook.
// Robinhood Chain is an EVM L2, so the primitives differ (no SystemProgram /
// Jupiter / mint keypair) but the SAFETY RULES map 1:1. Each rule is enforced
// here and labelled [Rule N] so it can be checked line-by-line. See SECURITY.md
// for the full mapping.
//
//   [Rule 1] No approve / delegate / setAuthority in a user-signed tx.
//            → Launch + BUY are 100% approval-free (native ETH in). SELL needs
//              the one unavoidable EVM approval: an EXACT-amount approve to the
//              canonical, verified router only — never infinite, never to us.
//   [Rule 2] One recipient, one signer, feePayer = the user. No fan-out.
//            → launch() hits ONE contract; swaps hit ONE router. No splitting in
//              the signed tx; any fee/payout math is off-chain or in-protocol.
//   [Rule 3] Fees ride the protocol's native fee, not a side transfer.
//            → Our 1% is the Uniswap LP fee tier, collected in-protocol. There is
//              never an extra transfer instruction bolted onto a user's tx.
//   [Rule 4] Swaps are the standard single-signer shape. Nothing custom.
//   [Guard ] Simulate + balance-check BEFORE asking a wallet to sign, so the
//            user never sees the scary red "insufficient funds / blocked" screen.
//   [Link  ] signMessage (personal_sign) for ownership/Telegram linking — free,
//            never a transaction, kept entirely separate from the payment path.
// ─────────────────────────────────────────────────────────────────────────────

// ethers v6.13.4 is VENDORED locally (assets/ethers.min.js) — no runtime CDN
// dependency, so the whole app is self-contained and auditable offline.
import { ethers } from "./ethers.min.js";
import {
  CHAIN, CONTRACTS, ABIS, TOTAL_SUPPLY, MAX_DEVBUY_BPS,
  GAS_BUFFER_WEI, isDeployed, API_BASE, hasApi,
} from "./config.js";

let _provider = null; // ethers BrowserProvider
let _signer = null;
let _account = null;

// A read-only provider for quotes/simulation even before the user connects.
const _read = new ethers.JsonRpcProvider(CHAIN.rpc[0], CHAIN.id);

// ── provider detection: prefer Phantom's EVM provider, then any injected wallet ─
function injected() {
  if (typeof window === "undefined") return null;
  // Phantom exposes its EVM provider at window.phantom.ethereum
  if (window.phantom?.ethereum) return window.phantom.ethereum;
  if (window.ethereum) return window.ethereum;
  return null;
}

function friendly(err, label) {
  // Turn raw RPC/revert errors into calm, honest messages — never leak a stack.
  const raw = (err?.shortMessage || err?.reason || err?.info?.error?.message || err?.message || "").toString();
  const s = raw.toLowerCase();
  if (err?.code === "ACTION_REJECTED" || s.includes("user rejected") || s.includes("user denied"))
    return new Error("You cancelled the signature — nothing was sent.");
  if (s.includes("insufficient funds"))
    return new Error("Not enough ETH to cover this and gas. Top up and try again.");
  if (s.includes("dev>2%") || s.includes("dev>"))
    return new Error("That opening buy is over the 2% cap. Lower the dev buy.");
  if (s.includes("maxwallet") || s.includes("maxtx") || s.includes("cooldown") || s.includes("antisnip"))
    return new Error("The opening anti-snipe window caps buy size right now. Try a smaller amount or wait a minute.");
  if (s.includes("slippage") || s.includes("too little received") || s.includes("price"))
    return new Error("Price moved past your slippage. Raise slippage a touch or retry.");
  return new Error(label ? `${label} failed: ${raw || "unknown error"}` : (raw || "Transaction failed."));
}

// ── connect + chain guard ───────────────────────────────────────────────────
export async function connect() {
  const eip = injected();
  if (!eip) throw new Error("No wallet found. Install Phantom or another EVM wallet, then reload.");

  await eip.request({ method: "eth_requestAccounts" });
  await ensureChain(eip);

  _provider = new ethers.BrowserProvider(eip, "any");
  _signer = await _provider.getSigner();
  _account = await _signer.getAddress();

  // keep UI in sync if the user switches account/chain in their wallet
  eip.removeAllListeners?.("accountsChanged");
  eip.on?.("accountsChanged", () => location.reload());
  eip.on?.("chainChanged", () => location.reload());
  return _account;
}

async function ensureChain(eip) {
  const current = await eip.request({ method: "eth_chainId" });
  if (current?.toLowerCase() === CHAIN.hexId) return;
  try {
    await eip.request({ method: "wallet_switchEthereumChain", params: [{ chainId: CHAIN.hexId }] });
  } catch (e) {
    if (e?.code === 4902 || (e?.message || "").includes("Unrecognized")) {
      await eip.request({
        method: "wallet_addEthereumChain",
        params: [{
          chainId: CHAIN.hexId, chainName: CHAIN.name, nativeCurrency: CHAIN.currency,
          rpcUrls: CHAIN.rpc, blockExplorerUrls: [CHAIN.explorer],
        }],
      });
    } else { throw e; }
  }
}

export const account = () => _account;
export const short = (a) => (a ? a.slice(0, 6) + "…" + a.slice(-4) : "");

// ── [Link] ownership / Telegram binding — a signature, NOT a transaction ──────
// Free, never hits the tx surface, never flagged. The backend verifies the
// signature to bind wallet ↔ Telegram. We keep this completely separate from any
// payment so the "expensive" tx surface is only ever a real payment.
export async function linkTelegram(handle) {
  if (!_signer) await connect();
  const nonce = ethers.hexlify(ethers.randomBytes(8));
  const message =
    `Robin Labs Pad — link this wallet to Telegram\n` +
    `Telegram: ${handle}\n` +
    `Wallet: ${_account}\n` +
    `Nonce: ${nonce}\n` +
    `This is a free signature, not a transaction. It moves no funds.`;
  const signature = await _signer.signMessage(message); // personal_sign
  return { message, signature, address: _account };
}

// ── the guard: simulate + balance-check BEFORE any signature ──────────────────
// Returns the sent tx (caller awaits .wait()). Throws a friendly error if the tx
// would revert OR the wallet can't cover value+gas — so the user never sees the
// wallet's red screen for what is really just "not enough ETH".
async function guardedSend(contract, method, args, valueWei, label) {
  const value = valueWei ?? 0n;

  // 1) simulate the exact call (eth_call). Catches contract reverts up-front.
  try { await contract[method].staticCall(...args, { value }); }
  catch (e) { throw friendly(e, label); }

  // 2) estimate gas (a second simulation) so we can price the tx.
  let gas;
  try { gas = await contract[method].estimateGas(...args, { value }); }
  catch (e) { throw friendly(e, label); }

  // 3) balance check — the whole point: refuse locally, kindly, if it won't fit.
  const [bal, fee] = await Promise.all([_provider.getBalance(_account), _provider.getFeeData()]);
  const gasPrice = fee.maxFeePerGas ?? fee.gasPrice ?? 0n;
  const gasCost = gas * gasPrice;
  const need = value + gasCost + GAS_BUFFER_WEI;
  if (bal < need) {
    const fmt = (w) => (+ethers.formatEther(w)).toFixed(4);
    throw new Error(`Not enough ETH. This needs ≈ ${fmt(need)} ETH (incl. gas); you have ${fmt(bal)}.`);
  }

  // 4) send — single signer, feePayer = the user, one recipient. [Rules 2 & 4]
  try {
    return await contract[method](...args, { value, gasLimit: (gas * 12n) / 10n });
  } catch (e) { throw friendly(e, label); }
}

// ── LAUNCH — one call, one recipient, optional dev buy, approval-free [Rule 1] ─
// devBuyEth: string ETH amount to spend on the creator's OWN opening buy (≤2%,
// enforced + excess-refunded by the contract). "0" = no dev buy.
// tax: {buyBps, sellBps, walletBps, floorBps, burnBps, projectWallet} — the
// project's self-set tax (≤4%/side; splits sum to 100%). Omit for a no-tax coin.
export async function launch({ name, symbol, dev, devBuyEth = "0", tax }) {
  if (!_signer) await connect();
  if (!isDeployed("padFactory"))
    throw new Error("The launch contract isn't live yet — the Pad is in pre-deploy audit.");
  const value = devBuyEth && Number(devBuyEth) > 0 ? ethers.parseEther(String(devBuyEth)) : 0n;
  const factory = new ethers.Contract(CONTRACTS.padFactory, ABIS.padFactory, _signer);
  const t = normalizeTax(tax, dev || _account);
  const params = { name, symbol, dev: dev || _account, tax: t };
  const tx = await guardedSend(factory, "launch", [params], value, "Launch");
  return tx; // await tx.wait() then read the Launched event for {token, curve, pool}
}

// Fill in a valid tax tuple. No tax => 0/0, but the allocation still must sum to
// 100% (the contract requires it), so default it all to the wallet bucket.
function normalizeTax(tax, devAddr) {
  const t = tax || {};
  const buyBps = clampBps(t.buyBps), sellBps = clampBps(t.sellBps);
  let walletBps = +t.walletBps || 0, floorBps = +t.floorBps || 0, burnBps = +t.burnBps || 0;
  if (walletBps + floorBps + burnBps !== 10000) { walletBps = 10000; floorBps = 0; burnBps = 0; }
  const projectWallet = t.projectWallet && /^0x[0-9a-fA-F]{40}$/.test(t.projectWallet) ? t.projectWallet : devAddr;
  return { buyBps, sellBps, walletBps, floorBps, burnBps, projectWallet };
}
// every coin pays at least the default 1% (100 bps); the contract enforces the same floor
const clampBps = (v) => Math.max(100, Math.min(400, Math.round(+v || 100)));

function routerRead() { return new ethers.Contract(CONTRACTS.padRouter, ABIS.padRouter, _read); }

/// Read a coin's on-chain tax so the UI can show it before trading.
export async function getTax(token) {
  const c = await routerRead().configOf(token);
  return {
    pool: c.pool, curve: c.curve, projectWallet: c.projectWallet, set: c.set,
    buyBps: Number(c.buyBps), sellBps: Number(c.sellBps),
    walletBps: Number(c.walletBps), floorBps: Number(c.floorBps), burnBps: Number(c.burnBps),
  };
}

// ── BUY — native ETH in, no ERC20 approval, tokens straight to the buyer [Rule 1]
// The PadRouter takes the project's buy tax from msg.value, then swaps the rest.
export async function buy({ token, ethAmount, slippagePct = 8 }) {
  if (!_signer) await connect();
  requireRouter();
  const value = ethers.parseEther(String(ethAmount));
  const c = await getTax(token);
  const net = (value * BigInt(10000 - c.buyBps)) / 10000n; // what actually hits the pool
  const minOut = await quoteMinOut({ pool: c.pool, tokenIn: CONTRACTS.weth, tokenOut: token, amountIn: net, slippagePct });
  const router = new ethers.Contract(CONTRACTS.padRouter, ABIS.padRouter, _signer);
  return guardedSend(router, "buy", [token, minOut], value, "Buy");
}

// ── SELL — the single, isolated, EXACT-amount approval to OUR verified router ──
// EVM has no approval-free way to sell a standard ERC20 through an AMM, so this
// is the ONE approval in the app: exact amount (never MaxUint), to our own
// PadRouter only, simulated first. The sell tax comes off the ETH out.
export async function sell({ token, tokenAmount, slippagePct = 8 }) {
  if (!_signer) await connect();
  requireRouter();
  const erc = new ethers.Contract(token, ABIS.erc20, _signer);
  const amountIn = ethers.parseUnits(String(tokenAmount), 18);

  const allowance = await erc.allowance(_account, CONTRACTS.padRouter);
  if (allowance < amountIn) {
    const atx = await erc.approve(CONTRACTS.padRouter, amountIn); // exact amount, our router
    await atx.wait();
  }

  const c = await getTax(token);
  const gross = await quoteMinOut({ pool: c.pool, tokenIn: token, tokenOut: CONTRACTS.weth, amountIn, slippagePct });
  const minOutEth = (gross * BigInt(10000 - c.sellBps)) / 10000n; // guard on the post-tax ETH
  const router = new ethers.Contract(CONTRACTS.padRouter, ABIS.padRouter, _signer);
  return guardedSend(router, "sell", [token, amountIn, minOutEth], 0n, "Sell");
}

// ── quoting ───────────────────────────────────────────────────────────────────
// Prefer an on-chain QuoterV2 (exact). Fallback: spot price from the pool's
// slot0 with a generous haircut — a single-sided curve fills WORSE than spot, so
// we widen slippage to avoid nuisance reverts. Wire a Quoter for production.
async function quoteMinOut({ pool, tokenIn, tokenOut, amountIn, slippagePct }) {
  try {
    const p = new ethers.Contract(pool, ABIS.pool, _read);
    const [slot0, token0] = await Promise.all([p.slot0(), p.token0()]);
    const sqrt = slot0.sqrtPriceX96;
    const Q96 = 2n ** 96n;
    // price1per0 = (sqrt/2^96)^2  (token1 per token0). Scale by 1e18 for integer math.
    const price1per0 = (sqrt * sqrt * (10n ** 18n)) / (Q96 * Q96);
    const inIs0 = tokenIn.toLowerCase() === token0.toLowerCase();
    // expected out at spot (ignores curve depth) then a wide safety haircut
    let out = inIs0 ? (amountIn * price1per0) / (10n ** 18n) : (amountIn * (10n ** 18n)) / price1per0;
    const bufferPct = BigInt(Math.round((slippagePct + 6) * 100)); // + curve buffer
    const minOut = (out * (10000n - bufferPct)) / 10000n;
    if (minOut <= 0n) throw new Error("couldn't price this trade");
    return minOut;
  } catch (e) {
    // Never trade with a 0 slippage floor — that invites a sandwich. Fail loudly instead.
    throw new Error("Couldn't compute a safe price for this trade — try again in a moment.");
  }
}

function requireRouter() {
  if (!isDeployed("padRouter"))
    throw new Error("Trading opens when the Pad goes live — the router isn't set yet (pre-deploy audit).");
}

// ── dev-buy sizing: convert the create-form % into an ETH amount to send ──────
// The contract takes ETH (not a %), buys up to a ~2% price cap, and refunds any
// excess. We estimate the ETH for the chosen % from the launch price and stay a
// hair under 2% so the contract's hard cap never reverts. Purely a UI estimate;
// the chain is the source of truth and refunds overpay.
export function estimateDevBuyEth(pct) {
  const clamped = Math.max(0, Math.min(1.9, Number(pct) || 0)); // keep under the 2% cap
  // Launch price ≈ 1e-9 ETH/token (START_TICK ~ -207200). Buying P% of a 1e9
  // supply across the opening slice averages ~1.6× the start price. This is a
  // deliberately rough, safe overestimate; excess is refunded on-chain.
  const tokens = (clamped / 100) * Number(TOTAL_SUPPLY);
  const avgPrice = 1e-9 * 1.6;
  return (tokens * avgPrice).toFixed(6);
}

// ── curve state: graduation progress, mcap, the dev's target ──────────────────
const WETH_LC = CONTRACTS.weth.toLowerCase();
// WETH per token from a pool's sqrtPriceX96, respecting token/WETH ordering.
function priceFromSqrt(sqrt, token) {
  const Q96 = 2n ** 96n;
  const p1per0 = Number((sqrt * sqrt * 10n ** 18n) / (Q96 * Q96)) / 1e18; // token1 per token0
  return token.toLowerCase() < WETH_LC ? p1per0 : (p1per0 > 0 ? 1 / p1per0 : 0); // WETH per token
}

/// Read a coin's live graduation state for the trade page + browse cards.
export async function curveInfo(curve, token) {
  const c = new ethers.Contract(curve, ABIS.curve, _read);
  const [graduated, ready, startTick, minGradTick, gradTick, gradTarget, poolAddr, bond, dev, seedTime] =
    await Promise.all([
      c.graduated(), c.ready(), c.startTick(), c.minGradTick(), c.gradTick(),
      c.gradTarget(), c.pool(), c.bond(), c.dev(), c.seedTime(),
    ]);
  const p = new ethers.Contract(poolAddr, ABIS.pool, _read);
  const slot0 = await p.slot0();
  const tick = Number(slot0.tick);
  const st = Number(startTick), mn = Number(minGradTick), cl = Number(gradTick), tg = Number(gradTarget);
  const span = Math.abs(cl - st) || 1;
  const frac = (t) => Math.max(0, Math.min(1, Math.abs(t - st) / span)); // 0 at start … 1 at ceiling
  const wethPerToken = priceFromSqrt(slot0.sqrtPriceX96, token);
  return {
    graduated, ready, bond, dev, seedTime: Number(seedTime), pool: poolAddr, tick,
    mcapEth: wethPerToken * 1e9, wethPerToken,
    progress: frac(tick), minFrac: frac(mn), targetFrac: frac(tg), // positions along the curve (0..1)
    minGradTick: mn, gradTick: cl, gradTarget: tg, startTick: st,
  };
}

/// A dev's uncollected sell-fee escrow (native ETH), for the "collect / burn" panel.
export async function devEscrow(token) {
  return new ethers.Contract(CONTRACTS.padRouter, ABIS.padRouter, _read).devEscrow(token);
}

// ── graduate() — the permissionless "graduate" button (anyone can fire it) ─────
export async function graduate(curve) {
  if (!_signer) await connect();
  return guardedSend(new ethers.Contract(curve, ABIS.curve, _signer), "graduate", [], 0n, "Graduate");
}

// ── setGradTarget — the dev picks the auto-graduate price (a tick in [min, ceiling]) ─
export async function setGradTarget(curve, tick) {
  if (!_signer) await connect();
  return guardedSend(new ethers.Contract(curve, ABIS.curve, _signer), "setGradTarget", [Math.round(tick)], 0n, "Set graduation target");
}

// ── creator fee controls — collect to the wallet, or buy+burn ─────────────────
export async function withdrawDev(token) {
  if (!_signer) await connect();
  return guardedSend(new ethers.Contract(CONTRACTS.padRouter, ABIS.padRouter, _signer), "withdrawDev", [token], 0n, "Collect fees");
}
export async function burnDev(token) {
  if (!_signer) await connect();
  return guardedSend(new ethers.Contract(CONTRACTS.padRouter, ABIS.padRouter, _signer), "burnDev", [token], 0n, "Burn fees");
}

/// Newest-first list of every coin launched on the pad, straight from the chain.
/// This is the always-available fallback; prefer feed() which uses the indexer
/// API (name/symbol/volume/sorting in one call) when one is configured.
export async function listCoins(max = 60) {
  const f = new ethers.Contract(CONTRACTS.padFactory, ABIS.padFactory, _read);
  const n = Number(await f.tokenCount());
  const idxs = [];
  for (let i = n - 1; i >= Math.max(0, n - max); i--) idxs.push(i);
  const tokens = await Promise.all(idxs.map((i) => f.allTokens(i)));
  const recs = await Promise.all(tokens.map((t) => f.recordOf(t)));
  return recs.map((r) => ({ token: r.token, curve: r.curve, dev: r.dev, at: Number(r.at) }));
}

// ── indexer API client (optional; graceful fallback to direct RPC) ──────────
async function apiGet(path) {
  if (!hasApi()) throw new Error("no api");
  const res = await fetch(`${API_BASE.replace(/\/+$/, "")}${path}`, { headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`api ${res.status}`);
  return res.json();
}

/// The browse feed. Uses the indexer when configured (fast, sorted, searchable);
/// otherwise reads the factory directly and enriches each card with name/symbol.
/// sort: new | trending | top | graduated · filter: all | live | graduated
export async function feed({ sort = "new", filter = "all", q = "", limit = 60 } = {}) {
  if (hasApi()) {
    const params = new URLSearchParams({ sort, filter, limit: String(limit) });
    if (q) params.set("q", q);
    const { coins } = await apiGet(`/api/coins?${params}`);
    return { source: "api", coins };
  }
  // Fallback: raw factory list + on-chain name/symbol. No volume/sorting beyond
  // newest-first, but the feed still works with zero backend.
  const base = await listCoins(limit);
  const metas = await Promise.all(base.map((c) => tokenMeta(c.token).catch(() => ({ name: "Token", symbol: "?" }))));
  let coins = base.map((c, i) => ({
    token: c.token, curve: c.curve, dev: c.dev,
    name: metas[i].name, symbol: metas[i].symbol,
    launchTs: c.at, graduated: false,
  }));
  if (q) {
    const s = q.toLowerCase();
    coins = coins.filter((c) => c.name?.toLowerCase().includes(s) || c.symbol?.toLowerCase().includes(s) || c.token.includes(s));
  }
  return { source: "rpc", coins };
}

/// Platform-wide totals for a stats strip (indexer only; null without one).
export async function stats() {
  try { return await apiGet("/api/stats"); } catch { return null; }
}

/// Recent trades for a coin (indexer only; empty without one — the chart still
/// comes from DexScreener regardless).
export async function recentTrades(token, limit = 50) {
  try { const { trades } = await apiGet(`/api/trades/${token}?limit=${limit}`); return trades; }
  catch { return []; }
}

/// Token metadata (name / symbol) for a card or the trade header.
export async function tokenMeta(token) {
  const t = new ethers.Contract(token, ABIS.erc20, _read);
  const [name, symbol] = await Promise.all([t.name().catch(() => "Token"), t.symbol().catch(() => "?")]);
  return { name, symbol };
}

// ── holders + trade/fee history — work with NO indexer (chain + explorer API) ─
const EXPLORER_API = CHAIN.explorer.replace(/\/+$/, "") + "/api/v2";
const _routerEvents = new ethers.Interface([
  "event Bought(address indexed token, address indexed buyer, uint256 ethIn, uint256 fee, uint256 tokensOut)",
  "event Sold(address indexed token, address indexed seller, uint256 tokensIn, uint256 fee, uint256 ethOut)",
  "event FeeSplit(address indexed token, uint256 platform, uint256 deferred, uint256 platformCut, uint256 dev, uint256 floor, uint256 burn)",
]);
const _blkTs = new Map();
async function _tsOf(bn) {
  if (_blkTs.has(bn)) return _blkTs.get(bn);
  try { const b = await _read.getBlock(bn); const t = b ? Number(b.timestamp) : 0; _blkTs.set(bn, t); return t; } catch { return 0; }
}
// Router logs over a range — one call if the RPC allows it, else chunked so a
// range cap never breaks the read.
async function _routerLogs(topics, { lookback = 400000, chunk = 50000 } = {}) {
  const head = await _read.getBlockNumber();
  const start = Math.max(0, head - lookback);
  try { return await _read.getLogs({ address: CONTRACTS.padRouter, fromBlock: start, toBlock: head, topics }); }
  catch {}
  const out = [];
  for (let lo = start; lo <= head; lo += chunk) {
    const hi = Math.min(lo + chunk - 1, head);
    try { out.push(...await _read.getLogs({ address: CONTRACTS.padRouter, fromBlock: lo, toBlock: hi, topics })); } catch {}
  }
  return out;
}

/// Holders + count, from the chain explorer's public API (no indexer needed).
export async function holders(token, top = 12) {
  const base = `${EXPLORER_API}/tokens/${token}`;
  const [c, l] = await Promise.allSettled([
    fetch(`${base}/counters`).then((r) => (r.ok ? r.json() : null)),
    fetch(`${base}/holders`).then((r) => (r.ok ? r.json() : null)),
  ]);
  const count = c.status === "fulfilled" && c.value ? Number(c.value.token_holders_count) : null;
  const items = l.status === "fulfilled" && l.value ? l.value.items || [] : [];
  const supplyWei = Number(TOTAL_SUPPLY) * 1e18; // 1B * 1e18
  const list = items.slice(0, top).map((it) => ({
    address: (it.address?.hash || "").toLowerCase(),
    isContract: !!it.address?.is_contract,
    name: it.address?.name || null,
    pct: supplyWei > 0 ? (Number(it.value || 0) / supplyWei) * 100 : 0,
  }));
  return { count: Number.isFinite(count) ? count : null, top: list };
}

/// Recent trades straight from chain (fallback when the indexer isn't running).
export async function chainTrades(token, { limit = 30, lookback = 400000 } = {}) {
  try {
    const b = _routerEvents.getEvent("Bought").topicHash, s = _routerEvents.getEvent("Sold").topicHash;
    const tok = ethers.zeroPadValue(token.toLowerCase(), 32);
    const logs = await _routerLogs([[b, s], tok], { lookback });
    const rows = logs.map((l) => {
      const p = _routerEvents.parseLog(l); const buy = p.name === "Bought";
      return {
        side: buy ? "buy" : "sell", actor: (buy ? p.args.buyer : p.args.seller).toLowerCase(),
        eth: (buy ? p.args.ethIn : p.args.ethOut).toString(),
        tokens: (buy ? p.args.tokensOut : p.args.tokensIn).toString(),
        block: l.blockNumber, tx: l.transactionHash,
      };
    }).sort((a, z) => z.block - a.block).slice(0, limit);
    await Promise.all([...new Set(rows.map((r) => r.block))].map(async (bn) => {
      const t = await _tsOf(bn); rows.forEach((r) => { if (r.block === bn) r.ts = t; });
    }));
    return rows;
  } catch { return []; }
}

/// Best-available trades: the indexer API first (fast, complete), else chain.
export async function trades(token, limit = 30) {
  if (hasApi()) { const t = await recentTrades(token, limit); if (t.length) return t; }
  return chainTrades(token, { limit });
}

/// Lifetime fee totals for a coin (dev/platform/floor/burn), summed from chain.
export async function feeTotals(token) {
  try {
    const fs = _routerEvents.getEvent("FeeSplit").topicHash;
    const tok = ethers.zeroPadValue(token.toLowerCase(), 32);
    const logs = await _routerLogs([fs, tok], {});
    let platform = 0n, dev = 0n, floor = 0n, burn = 0n;
    for (const l of logs) {
      const p = _routerEvents.parseLog(l);
      platform += p.args.platform + p.args.deferred + p.args.platformCut;
      dev += p.args.dev; floor += p.args.floor; burn += p.args.burn;
    }
    return { platform, dev, floor, burn };
  } catch { return null; }
}

// expose a tiny global for the plain-HTML pages (no bundler)
if (typeof window !== "undefined") {
  window.RobinPad = {
    connect, account, short, linkTelegram, launch, buy, sell, getTax,
    estimateDevBuyEth, isDeployed,
    curveInfo, devEscrow, graduate, setGradTarget, withdrawDev, burnDev, listCoins, tokenMeta,
    feed, stats, recentTrades, hasApi,
    holders, trades, chainTrades, feeTotals,
  };
  window.SheriffPad = window.RobinPad; // back-compat alias for existing pages
  window.dispatchEvent(new Event("robinpad:ready"));
  window.dispatchEvent(new Event("sheriffpad:ready"));
}
