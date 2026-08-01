// ─────────────────────────────────────────────────────────────────────────────
// Robin token sweeper
//
// Consolidates funds OUT of a set of bot wallets you control and INTO one main
// wallet. You give it a token contract address (the "CA"); for every wallet
// whose private key it finds, it:
//   1. sends that token's ENTIRE balance to your main wallet, then
//   2. sweeps the leftover native ETH (minus exactly enough for gas).
//
// It moves your own money between wallets you hold the keys to — nothing more.
// It signs plain ERC-20 transfers and a plain value transfer. No approvals to
// third parties, no contract calls beyond the token's own transfer().
//
// SAFETY MODEL
//   • DRY-RUN IS THE DEFAULT. Nothing is sent unless you pass --execute.
//   • Even with --execute it prints the full plan and every derived address,
//     then requires you to type "yes" (skip with --yes for automation).
//   • Private keys are NEVER printed or logged. Only addresses, balances, hashes.
//   • Tokens are swept BEFORE ETH, because moving a token costs gas — sweep the
//     ETH first and the token transfer would fail with no gas left.
//   • The native sweep pins gasLimit + fee, so value = balance − gas exactly.
//     The tx can always afford itself; at worst a few wei of dust is left.
//
// Chain defaults are Robinhood Chain (Arbitrum Orbit L2, chainId 4663).
// Requires: Node 18+ and `npm install` in this folder (pulls ethers v6).
// ─────────────────────────────────────────────────────────────────────────────

import { ethers } from "ethers";
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
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
  gasBufferMult: 1.15,          // pad the estimated native-transfer gas by this
  concurrency: 1,               // wallets processed at once (1 = fully sequential)
  confirmations: 1,             // receipt confirmations to wait for
  retries: 4,                   // per on-chain action, with exponential backoff
  delayMs: 200,                 // pause between wallets (eases RPC rate limits)
  rpcTimeout: 20000,            // per-request timeout (ms) so a dead RPC fails fast
};

// Minimal ERC-20 surface we need.
const ERC20_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function transfer(address to, uint256 amount) returns (bool)",
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
];

// ── tiny helpers ─────────────────────────────────────────────────────────────
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const short = (a) => (a ? `${a.slice(0, 6)}…${a.slice(-4)}` : "?");
const isHexKey = (s) => /^0x[0-9a-fA-F]{64}$/.test(s);
const looksLikeKey = (s) => isHexKey(s) || /^[0-9a-fA-F]{64}$/.test(s);
const norm = (k) => (k.startsWith("0x") ? k : "0x" + k);
const BIP39_LEN = new Set([12, 15, 18, 21, 24]);

function log(...a) { console.log(...a); }
function warn(...a) { console.warn("  ! ", ...a); }

// Retry a promise-returning fn on transient RPC/nonce errors.
async function withRetry(label, fn, retries = DEFAULTS.retries) {
  let last;
  for (let i = 0; i <= retries; i++) {
    try { return await fn(); }
    catch (e) {
      last = e;
      const msg = (e?.shortMessage || e?.message || "").toLowerCase();
      // Don't waste retries on deterministic failures.
      if (msg.includes("insufficient funds") || msg.includes("transfer amount exceeds") ||
          e?.code === "INVALID_ARGUMENT") break;
      if (i < retries) {
        const wait = 2000 * 2 ** i;
        warn(`${label} failed (${e?.shortMessage || e?.message}); retry ${i + 1}/${retries} in ${wait / 1000}s`);
        await sleep(wait);
      }
    }
  }
  throw last;
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
      if (eq !== -1) { opts[a.slice(2, eq)] = a.slice(eq + 1); }
      else if (args[i + 1] && !args[i + 1].startsWith("--")) { opts[a.slice(2)] = args[++i]; }
      else { flags.add(a.slice(2)); }
    } else positionals.push(a);
  }

  const env = process.env;
  const tokensRaw = opts.token || opts.tokens || env.TOKENS || positionals.join(",");
  const tokens = tokensRaw.split(",").map((t) => t.trim()).filter(Boolean);

  return {
    rpcUrl: opts.rpc || env.RPC_URL || DEFAULTS.rpcUrl,
    chainId: Number(opts["chain-id"] || env.CHAIN_ID || DEFAULTS.chainId),
    dest: opts.dest || opts.to || env.DEST || env.MAIN_WALLET || "",
    keysPath: opts.keys || env.KEYS || env.KEYS_DIR || DEFAULTS.keysPath,
    tokens,
    sweepEth: !flags.has("no-eth") && !flags.has("tokens-only"),
    sweepTokens: !flags.has("eth-only"),
    mnemonicCount: Number(opts.count || env.MNEMONIC_COUNT || DEFAULTS.mnemonicCount),
    derivePath: opts.path || env.DERIVE_PATH || DEFAULTS.derivePath,
    keystorePassword: env.KEYSTORE_PASSWORD || "",
    gasBufferMult: Number(opts["gas-buffer"] || env.GAS_BUFFER_MULT || DEFAULTS.gasBufferMult),
    concurrency: Math.max(1, Number(opts.concurrency || env.CONCURRENCY || DEFAULTS.concurrency)),
    delayMs: Number(opts.delay || env.DELAY_MS || DEFAULTS.delayMs),
    rpcTimeout: Number(opts["rpc-timeout"] || env.RPC_TIMEOUT || DEFAULTS.rpcTimeout),
    execute: flags.has("execute"),
    yes: flags.has("yes"),
    verbose: flags.has("verbose"),
    help: flags.has("help") || flags.has("h"),
  };
}

