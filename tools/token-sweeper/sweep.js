// ─────────────────────────────────────────────────────────────────────────────
// Robin token sweeper — fund → collect → refund
//
// Consolidates funds OUT of many bot wallets you control and INTO one main
// wallet. You give it a token contract address (the "CA"). For every wallet
// whose private key it finds in your distributor dir it runs three phases:
//
//   FUND    — from a dedicated funder wallet, top up each token-holding wallet
//             with just enough ETH to pay for one token transfer (only the
//             shortfall; wallets that already have gas are skipped).
//   COLLECT — each wallet signs a transfer of its FULL token balance to the
//             main wallet. (This can't be batched — ERC-20 needs each wallet's
//             own signature — so it's ~one tx per wallet.)
//   REFUND  — sweep the leftover native ETH out of every wallet to the main
//             wallet (recovers the gas float + any pre-existing ETH).
//
// It only moves your own money between wallets you hold the keys to. It signs
// plain value transfers and plain ERC-20 transfer() calls — no approvals to
// third parties, no contract calls beyond the token's own transfer().
//
// SAFETY MODEL
//   • DRY-RUN IS THE DEFAULT. Nothing is sent unless you pass --execute. A
//     dry-run scans balances and prints the whole plan (how many wallets, how
//     much ETH to fund, how much token to collect, funder balance vs need).
//   • IDEMPOTENT BY CONSTRUCTION. Every run reads live on-chain balances and
//     acts only on what's left to do, so a crashed run resumes by just being
//     re-run: collected wallets (token balance 0) and funded wallets (enough
//     gas) are skipped automatically. No mutable state file to corrupt.
//   • The funder sends are strictly nonce-ordered (no races, no gaps). Collect
//     and refund run per-wallet with bounded concurrency.
//   • Private keys are NEVER printed or logged — only addresses, amounts,
//     tx hashes. Every send is appended to an audit log (--log).
//   • The native (fund/refund) sends pin gasLimit + fee so value = balance − gas
//     exactly; a refund can always afford itself, at worst leaving wei of dust.
//
// Chain defaults are Robinhood Chain (Arbitrum Orbit L2, chainId 4663).
// Requires: Node 18+ and `npm install` in this folder (pulls ethers v6).
// ─────────────────────────────────────────────────────────────────────────────

import { ethers } from "ethers";
import { readFileSync, readdirSync, statSync, existsSync, appendFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";

// Optionally load a local .env (if dotenv is installed). Env still works via
// plain `export`/`--flag` if it isn't. Never commit the .env — it's gitignored.
try { await import("dotenv/config"); } catch { /* dotenv optional */ }

// ── defaults ─────────────────────────────────────────────────────────────────
const DEFAULTS = {
  rpcUrl: "https://robinhoodchain.blockscout.com/api/eth-rpc",
  chainId: 4663,
  keysPath: "/root/robin-dist/robin-distributor-contract/",
  derivePath: "m/44'/60'/0'/0", // parent node; children 0..count-1 are the wallets
  mnemonicCount: 50,            // how many addresses to derive if a seed phrase is found
  gasBufferMult: 1.25,          // pad estimated gas by this (funding must not underfund)
  concurrency: 5,               // collect/refund wallets in flight (funder stays sequential)
  confirmations: 1,             // receipt confirmations to wait for
  retries: 4,                   // per on-chain action, with exponential backoff
  delayMs: 120,                 // pause between funder sends / pool tasks (rate-limit ease)
  rpcTimeout: 30000,            // per-request timeout (ms) so a dead RPC fails fast
  logFile: "sweep-audit.jsonl", // append-only record of every send
  fundReserve: 60000n,          // min gas units assumed for a token transfer if estimate fails
  // Multicall3 is deployed + verified on Robinhood Chain at the canonical
  // deterministic address, so use it by default to batch the balance scan.
  // Falls back to per-wallet reads automatically if the call ever fails, and
  // --no-multicall disables it.
  multicall: "0xcA11bde05977b3631167028862bE2a173976CA11",
};

const ERC20_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function transfer(address to, uint256 amount) returns (bool)",
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
];
// Multicall3 (optional) — same deterministic address on most chains; only used
// if --multicall/MULTICALL3 is set, purely to batch balance READS. Never signs.
const MULTICALL3_ABI = [
  "function aggregate3(tuple(address target, bool allowFailure, bytes callData)[] calls) view returns (tuple(bool success, bytes returnData)[])",
  "function getEthBalance(address addr) view returns (uint256)",
];

// ── tiny helpers ─────────────────────────────────────────────────────────────
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const short = (a) => (a ? `${a.slice(0, 6)}…${a.slice(-4)}` : "?");
const isHexKey = (s) => /^0x[0-9a-fA-F]{64}$/.test(s);
const looksLikeKey = (s) => isHexKey(s) || /^[0-9a-fA-F]{64}$/.test(s);
const norm = (k) => (k.startsWith("0x") ? k : "0x" + k);
const BIP39_LEN = new Set([12, 15, 18, 21, 24]);
const mulDiv = (x, pctTimes100) => (x * BigInt(Math.round(pctTimes100 * 100))) / 100n;

