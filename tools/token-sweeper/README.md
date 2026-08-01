# Robin token sweeper

Consolidate funds **out of** your bot wallets and **into** one main wallet on
Robinhood Chain. You give it a token contract address (the "CA"); for every
wallet whose key it finds in your distributor directory it:

1. sends that token's **entire balance** to your main wallet, then
2. sweeps the **leftover native ETH** (minus exactly enough for gas).

It only signs plain ERC-20 `transfer()` calls and a plain ETH value transfer —
moving your own money between wallets you hold the keys to.

## Safety

- **Dry-run is the default.** Nothing is sent unless you pass `--execute`.
- A dry-run prints every derived wallet, its balances, and what *would* move.
- With `--execute` it still shows the plan and makes you type `yes` (skip with
  `--yes` for automation).
- Private keys are **never printed or logged** — only addresses, amounts, hashes.
- Tokens are swept **before** ETH (moving a token needs gas; sweep the ETH first
  and the token transfer would fail with an empty tank).
- The ETH sweep pins gas so `value = balance − gas` exactly — the transaction
  can always afford itself; at worst a few wei of dust stays behind.

## Setup

Run this **on your server**, where the keys actually live.

```bash
cd tools/token-sweeper
npm install                     # pulls ethers v6 (+ dotenv)
cp .env.example .env            # then edit .env: set DEST (and KEYS if different)
```

## Use

Dry-run first — always:

```bash
node sweep.js --dest 0xYourMainWallet --token 0xTokenCA
```

Check the wallet list and the "would send" totals. When it looks right:

```bash
node sweep.js --dest 0xYourMainWallet --token 0xTokenCA --execute
```

If `DEST` / `KEYS` / `TOKENS` are in your `.env`, it's just:

```bash
node sweep.js --execute          # dry-run without --execute
```

### Common variations

```bash
# multiple tokens
node sweep.js --token 0xA,0xB --dest 0xMain

# only sweep leftover ETH, leave the tokens
node sweep.js --eth-only --dest 0xMain --execute

# only sweep the token, leave the ETH for later
node sweep.js --token 0xCA --tokens-only --dest 0xMain --execute

# fully unattended (no prompt), a few wallets at a time
node sweep.js --token 0xCA --dest 0xMain --execute --yes --concurrency 3
```

## Key formats it auto-detects

Point `--keys` (or `KEYS`) at a directory or a single file. It recognises:

| Shape | Example |
|---|---|
| JSON array of keys | `["0xabc…", "0xdef…"]` |
| JSON array of objects | `[{ "address": "0x…", "privateKey": "0x…" }]` |
| JSON with a wallets/accounts array | `{ "wallets": [ … ] }` |
| JSON with a seed phrase | `{ "mnemonic": "word word …", "count": 20 }` |
| `.env`-style lines | `PRIVATE_KEY_0=0x…` / `PK1=0x…` |
| plain text | one key or one seed phrase per line |
| keystore v3 JSON | needs `KEYSTORE_PASSWORD` set |

If a seed phrase is found, it derives `--count` addresses (default 50) at
`--path` (default `m/44'/60'/0'/0`). Duplicate addresses across files are merged.

## Options

Run `node sweep.js --help` for the full list. Key ones:

- `--dest, --to` — destination main wallet (**required**)
- `--token` — token CA(s), comma-separated or repeated (or a positional arg)
- `--keys` — where the keys are (default `/root/robin-dist/robin-distributor-contract/`)
- `--rpc`, `--chain-id` — chain (defaults to Robinhood Chain, `4663`)
- `--execute` / `--yes` — actually send / skip the confirm prompt
- `--eth-only`, `--tokens-only` / `--no-eth`
- `--concurrency N` — wallets in flight (default 1)

## Notes

- A wallet needs a little ETH to move its tokens. If a wallet holds tokens but
  ~0 ETH, its token transfer will fail — fund it a touch, then re-run (already
  swept wallets just show 0 and are skipped).
- Sends to `DEST` are irreversible. The dry-run and the typed confirmation are
  there so you verify the destination before anything moves.
