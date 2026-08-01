# Robin token sweeper — fund → collect → refund

Consolidate a token (and ETH) out of **many** bot wallets into one main wallet
on Robinhood Chain. You give it a token contract address (the "CA"); for every
wallet whose key it finds in your distributor directory it runs three phases:

1. **Fund** — from a dedicated funder wallet, top up each token-holding wallet
   with *just enough* ETH to pay for one transfer (only the shortfall; wallets
   that already have gas are skipped).
2. **Collect** — each wallet signs a transfer of its **full** token balance to
   your main wallet. This can't be batched — ERC-20 needs each wallet's own
   signature — so it's ~one transaction per wallet.
3. **Refund** — sweep the **leftover native ETH** out of every wallet to your
   main wallet (recovers the gas float + any pre-existing ETH).

It only moves your own money between wallets you hold the keys to — plain value
transfers and plain ERC-20 `transfer()` calls, nothing else.

## Why three phases

At thousands of wallets, most hold the token but have little or no ETH, so they
can't pay the gas to move it. You have to send gas in first (fund), then have
each wallet send its token home (collect), then reclaim the gas you fronted plus
anything left (refund).

## Safety

- **Dry-run is the default.** Nothing sends without `--execute`. A dry-run scans
  balances and prints the full plan: how many holders, how much token to
  collect, how much ETH to fund, and the funder's balance vs. what it needs.
- **Idempotent — resume by re-running.** Every run reads live on-chain balances
  and only does what's left. A crashed run resumes by running the *same command*
  again: collected wallets (token balance 0) and already-funded wallets are
  skipped automatically. There's no mutable state file to corrupt.
- **Funder is nonce-ordered and sequential** — no nonce races or gaps. Collect
  and refund run per-wallet with bounded concurrency.
- **Private keys are never printed or logged** — only addresses, amounts, and tx
  hashes. Every send is appended to an audit log (`--log`, default
  `sweep-audit.jsonl`).
- Fund/refund sends **pin gas so `value = balance − gas`** — a refund can always
  afford itself; at worst it leaves wei of dust.
- On a partial re-run, refund **won't strip gas from a wallet that still holds
  tokens**, so a retry can finish collecting without re-funding it.

## Setup

Run this **on your server**, where the keys live.

```bash
cd tools/token-sweeper
npm install                     # ethers v6 (+ dotenv)
cp .env.example .env            # set DEST, TOKENS, FUNDER_KEY, KEYS, RPC_URL
```

The **funder** is a separate wallet you top up with ETH; its key goes in
`FUNDER_KEY` (or `--funder-keyfile PATH`). Keep it distinct from your main
wallet so your treasury key never sits on the box.

## Use

**Always dry-run first** to see the plan:

```bash
node sweep.js --dest 0xMain --token 0xCA
```

Check the holder count, the total token to collect, and especially **funder
balance vs. need**. When it looks right:

```bash
node sweep.js --dest 0xMain --token 0xCA --execute
```

If `DEST` / `TOKENS` / `FUNDER_KEY` are in `.env`, it's just:

```bash
node sweep.js            # dry-run
node sweep.js --execute  # real run (asks you to type "yes"; add --yes to skip)
```

### Interruptions

Just run the same command again. It re-scans and continues where it left off.

### Variations

```bash
# only move tokens (wallets already have gas), skip funding + refund
node sweep.js --dest 0xMain --token 0xCA --collect-only --execute

# skip a phase
node sweep.js --dest 0xMain --token 0xCA --no-refund --execute

# ETH-only sweep (no token) — e.g. a final cleanup pass
node sweep.js --dest 0xMain --phases refund --execute

# fund only as far as the funder's ETH allows, instead of aborting
node sweep.js --dest 0xMain --token 0xCA --execute --allow-partial

# batch balance reads via Multicall3 (verify the address on the explorer first)
node sweep.js --dest 0xMain --token 0xCA --multicall 0xcA11bde05977b3631167028862bE2a173976CA11
```

## Scale & RPC

Thousands of wallets means tens of thousands of RPC calls (scan + up to ~3 txs
per wallet). Use a **dedicated / paid RPC** — the public Blockscout endpoint
throttles hard. Tuning knobs:

- `--concurrency N` — collect/refund wallets in flight (default 5). Lower it if
  your RPC complains; raise it on a fast endpoint.
- `--delay MS` — pause between sends/reads (default 120).
- `--multicall 0x…` — collapses the balance scan from thousands of calls to a
  handful (falls back to per-wallet reads if unset or if it errors).

The chain's per-tx gas cap is `2^24`, which bounds multicall batch size; the
script chunks reads at 400 wallets per call.

## Key formats it auto-detects

Point `--keys` (or `KEYS`) at a directory or file. It recognises: JSON arrays of
keys; JSON arrays/objects with `privateKey` (or `pk`/`key`/…); a `wallets`/
`accounts` array; a `{ "mnemonic": "…", "count": N }` seed; `.env`-style
`PRIVATE_KEY_0=…` lines; plain text (one key or seed phrase per line); and v3
keystore JSON (needs `KEYSTORE_PASSWORD`). Duplicate addresses are merged. A seed
phrase derives `--count` addresses (default 50) at `--path` (default
`m/44'/60'/0'/0`).

## Options

`node sweep.js --help` lists everything. Key ones:

| Flag / env | Meaning |
|---|---|
| `--dest`, `DEST` | Main wallet everything sweeps to (**required**) |
| `--token`, `TOKENS` | Token CA to sweep (one) |
| `FUNDER_KEY` / `--funder-keyfile` | Funder wallet that pays gas (**required for fund**) |
| `--phases` | `fund,collect,refund` (default) or a subset, in order |
| `--keys`, `KEYS` | Where the bot-wallet keys are |
| `--rpc`, `--chain-id` | Chain (defaults: Robinhood Chain, `4663`) |
| `--multicall` | Multicall3 address for batched reads |
| `--concurrency`, `--delay` | Throughput vs. RPC load |
| `--execute` / `--yes` | Actually send / skip the confirm |
| `--allow-partial` | Fund as far as the funder allows |
| `--log` | Audit log path |

## Notes & limits

- The funder wallet itself isn't swept (it's your gas wallet). Move its leftover
  ETH manually if you want it back.
- Testing done: dry-run flow end-to-end against a live chain, unit tests of the
  fund/collect/refund arithmetic, and validation of the send primitives and the
  chainId guard. It has **not** been run through a full multi-phase live sweep in
  CI — so do a small real run first (a handful of wallets, or `--collect-only` on
  one) before turning it loose on thousands.
- Sends to `DEST` are irreversible. The dry-run and typed confirmation exist so
  you verify the destination before anything moves.