function log(...a) { console.log(...a); }
function warn(...a) { console.warn("  ! ", ...a); }

async function withRetry(label, fn, retries = DEFAULTS.retries) {
  let last;
  for (let i = 0; i <= retries; i++) {
    try { return await fn(); }
    catch (e) {
      last = e;
      const msg = (e?.shortMessage || e?.message || "").toLowerCase();
      if (msg.includes("insufficient funds") || msg.includes("transfer amount exceeds") ||
          msg.includes("nonce too low") || e?.code === "INVALID_ARGUMENT") break;
      if (i < retries) {
        const wait = 2000 * 2 ** i;
        warn(`${label} failed (${e?.shortMessage || e?.message}); retry ${i + 1}/${retries} in ${wait / 1000}s`);
        await sleep(wait);
      }
    }
  }
  throw last;
}

// bounded-concurrency map; a worker that throws yields { error } for that item.
async function mapPool(items, limit, worker, delayMs = 0) {
  const results = new Array(items.length);
  let i = 0;
  const runners = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (i < items.length) {
      const idx = i++;
      try { results[idx] = await worker(items[idx], idx); }
      catch (e) { results[idx] = { error: e }; }
      if (delayMs) await sleep(delayMs);
    }
  });
  await Promise.all(runners);
  return results;
}

// ── config from CLI + env ──────────────────────────────────────────────────────
function parseConfig(argv) {
  const args = argv.slice(2);
  const flags = new Set();
  const opts = {};
  const positionals = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      if (eq !== -1) opts[a.slice(2, eq)] = a.slice(eq + 1);
      else if (args[i + 1] && !args[i + 1].startsWith("--")) opts[a.slice(2)] = args[++i];
      else flags.add(a.slice(2));
    } else positionals.push(a);
  }
  const env = process.env;
  const tokensRaw = opts.token || opts.tokens || env.TOKENS || positionals.join(",");
  const tokens = tokensRaw.split(",").map((t) => t.trim()).filter(Boolean);

  // phases: default all three; --phases collect,refund to subset; convenience flags too
  let phases = (opts.phases || env.PHASES || "fund,collect,refund").split(",").map((s) => s.trim()).filter(Boolean);
  if (flags.has("collect-only")) phases = ["collect"];
  if (flags.has("no-fund")) phases = phases.filter((p) => p !== "fund");
  if (flags.has("no-refund")) phases = phases.filter((p) => p !== "refund");
  const phase = (p) => phases.includes(p);

  return {
    rpcUrl: opts.rpc || env.RPC_URL || DEFAULTS.rpcUrl,
    chainId: Number(opts["chain-id"] || env.CHAIN_ID || DEFAULTS.chainId),
    dest: opts.dest || opts.to || env.DEST || env.MAIN_WALLET || "",
    keysPath: opts.keys || env.KEYS || env.KEYS_DIR || DEFAULTS.keysPath,
    funderKey: env.FUNDER_KEY || opts["funder-key"] || "",
    funderKeyfile: opts["funder-keyfile"] || env.FUNDER_KEYFILE || "",
    tokens,
    phases, phase,
    multicall: flags.has("no-multicall") ? "" : (opts.multicall || env.MULTICALL3 || DEFAULTS.multicall),
    mnemonicCount: Number(opts.count || env.MNEMONIC_COUNT || DEFAULTS.mnemonicCount),
    derivePath: opts.path || env.DERIVE_PATH || DEFAULTS.derivePath,
    keystorePassword: env.KEYSTORE_PASSWORD || "",
    gasBufferMult: Number(opts["gas-buffer"] || env.GAS_BUFFER_MULT || DEFAULTS.gasBufferMult),
    concurrency: Math.max(1, Number(opts.concurrency || env.CONCURRENCY || DEFAULTS.concurrency)),
    delayMs: Number(opts.delay ?? env.DELAY_MS ?? DEFAULTS.delayMs),
    rpcTimeout: Number(opts["rpc-timeout"] || env.RPC_TIMEOUT || DEFAULTS.rpcTimeout),
    logFile: opts.log || env.LOG_FILE || DEFAULTS.logFile,
    minToken: opts["min-token"] || env.MIN_TOKEN || "0",
    limit: Number(opts.limit || env.LIMIT || 0),
    maxFund: opts["max-fund"] || env.MAX_FUND || "",
    execute: flags.has("execute"),
    yes: flags.has("yes"),
    allowPartial: flags.has("allow-partial"),
    verbose: flags.has("verbose"),
    list: flags.has("list"),
    help: flags.has("help") || flags.has("h"),
  };
}