// ── key loading (auto-detect) ──────────────────────────────────────────────────
// Walks a file or directory and pulls out every private key / mnemonic it can
// recognise, from the common shapes a distributor might have written:
//   • JSON array of key strings                       ["0xabc…", …]
//   • JSON array of objects                           [{ address, privateKey }, …]
//   • JSON object with wallets/accounts/keys array    { wallets: [ … ] }
//   • JSON object with a mnemonic/seed (+ count/path) { mnemonic: "…", count: 20 }
//   • .env style lines                                PRIVATE_KEY_0=0x… / PK1=…
//   • plain text, one key or one seed phrase per line
//   • keystore v3 JSON (needs KEYSTORE_PASSWORD)
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
    } else if (st.isFile()) {
      files.push(p);
    }
  })(root, 0);

  const found = []; // { key?, mnemonic?, count?, path?, keystore?, address? }
  for (const file of files) {
    let text;
    try { text = readFileSync(file, "utf8"); } catch { continue; }
    const trimmed = text.trim();
    if (!trimmed) continue;

    // Try JSON first.
    let parsed = null;
    try { parsed = JSON.parse(trimmed); } catch { /* not json */ }

    if (parsed !== null) {
      harvestJson(parsed, found, file);
    } else {
      harvestText(trimmed, found, file);
    }
  }

  // Materialise signers, de-duplicating by resolved address.
  const byAddr = new Map();
  const add = (signer, src) => {
    const addr = signer.address.toLowerCase();
    if (!byAddr.has(addr)) byAddr.set(addr, { signer, address: signer.address, src });
  };

  for (const f of found) {
    try {
      if (f.key) {
        add(new ethers.Wallet(norm(f.key)), f.src);
      } else if (f.mnemonic) {
        const count = f.count || cfg.mnemonicCount;
        const path = f.path || cfg.derivePath;
        const parent = ethers.HDNodeWallet.fromPhrase(f.mnemonic, "", path);
        for (let i = 0; i < count; i++) add(parent.deriveChild(i), `${f.src} [${path}/${i}]`);
      } else if (f.keystore) {
        if (!cfg.keystorePassword) { warn(`keystore ${f.src} skipped (set KEYSTORE_PASSWORD to use it)`); continue; }
        add(await ethers.Wallet.fromEncryptedJson(f.keystore, cfg.keystorePassword), f.src);
      }
    } catch (e) {
      warn(`could not load a key from ${f.src}: ${e?.shortMessage || e?.message}`);
    }
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
    // mnemonic-bearing object
    const mn = node.mnemonic || node.seed || node.phrase;
    if (typeof mn === "string" && ethers.Mnemonic.isValidMnemonic(mn.trim())) {
      out.push({ mnemonic: mn.trim(), count: Number(node.count) || undefined, path: node.path || node.derivePath, src });
    }
    // direct private-key fields
    for (const field of ["privateKey", "private_key", "priv", "pk", "key", "secret", "sk"]) {
      const v = node[field];
      if (typeof v === "string" && looksLikeKey(v)) {
        out.push({ key: v, address: node.address, src });
        break;
      }
    }
    // keystore v3
    if ((node.crypto || node.Crypto) && (node.version || node.ciphertext || node.crypto?.ciphertext)) {
      out.push({ keystore: JSON.stringify(node), src });
    }
    // recurse into nested containers
    for (const field of ["wallets", "accounts", "keys", "signers", "data"]) {
      if (node[field]) harvestJson(node[field], out, src, depth + 1);
    }
  }
}