// ── key loading (auto-detect) — unchanged, battle-tested ────────────────────────
async function loadWallets(pathStr, cfg) {
  const root = resolve(pathStr);
  if (!existsSync(root)) throw new Error(`keys path does not exist: ${root}`);
  const files = [];
  (function walk(p, depth) {
    const st = statSync(p);
    if (st.isDirectory()) {
      if (depth > 3) return;
      for (const name of readdirSync(p)) {
        if (name === "node_modules" || name === ".git") continue;
        walk(join(p, name), depth + 1);
      }
    } else if (st.isFile()) files.push(p);
  })(root, 0);

  const found = [];
  for (const file of files) {
    let text;
    try { text = readFileSync(file, "utf8"); } catch { continue; }
    const trimmed = text.trim();
    if (!trimmed) continue;
    let parsed = null;
    try { parsed = JSON.parse(trimmed); } catch { /* not json */ }
    if (parsed !== null) harvestJson(parsed, found, file);
    else harvestText(trimmed, found, file);
  }

  const byAddr = new Map();
  const add = (signer, src) => {
    const addr = signer.address.toLowerCase();
    if (!byAddr.has(addr)) byAddr.set(addr, { signer, address: signer.address, src });
  };
  for (const f of found) {
    try {
      if (f.key) add(new ethers.Wallet(norm(f.key)), f.src);
      else if (f.mnemonic) {
        const count = f.count || cfg.mnemonicCount;
        const path = f.path || cfg.derivePath;
        const parent = ethers.HDNodeWallet.fromPhrase(f.mnemonic, "", path);
        for (let i = 0; i < count; i++) add(parent.deriveChild(i), `${f.src} [${path}/${i}]`);
      } else if (f.keystore) {
        if (!cfg.keystorePassword) { warn(`keystore ${f.src} skipped (set KEYSTORE_PASSWORD to use it)`); continue; }
        add(await ethers.Wallet.fromEncryptedJson(f.keystore, cfg.keystorePassword), f.src);
      }
    } catch (e) { warn(`could not load a key from ${f.src}: ${e?.shortMessage || e?.message}`); }
  }
  return [...byAddr.values()];
}

function harvestJson(node, out, src, depth = 0) {
  if (depth > 6 || node == null) return;
  if (typeof node === "string") {
    if (looksLikeKey(node)) out.push({ key: node, src });
    else if (BIP39_LEN.has(node.trim().split(/\s+/).length) && ethers.Mnemonic.isValidMnemonic(node.trim()))
      out.push({ mnemonic: node.trim(), src });
    return;
  }
  if (Array.isArray(node)) { for (const v of node) harvestJson(v, out, src, depth + 1); return; }
  if (typeof node === "object") {
    const mn = node.mnemonic || node.seed || node.phrase;
    if (typeof mn === "string" && ethers.Mnemonic.isValidMnemonic(mn.trim()))
      out.push({ mnemonic: mn.trim(), count: Number(node.count) || undefined, path: node.path || node.derivePath, src });
    for (const field of ["privateKey", "private_key", "priv", "pk", "key", "secret", "sk"]) {
      const v = node[field];
      if (typeof v === "string" && looksLikeKey(v)) { out.push({ key: v, address: node.address, src }); break; }
    }
    if ((node.crypto || node.Crypto) && (node.version || node.ciphertext || node.crypto?.ciphertext))
      out.push({ keystore: JSON.stringify(node), src });
    for (const field of ["wallets", "accounts", "keys", "signers", "data"])
      if (node[field]) harvestJson(node[field], out, src, depth + 1);
  }
}