function harvestText(text, out, src) {
  for (const rawLine of text.split(/\r?\n/)) {
    let line = rawLine.trim();
    if (!line || line.startsWith("#") || line.startsWith("//")) continue;
    // KEY=VALUE (env) — take the value side
    const eq = line.indexOf("=");
    if (eq !== -1 && !line.includes(" ") ) line = line.slice(eq + 1).trim().replace(/^["']|["']$/g, "");
    // env line where a seed phrase (with spaces) is quoted after '='
    if (looksLikeKey(line)) { out.push({ key: line, src }); continue; }
    const parts = rawLine.trim().replace(/^[A-Z0-9_]+=/,"").replace(/^["']|["']$/g, "").split(/\s+/);
    if (BIP39_LEN.has(parts.length) && ethers.Mnemonic.isValidMnemonic(parts.join(" ")))
      out.push({ mnemonic: parts.join(" "), src });
  }
}

// ── provider ────────────────────────────────────────────────────────────────
function getProvider(cfg) {
  const net = new ethers.Network("robinhood-chain", cfg.chainId);
  // A per-request timeout so a slow/rate-limited RPC fails fast instead of
  // hanging. ethers auto-throttles on HTTP 429; withRetry() covers the rest.
  const req = new ethers.FetchRequest(cfg.rpcUrl);
  req.timeout = cfg.rpcTimeout;
  // staticNetwork avoids a chainId round-trip and auto-detect surprises on a
  // custom L2; we still verify the real chainId in main() before sending.
  return new ethers.JsonRpcProvider(req, net, { staticNetwork: net });
}

// ── sweep one wallet ──────────────────────────────────────────────────────────
async function sweepWallet(entry, provider, cfg, tokenMeta, totals) {
  const signer = entry.signer.connect(provider);
  const addr = entry.address;
  const line = (s) => log(`  ${short(addr)}  ${s}`);

  // 1) tokens first (they need gas)
  if (cfg.sweepTokens) {
    for (const token of cfg.tokens) {
      const meta = tokenMeta.get(token.toLowerCase());
      const erc = new ethers.Contract(token, ERC20_ABI, signer);
      let bal;
      try { bal = await withRetry("balanceOf", () => erc.balanceOf(addr)); }
      catch (e) { line(`✗ ${meta.symbol} balanceOf failed: ${e?.shortMessage || e?.message}`); continue; }
      if (bal === 0n) { if (cfg.verbose) line(`· ${meta.symbol} 0`); continue; }

      const human = ethers.formatUnits(bal, meta.decimals);
      if (!cfg.execute) { line(`→ would send ${human} ${meta.symbol}`); addTotal(totals, meta.symbol, bal); continue; }

      try {
        const tx = await withRetry("transfer", () => erc.transfer(cfg.dest, bal));
        line(`→ sending ${human} ${meta.symbol}  (${tx.hash})`);
        await withRetry("wait", () => tx.wait(cfg.confirmations));
        line(`✓ ${meta.symbol} sent`);
        addTotal(totals, meta.symbol, bal);
      } catch (e) {
        line(`✗ ${meta.symbol} transfer failed: ${e?.shortMessage || e?.message}`);
      }
    }
  }

  // 2) native ETH last
  if (cfg.sweepEth) {
    let bal;
    try { bal = await withRetry("getBalance", () => provider.getBalance(addr)); }
    catch (e) { line(`✗ getBalance failed: ${e?.shortMessage || e?.message}`); return; }
    if (bal === 0n) { if (cfg.verbose) line(`· ETH 0`); return; }

    // fee data + a gas estimate for a plain value transfer
    const fee = await provider.getFeeData().catch(() => ({}));
    const maxFee = fee.maxFeePerGas ?? fee.gasPrice ?? 0n;
    const maxPriority = fee.maxPriorityFeePerGas ?? 0n;
    if (maxFee === 0n) { line(`✗ ETH skipped: could not read gas price`); return; }

    let gasLimit;
    try { gasLimit = await provider.estimateGas({ from: addr, to: cfg.dest, value: 1n }); }
    catch { gasLimit = 21000n; }
    gasLimit = (gasLimit * BigInt(Math.round(cfg.gasBufferMult * 100))) / 100n;

    const cost = gasLimit * maxFee;          // worst-case gas cost at the fee cap
    const value = bal - cost;                 // send everything the tx can spare
    if (value <= 0n) { line(`· ETH ${ethers.formatEther(bal)} — too low to cover gas, leaving it`); return; }

    const human = ethers.formatEther(value);
    if (!cfg.execute) { line(`→ would send ${human} ETH  (leaves ~${ethers.formatEther(cost)} for gas)`); addTotal(totals, "ETH", value); return; }

    try {
      const txReq = { to: cfg.dest, value, gasLimit };
      if (fee.maxFeePerGas) { txReq.maxFeePerGas = maxFee; txReq.maxPriorityFeePerGas = maxPriority; }
      else { txReq.gasPrice = maxFee; }
      const tx = await withRetry("sendEth", () => signer.sendTransaction(txReq));
      line(`→ sending ${human} ETH  (${tx.hash})`);
      await withRetry("wait", () => tx.wait(cfg.confirmations));
      line(`✓ ETH sent`);
      addTotal(totals, "ETH", value);
    } catch (e) {
      line(`✗ ETH transfer failed: ${e?.shortMessage || e?.message}`);
    }
  }
}

function addTotal(totals, sym, amt) { totals.set(sym, (totals.get(sym) || 0n) + amt); }

// ── main ──────────────────────────────────────────────────────────────────────
async function main() {
  const cfg = parseConfig(process.argv);
  if (cfg.help) return printHelp();

  // validate destination — the one thing we can never get wrong
  if (!cfg.dest || !ethers.isAddress(cfg.dest)) {
    throw new Error("No valid destination. Set --dest 0xYourMainWallet (or DEST env). Refusing to run.");
  }
  cfg.dest = ethers.getAddress(cfg.dest); // checksum
  if (cfg.sweepTokens && cfg.tokens.length === 0 && !cfg.sweepEth) {
    throw new Error("Nothing to do: no token CA given and ETH sweep disabled.");
  }
  for (const t of cfg.tokens) if (!ethers.isAddress(t)) throw new Error(`Not a valid token address: ${t}`);

  log("");
  log("  Robin token sweeper");
  log("  ───────────────────");
  log(`  mode         ${cfg.execute ? "⚠️  EXECUTE (will send funds)" : "DRY-RUN (no funds move)"}`);
  log(`  rpc          ${cfg.rpcUrl}`);
  log(`  chainId      ${cfg.chainId}`);
  log(`  destination  ${cfg.dest}`);
  log(`  tokens       ${cfg.tokens.length ? cfg.tokens.join(", ") : "(none)"}`);
  log(`  sweep ETH    ${cfg.sweepEth ? "yes" : "no"}`);
  log(`  keys from    ${resolve(cfg.keysPath)}`);
  log("");

  // load wallets
  log("  Loading wallets…");
  const wallets = await loadWallets(cfg.keysPath, cfg);
  if (wallets.length === 0) throw new Error("No private keys found under the keys path. Check --keys / KEYS.");
  log(`  Found ${wallets.length} wallet(s):`);
  for (const w of wallets) log(`    ${w.address}`);
  if (wallets.some((w) => w.address.toLowerCase() === cfg.dest.toLowerCase()))
    warn("destination is also one of the source wallets — it will be skipped as a no-op by balance.");
  log("");

  // provider + chain check. staticNetwork means getNetwork() would just echo our
  // configured chainId back, so ask the node directly with a raw eth_chainId —
  // this is what actually catches a wrong RPC / wrong --chain-id before we sign.
  const provider = getProvider(cfg);
  let realChainId;
  try {
    const hex = await withRetry("eth_chainId", () => provider.send("eth_chainId", []));
    realChainId = Number(BigInt(hex));
  } catch (e) {
    throw new Error(`Could not reach RPC ${cfg.rpcUrl} to confirm the chain: ${e?.shortMessage || e?.message}`);
  }
  if (realChainId !== cfg.chainId) {
    throw new Error(`RPC reports chainId ${realChainId}, expected ${cfg.chainId}. Refusing to run — check --rpc / --chain-id.`);
  }

  // cache token metadata (symbol/decimals) for display
  const tokenMeta = new Map();
  for (const token of cfg.tokens) {
    const erc = new ethers.Contract(token, ERC20_ABI, provider);
    let decimals = 18, symbol = "TOKEN";
    try { decimals = Number(await withRetry("decimals", () => erc.decimals())); } catch {}
    try { symbol = await withRetry("symbol", () => erc.symbol()); } catch {}
    tokenMeta.set(token.toLowerCase(), { decimals, symbol, token });
    log(`  token ${short(token)} = ${symbol} (${decimals} dp)`);
  }
  if (cfg.tokens.length) log("");

  // confirmation gate for real sends
  if (cfg.execute && !cfg.yes) {
    const rl = createInterface({ input: stdin, output: stdout });
    const ans = await rl.question(`  Type "yes" to sweep ${wallets.length} wallet(s) into ${cfg.dest}: `);
    rl.close();
    if (ans.trim().toLowerCase() !== "yes") { log("  Aborted."); return; }
    log("");
  }

  // run
  const totals = new Map();
  const queue = [...wallets];
  const worker = async () => {
    while (queue.length) {
      const w = queue.shift();
      await sweepWallet(w, provider, cfg, tokenMeta, totals);
      if (queue.length && cfg.delayMs) await sleep(cfg.delayMs); // ease RPC rate limits
    }
  };
  await Promise.all(Array.from({ length: Math.min(cfg.concurrency, wallets.length) }, worker));

  // summary
  log("");
  log(cfg.execute ? "  Done. Moved:" : "  Dry-run totals (nothing was sent):");
  if (totals.size === 0) log("    nothing to move — all balances were 0.");
  for (const [sym, amt] of totals) {
    const meta = [...tokenMeta.values()].find((m) => m.symbol === sym);
    const human = sym === "ETH" ? ethers.formatEther(amt) : ethers.formatUnits(amt, meta?.decimals ?? 18);
    log(`    ${human} ${sym}`);
  }
  if (!cfg.execute) log("\n  Re-run with --execute to actually move funds.");
  log("");
}

function printHelp() {
  log(`
Robin token sweeper — move tokens + ETH from bot wallets to your main wallet.

USAGE
  node sweep.js --dest 0xMainWallet --token 0xTokenCA [options]
  node sweep.js 0xTokenCA --dest 0xMainWallet --execute --yes

Nothing moves unless you pass --execute. Without it you get a dry-run that
prints every wallet, its balances, and what WOULD be swept.

REQUIRED
  --dest, --to 0x…      Destination main wallet (or DEST / MAIN_WALLET env).
  --token 0x…           Token contract address (CA) to sweep. Repeatable /
                        comma-separated, or pass as a positional. Omit only if
                        you use --eth-only.

OPTIONS
  --keys PATH           Dir or file with the bot-wallet keys.
                        Default: ${DEFAULTS.keysPath}
  --rpc URL             RPC endpoint. Default: ${DEFAULTS.rpcUrl}
  --chain-id N          Expected chainId. Default: ${DEFAULTS.chainId}
  --count N             Addresses to derive if a seed phrase is found (def ${DEFAULTS.mnemonicCount}).
  --path "m/44'/60'/0'/0"  HD derivation parent path for a seed phrase.
  --concurrency N       Wallets in flight at once. Default: 1 (sequential).
  --delay MS            Pause between wallets, eases RPC rate limits (def ${DEFAULTS.delayMs}).
  --rpc-timeout MS      Per-request timeout so a dead RPC fails fast (def ${DEFAULTS.rpcTimeout}).
  --eth-only            Sweep only native ETH, no tokens.
  --tokens-only, --no-eth  Sweep only tokens, leave the ETH.
  --gas-buffer F        Multiply estimated native-transfer gas by F (def ${DEFAULTS.gasBufferMult}).
  --execute             Actually send. (Default is dry-run.)
  --yes                 Skip the interactive "type yes" confirmation.
  --verbose             Also print wallets/tokens with a 0 balance.
  --help                This help.

Keys are read locally and NEVER printed. Set KEYSTORE_PASSWORD to use v3
keystore files.
`);
}

main().catch((e) => { console.error("\n  ✗", e?.shortMessage || e?.message || e, "\n"); process.exit(1); });