function harvestText(text, out, src) {
  for (const rawLine of text.split(/\r?\n/)) {
    let line = rawLine.trim();
    if (!line || line.startsWith("#") || line.startsWith("//")) continue;
    // JSONL (one JSON object per line, e.g. used-wallets.jsonl): parse the line
    // as JSON and harvest keys/addresses from it.
    if (line.startsWith("{") || line.startsWith("[")) {
      try { harvestJson(JSON.parse(line), out, src); continue; } catch { /* not valid json, fall through */ }
    }
    // any 0x-prefixed 32-byte hex on the line is a private key — handles
    // "address,key" / "address key" / JSONL that didn't cleanly parse.
    const hexKeys = line.match(/0x[0-9a-fA-F]{64}/g);
    if (hexKeys) { for (const k of hexKeys) out.push({ key: k, src }); continue; }
    // KEY=VALUE (.env) — take the value side
    const eq = line.indexOf("=");
    if (eq !== -1 && !line.includes(" ")) line = line.slice(eq + 1).trim().replace(/^["']|["']$/g, "");
    if (looksLikeKey(line)) { out.push({ key: line, src }); continue; }
    // a bare seed phrase on its own line
    const parts = rawLine.trim().replace(/^[A-Z0-9_]+=/, "").replace(/^["']|["']$/g, "").split(/\s+/);
    if (BIP39_LEN.has(parts.length) && ethers.Mnemonic.isValidMnemonic(parts.join(" ")))
      out.push({ mnemonic: parts.join(" "), src });
  }
}

// ── provider ────────────────────────────────────────────────────────────────
function getProvider(cfg) {
  const net = new ethers.Network("robinhood-chain", cfg.chainId);
  const req = new ethers.FetchRequest(cfg.rpcUrl);
  req.timeout = cfg.rpcTimeout;
  return new ethers.JsonRpcProvider(req, net, { staticNetwork: net });
}

// ── audit log ─────────────────────────────────────────────────────────────────
function audit(cfg, rec) {
  try { appendFileSync(cfg.logFile, JSON.stringify(rec) + "\n"); } catch { /* non-fatal */ }
}

// ── balance scan (token + native) for all wallets ──────────────────────────────
// Uses Multicall3 if configured (a handful of calls); otherwise reads per wallet
// with bounded concurrency + pacing. Returns Map addr -> { token: Map, eth }.
async function scanBalances(wallets, provider, cfg, token) {
  const addrs = wallets.map((w) => w.address);
  const tokenBal = new Map();
  const ethBal = new Map();

  if (token && cfg.multicall && ethers.isAddress(cfg.multicall)) {
    try {
      const mc = new ethers.Contract(cfg.multicall, MULTICALL3_ABI, provider);
      const erc = new ethers.Interface(ERC20_ABI);
      const CHUNK = 400;
      for (let i = 0; i < addrs.length; i += CHUNK) {
        const slice = addrs.slice(i, i + CHUNK);
        const calls = [];
        for (const a of slice) {
          calls.push({ target: token, allowFailure: true, callData: erc.encodeFunctionData("balanceOf", [a]) });
          calls.push({ target: cfg.multicall, allowFailure: true, callData: mc.interface.encodeFunctionData("getEthBalance", [a]) });
        }
        const res = await withRetry(`multicall ${i}`, () => mc.aggregate3(calls));
        for (let j = 0; j < slice.length; j++) {
          const tRes = res[2 * j], eRes = res[2 * j + 1];
          tokenBal.set(slice[j].toLowerCase(), tRes.success ? erc.decodeFunctionResult("balanceOf", tRes.returnData)[0] : 0n);
          ethBal.set(slice[j].toLowerCase(), eRes.success ? mc.interface.decodeFunctionResult("getEthBalance", eRes.returnData)[0] : 0n);
        }
        log(`    scanned ${Math.min(i + CHUNK, addrs.length)}/${addrs.length} (multicall)`);
      }
      return { tokenBal, ethBal };
    } catch (e) {
      warn(`multicall scan failed (${e?.shortMessage || e?.message}); falling back to per-wallet reads`);
      tokenBal.clear(); ethBal.clear();
    }
  }

  // fallback: per-wallet reads (bounded concurrency). Handles token === null too.
  const erc = token ? new ethers.Contract(token, ERC20_ABI, provider) : null;
  let done = 0;
  await mapPool(addrs, cfg.concurrency, async (a) => {
    const [t, e] = await Promise.all([
      erc ? withRetry("balanceOf", () => erc.balanceOf(a)).catch(() => 0n) : Promise.resolve(0n),
      withRetry("getBalance", () => provider.getBalance(a)).catch(() => 0n),
    ]);
    tokenBal.set(a.toLowerCase(), t);
    ethBal.set(a.toLowerCase(), e);
    if (++done % 250 === 0) log(`    scanned ${done}/${addrs.length}`);
  }, cfg.delayMs);
  return { tokenBal, ethBal };
}

// ── main ──────────────────────────────────────────────────────────────────────
async function main() {
  const cfg = parseConfig(process.argv);
  if (cfg.help) return printHelp();

  if (!cfg.dest || !ethers.isAddress(cfg.dest))
    throw new Error("No valid destination. Set --dest 0xYourMainWallet (or DEST env). Refusing to run.");
  cfg.dest = ethers.getAddress(cfg.dest);
  for (const t of cfg.tokens) if (!ethers.isAddress(t)) throw new Error(`Not a valid token address: ${t}`);
  const wantToken = cfg.phase("fund") || cfg.phase("collect");
  if (wantToken && cfg.tokens.length !== 1)
    throw new Error("Give exactly one token CA with --token 0x… (fund/collect need it). Use --phases refund for an ETH-only sweep.");
  const token = cfg.tokens[0] ? ethers.getAddress(cfg.tokens[0]) : null;

  // funder (only needed to actually run the fund phase). --funder-keyfile can
  // point at a raw-key file OR a .env — we pull FUNDER_KEY / PRIVATE_KEY / PK
  // from it, or fall back to the first 0x-64hex private key in the file.
  let funder = null;
  if (cfg.funderKeyfile && existsSync(cfg.funderKeyfile)) {
    const txt = readFileSync(cfg.funderKeyfile, "utf8");
    const m = txt.match(/(?:FUNDER_KEY|PRIVATE_KEY|PK)\s*=\s*["']?(0x[0-9a-fA-F]{64}|[0-9a-fA-F]{64})/i)
           || txt.match(/(0x[0-9a-fA-F]{64})/);
    if (m && looksLikeKey(m[1])) cfg.funderKey = m[1];
  }
  if (cfg.funderKey && looksLikeKey(cfg.funderKey)) funder = new ethers.Wallet(norm(cfg.funderKey));

  log("");
  log("  Robin token sweeper — fund → collect → refund");
  log("  ─────────────────────────────────────────────");
  log(`  mode         ${cfg.execute ? "⚠️  EXECUTE (will send funds)" : "DRY-RUN (no funds move)"}`);
  log(`  phases       ${cfg.phases.join(" → ")}`);
  log(`  rpc          ${cfg.rpcUrl}`);
  log(`  chainId      ${cfg.chainId}`);
  log(`  destination  ${cfg.dest}`);
  log(`  token CA     ${token || "(none — ETH only)"}`);
  log(`  funder       ${funder ? funder.address : (cfg.phase("fund") ? "⚠️  none (set FUNDER_KEY)" : "n/a")}`);
  log(`  keys from    ${resolve(cfg.keysPath)}`);
  log(`  balance read ${cfg.multicall ? "multicall " + short(cfg.multicall) : "per-wallet"}`);
  log(`  audit log    ${resolve(cfg.logFile)}`);
  log("");

  // --list: offline diagnostic. Load the keys, print which ADDRESSES they map
  // to, and dump the full set to a file — no RPC, no sends. Use it to check the
  // keys resolve to the wallets you expect (e.g. cross-check vs a token holder).
  if (cfg.list) {
    log("  Loading wallets…");
    const wl = await loadWallets(cfg.keysPath, cfg);
    log(`  Found ${wl.length} wallet(s). First 20 addresses:`);
    wl.slice(0, 20).forEach((w) => log(`    ${w.address}`));
    try {
      writeFileSync("loaded-addresses.txt", wl.map((w) => w.address).join("\n") + "\n");
      log(`\n  Full list of ${wl.length} addresses written to loaded-addresses.txt\n`);
    } catch (e) { warn("could not write loaded-addresses.txt: " + e.message); }
    return;
  }

  // provider + real chainId check (staticNetwork would just echo ours)
  const provider = getProvider(cfg);
  let realChainId;
  try { realChainId = Number(BigInt(await withRetry("eth_chainId", () => provider.send("eth_chainId", [])))); }
  catch (e) { throw new Error(`Could not reach RPC ${cfg.rpcUrl} to confirm the chain: ${e?.shortMessage || e?.message}`); }
  if (realChainId !== cfg.chainId)
    throw new Error(`RPC reports chainId ${realChainId}, expected ${cfg.chainId}. Refusing to run — check --rpc / --chain-id.`);

  // wallets
  log("  Loading wallets…");
  let wallets = await loadWallets(cfg.keysPath, cfg);
  if (wallets.length === 0) throw new Error("No private keys found under the keys path. Check --keys / KEYS.");
  const totalLoaded = wallets.length;
  if (cfg.limit > 0 && wallets.length > cfg.limit) wallets = wallets.slice(0, cfg.limit); // test/batch runs
  log(`  Found ${totalLoaded} wallet(s).${cfg.limit > 0 && totalLoaded > cfg.limit ? `  Using the first ${cfg.limit} (--limit).` : ""}`);
  if (wallets.length <= 20) for (const w of wallets) log(`    ${w.address}`);
  log("");

  // token metadata + a real transfer-gas calibration (needs a live holder)
  let meta = { decimals: 18, symbol: "ETH" };
  if (token) {
    const erc = new ethers.Contract(token, ERC20_ABI, provider);
    let decimals = 18, symbol = "TOKEN";
    try { decimals = Number(await withRetry("decimals", () => erc.decimals())); } catch {}
    try { symbol = await withRetry("symbol", () => erc.symbol()); } catch {}
    meta = { decimals, symbol };
    log(`  token ${short(token)} = ${symbol} (${decimals} dp)`);
  }

  // fee data + native-transfer gas (used for fund + refund sizing)
  const fee = await provider.getFeeData().catch(() => ({}));
  const maxFee = fee.maxFeePerGas ?? fee.gasPrice ?? 0n;
  const maxPriority = fee.maxPriorityFeePerGas ?? 0n;
  if (maxFee === 0n) throw new Error("Could not read a gas price from the RPC.");
  let nativeGas = 21000n;
  try { nativeGas = await provider.estimateGas({ from: cfg.dest, to: cfg.dest, value: 1n }); } catch {}
  nativeGas = mulDiv(nativeGas, cfg.gasBufferMult);
  const refundCost = nativeGas * maxFee;               // what a refund/fund send costs
  log(`  gas: ${ethers.formatUnits(maxFee, "gwei")} gwei · native send ≈ ${ethers.formatEther(refundCost)} ETH`);

  // scan balances (drives the plan and idempotency)
  log("  Scanning balances…");
  const { tokenBal, ethBal } = await scanBalances(wallets, provider, cfg, token);

  // per-wallet gas target for a token transfer — calibrate off a real holder
  let collectGas = DEFAULTS.fundReserve;
  if (token) {
    const holder = wallets.find((w) => (tokenBal.get(w.address.toLowerCase()) || 0n) > 0n);
    if (holder) {
      const erc = new ethers.Contract(token, ERC20_ABI, provider);
      try { collectGas = await erc.transfer.estimateGas(cfg.dest, tokenBal.get(holder.address.toLowerCase()), { from: holder.address }); } catch {}
    }
    collectGas = mulDiv(collectGas < DEFAULTS.fundReserve ? DEFAULTS.fundReserve : collectGas, cfg.gasBufferMult);
  }
  const perWalletNeed = collectGas * maxFee;           // ETH each holder needs to move its token

  // build work lists
  const minToken = token ? ethers.parseUnits(String(cfg.minToken || "0"), meta.decimals) : 0n;
  let holders = token ? wallets.filter((w) => (tokenBal.get(w.address.toLowerCase()) || 0n) > minToken) : [];

  // --max-fund: cap the run to as many real holders as the ETH budget covers.
  // Applied AFTER the scan (unlike --limit, which slices raw file order), so it
  // targets wallets that actually hold the token regardless of file ordering.
  if (cfg.maxFund && holders.length) {
    const budget = ethers.parseEther(String(cfg.maxFund));
    let spent = 0n, k = 0;
    for (const w of holders) {
      const have = ethBal.get(w.address.toLowerCase()) || 0n;
      const cost = (have < perWalletNeed ? perWalletNeed - have : 0n) + refundCost; // fund + funder gas
      if (spent + cost > budget) break;
      spent += cost; k++;
    }
    log(`  --max-fund ${cfg.maxFund} ETH → processing the first ${k} of ${holders.length} holders (~${ethers.formatEther(spent)} ETH)`);
    holders = holders.slice(0, k);
  }

  const toFund = holders
    .map((w) => ({ w, have: ethBal.get(w.address.toLowerCase()) || 0n }))
    .filter((x) => x.have < perWalletNeed)
    .map((x) => ({ w: x.w, amount: perWalletNeed - x.have }));
  const fundTotal = toFund.reduce((s, x) => s + x.amount, 0n);
  const tokenTotal = holders.reduce((s, w) => s + (tokenBal.get(w.address.toLowerCase()) || 0n), 0n);
  // When the run is scoped (limit/max-fund), refund only the wallets we touched;
  // otherwise sweep every loaded wallet that has ETH.
  const refundScope = (cfg.maxFund || cfg.limit) ? holders : wallets;
  const refundable = refundScope.filter((w) => (ethBal.get(w.address.toLowerCase()) || 0n) > refundCost);

  // plan
  log("");
  log("  Plan");
  log("  ────");
  if (token) {
    log(`  holders of ${meta.symbol}     ${holders.length}`);
    log(`  ${meta.symbol} to collect     ${ethers.formatUnits(tokenTotal, meta.decimals)}`);
    if (cfg.phase("fund")) {
      log(`  wallets to fund      ${toFund.length}  (rest already have gas)`);
      log(`  ETH to fund (total)  ${ethers.formatEther(fundTotal)}  (+ ~${ethers.formatEther(BigInt(toFund.length) * refundCost)} funder gas)`);
    }
  }
  if (cfg.phase("refund")) log(`  wallets w/ ETH left  ${refundable.length}  (~${ethers.formatEther(refundable.reduce((s, w) => s + (ethBal.get(w.address.toLowerCase()) || 0n) - refundCost, 0n))} ETH refundable now)`);

  // preflight the funder
  if (cfg.phase("fund") && toFund.length) {
    if (!funder) {
      if (cfg.execute) throw new Error("Fund phase needs a funder key. Set FUNDER_KEY (or --funder-keyfile).");
      warn("no FUNDER_KEY set — needed to actually fund (dry-run continues).");
    } else {
      const fb = await provider.getBalance(funder.address);
      const need = fundTotal + BigInt(toFund.length) * refundCost;
      log(`  funder balance       ${ethers.formatEther(fb)} ETH  (need ~${ethers.formatEther(need)})`);
      if (fb < need) {
        const msg = `Funder ${short(funder.address)} has ${ethers.formatEther(fb)} ETH but needs ~${ethers.formatEther(need)}.`;
        if (cfg.execute && !cfg.allowPartial) throw new Error(`${msg} Top it up, or pass --allow-partial to fund as far as it goes.`);
        warn(msg + (cfg.allowPartial ? " Proceeding partially (--allow-partial)." : ""));
      }
    }
  }
  log("");

  if (!cfg.execute) {
    log("  DRY-RUN — nothing was sent. Re-run with --execute to move funds.\n");
    return;
  }

  // confirmation gate
  if (!cfg.yes) {
    const rl = createInterface({ input: stdin, output: stdout });
    const ans = await rl.question(`  Type "yes" to run [${cfg.phases.join(", ")}] over ${wallets.length} wallet(s) into ${cfg.dest}: `);
    rl.close();
    if (ans.trim().toLowerCase() !== "yes") { log("  Aborted.\n"); return; }
    log("");
  }

  const totals = { funded: 0n, collected: 0n, refunded: 0n, fails: 0 };

  // ── PHASE 1: FUND (sequential, nonce-ordered from the funder) ────────────────
  if (cfg.phase("fund") && funder && toFund.length) {
    log(`  FUND — topping up ${toFund.length} wallet(s)…`);
    const f = funder.connect(provider);
    let nonce = await withRetry("funderNonce", () => provider.getTransactionCount(f.address, "pending"));
    let fb = await provider.getBalance(f.address);
    const pending = [];
    for (const { w, amount } of toFund) {
      if (fb < amount + refundCost) { warn(`funder out of ETH at ${short(w.address)} — stopping fund phase`); break; }
      try {
        const txReq = { to: w.address, value: amount, nonce: nonce, gasLimit: nativeGas };
        if (fee.maxFeePerGas) { txReq.maxFeePerGas = maxFee; txReq.maxPriorityFeePerGas = maxPriority; } else txReq.gasPrice = maxFee;
        const tx = await withRetry(`fund ${short(w.address)}`, () => f.sendTransaction(txReq));
        pending.push({ w, amount, hash: tx.hash, wait: tx.wait(cfg.confirmations) });
        audit(cfg, { phase: "fund", to: w.address, amount: amount.toString(), tx: tx.hash });
        nonce++; fb -= amount + refundCost;
        if (cfg.delayMs) await sleep(cfg.delayMs);
      } catch (e) { totals.fails++; warn(`fund ${short(w.address)} failed: ${e?.shortMessage || e?.message}`); break; }
    }
    // wait for funding to mine so collect sees the gas
    log(`  FUND — waiting on ${pending.length} tx(s) to confirm…`);
    for (const p of pending) {
      try { await p.wait; totals.funded += p.amount; }
      catch (e) { totals.fails++; warn(`fund ${short(p.w.address)} tx ${short(p.hash)} reverted: ${e?.shortMessage || e?.message}`); }
    }
    log(`  FUND — done: ${ethers.formatEther(totals.funded)} ETH sent.\n`);
  }

  // ── PHASE 2: COLLECT (per-wallet, bounded concurrency) ───────────────────────
  if (cfg.phase("collect") && token && holders.length) {
    log(`  COLLECT — sweeping ${meta.symbol} from ${holders.length} wallet(s)…`);
    let done = 0;
    const res = await mapPool(holders, cfg.concurrency, async (entry) => {
      const w = entry.signer.connect(provider);
      const erc = new ethers.Contract(token, ERC20_ABI, w);
      const bal = await withRetry("balanceOf", () => erc.balanceOf(entry.address));
      if (bal === 0n) return 0n; // already collected
      const tx = await withRetry(`collect ${short(entry.address)}`, () => erc.transfer(cfg.dest, bal));
      audit(cfg, { phase: "collect", from: entry.address, amount: bal.toString(), tx: tx.hash });
      await withRetry("wait", () => tx.wait(cfg.confirmations));
      if (++done % 100 === 0) log(`    collected ${done}/${holders.length}`);
      return bal;
    }, cfg.delayMs);
    for (const r of res) { if (r?.error) { totals.fails++; } else totals.collected += (r || 0n); }
    log(`  COLLECT — done: ${ethers.formatUnits(totals.collected, meta.decimals)} ${meta.symbol} swept.\n`);
  }

  // ── PHASE 3: REFUND (per-wallet, bounded concurrency, reads fresh balance) ────
  if (cfg.phase("refund")) {
    // every wallet in scope may hold ETH now (gas float + pre-existing); read fresh
    log(`  REFUND — sweeping leftover ETH from up to ${refundScope.length} wallet(s)…`);
    let done = 0;
    const refErc = token ? new ethers.Contract(token, ERC20_ABI, provider) : null;
    const res = await mapPool(refundScope, cfg.concurrency, async (entry) => {
      const w = entry.signer.connect(provider);
      // Don't strip gas from a wallet that still holds tokens (collect not done
      // yet on a partial re-run) — leave its gas so the retry can collect.
      if (refErc && (await withRetry("balanceOf", () => refErc.balanceOf(entry.address))) > 0n) return 0n;
      const bal = await withRetry("getBalance", () => provider.getBalance(entry.address));
      const value = bal - refundCost;
      if (value <= 0n) return 0n; // nothing worth sweeping
      const txReq = { to: cfg.dest, value, gasLimit: nativeGas };
      if (fee.maxFeePerGas) { txReq.maxFeePerGas = maxFee; txReq.maxPriorityFeePerGas = maxPriority; } else txReq.gasPrice = maxFee;
      const tx = await withRetry(`refund ${short(entry.address)}`, () => w.sendTransaction(txReq));
      audit(cfg, { phase: "refund", from: entry.address, amount: value.toString(), tx: tx.hash });
      await withRetry("wait", () => tx.wait(cfg.confirmations));
      if (++done % 100 === 0) log(`    refunded ${done}`);
      return value;
    }, cfg.delayMs);
    for (const r of res) { if (r?.error) { totals.fails++; } else totals.refunded += (r || 0n); }
    log(`  REFUND — done: ${ethers.formatEther(totals.refunded)} ETH swept.\n`);
  }

  // summary
  log("  Summary");
  log("  ───────");
  if (cfg.phase("fund")) log(`  funded    ${ethers.formatEther(totals.funded)} ETH`);
  if (cfg.phase("collect")) log(`  collected ${ethers.formatUnits(totals.collected, meta.decimals)} ${meta.symbol}`);
  if (cfg.phase("refund")) log(`  refunded  ${ethers.formatEther(totals.refunded)} ETH`);
  if (totals.fails) warn(`${totals.fails} action(s) failed — re-run the SAME command to retry only what's left (it's idempotent).`);
  else log("  no failures.");
  log(`\n  Audit log: ${resolve(cfg.logFile)}\n`);
}

function printHelp() {
  log(`
Robin token sweeper — fund → collect → refund, for consolidating many bot
wallets into one main wallet.

USAGE
  node sweep.js --dest 0xMain --token 0xCA [options]          # dry-run
  node sweep.js --dest 0xMain --token 0xCA --execute          # real run

Nothing moves without --execute. A dry-run scans balances and prints the full
plan (holders, token to collect, ETH to fund, funder balance vs need).

Re-running is safe: it reads live balances and only does what's left, so an
interrupted run RESUMES by just running the same command again.

REQUIRED
  --dest, --to 0x…       Main wallet everything is swept to (or DEST env).
  --token 0x…            Token CA to sweep (or TOKENS env). One token.
  FUNDER_KEY (env)       Private key of the wallet that pays gas to fund the
                         others. Needed for the fund phase. Prefer the env var
                         (or --funder-keyfile PATH) over putting a key on argv.

PHASES  (default: all three; subset with --phases or the flags)
  --phases fund,collect,refund     Comma list, in order.
  --collect-only                   Just move tokens (wallets must already have gas).
  --no-fund / --no-refund          Drop a phase.

OPTIONS
  --keys PATH            Dir/file with the bot-wallet keys. Default: ${DEFAULTS.keysPath}
  --rpc URL              RPC endpoint. Default: ${DEFAULTS.rpcUrl}
  --chain-id N           Expected chainId. Default: ${DEFAULTS.chainId}
  --multicall 0x…        Multicall3 address for batched balance READS. Defaults
                         to the canonical address (deployed + verified on
                         Robinhood Chain). Auto-falls back to per-wallet reads if
                         it errors.
  --no-multicall         Disable multicall; read balances per wallet.
  --concurrency N        Collect/refund wallets in flight. Default: ${DEFAULTS.concurrency}.
  --delay MS             Pause between sends/reads (rate-limit ease). Default: ${DEFAULTS.delayMs}.
  --gas-buffer F         Pad gas estimates by F (funding headroom). Default: ${DEFAULTS.gasBufferMult}.
  --min-token N          Ignore holders below N tokens (dust). Default: 0.
  --limit N              Only process the first N loaded wallets (raw file order).
  --max-fund ETH         Cap the run to as many real holders as this ETH budget
                         covers (applied AFTER the scan — targets actual holders
                         regardless of file order). Best knob for a bounded test.
  --count N              Addresses to derive if a seed phrase is found (def ${DEFAULTS.mnemonicCount}).
  --path "m/44'/60'/0'/0"  HD derivation parent path for a seed phrase.
  --log PATH             Append-only audit log of every send. Default: ${DEFAULTS.logFile}
  --allow-partial        Fund as far as the funder's balance allows, don't abort.
  --rpc-timeout MS       Per-request timeout. Default: ${DEFAULTS.rpcTimeout}.
  --execute              Actually send. (Default is dry-run.)
  --yes                  Skip the interactive confirmation.
  --list                 Offline: print the addresses your keys map to (and dump
                         them all to loaded-addresses.txt), then exit. No RPC.
  --verbose / --help

Keys are read locally and NEVER printed. Set KEYSTORE_PASSWORD for v3 keystores.
`);
}

main().catch((e) => { console.error("\n  ✗", e?.shortMessage || e?.message || e, "\n"); process.exit(1); });
