# Robin Labs — Handoff Brief

Read this first. It's the full context for anyone (or any new session) picking up
Robin Labs. Everything you need to continue is here.

## What Robin Labs is

A creator-first **memecoin launchpad on Robinhood Chain** (Arbitrum Orbit L2,
EVM, chainId **4663**). One-transaction launches into a real Uniswap v3 pool, a
bonding curve, a strategic "let it ride" graduation, and a permanently-locked
protocol-owned floor — **the Bond**. Neon lime (`#dce905`) on black brand.

## Repo layout (the parts that matter)

```
launchpad/     Solidity contracts + Hardhat tests (the protocol)
  contracts/   CurvePadFactory, PadRouter, CurvePool, Bond, libraries
  AUDIT.md     audit findings + resolutions (KEEP PRIVATE — details attack surface)
pad/           the static frontend (no backend needed to run)
  index.html   home / browse feed (matches the brand mockup)
  create.html  launch a coin
  token.html   trade + graduation + dev controls
  promo.html   FOMO landing
  docs.html    branded dev docs
  admin.html   platform ownership (acceptOwnership)
  assets/      config.js (addresses/ABIs), wallet.js (signing), ethers.min.js, logo/favicons
indexer/       optional Node indexer + JSON API (SQLite, Docker, Caddy) — makes the feed fast
docs/          GitBook- + Mintlify-ready docs generated from docs/src/*.md
```

## Live on Robinhood Chain (mainnet)

| Contract | Address |
|----------|---------|
| CurvePadFactory | `0xc208e393990B6f2BC8D0d330E0be38C6eCA1e25B` |
| PadRouter | `0x1988dEFfE3799Fb56F949ffb20C65D20c1547570` |
| WETH | `0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73` |
| UniswapV3Factory | `0x1f7d7550b1b028f7571e69a784071f0205fd2efa` |

- RPC (public): `https://robinhoodchain.blockscout.com/api/eth-rpc`
- Explorer: `https://robinhoodchain.blockscout.com`
- Factory deploy block (for the indexer `START_BLOCK`): **11556704**
- Contract owner (both): platform wallet `0xCD04919a51bc0866BbA48c300465425d8fF83160`
  (two-step transfer — pending accept via `pad/admin.html`; may already be done)

## Economics (already implemented in the contracts)

- Total supply per coin: 1,000,000,000. Base fee: 1% per side (100 bps), max 4%.
- **Buy 1% → platform.** **Sell 1% → creator** (escrowed; collect or buy+burn).
- Above-1% "raised" fee splits 25% platform / 75% project.
- **Graduation reward: 25% of the raise → creator.** Sherwood LP fees compound
  back into the Bond via `poke()`.
- Graduation "let it ride": eligible ~$30k mcap, ceiling ~$76k, dev-settable
  target (default 40% up), 7-day abandon-proof timeout.

## Status

- ✅ Contracts deployed + audited (3 internal passes + live mainnet lifecycle test).
- ✅ Frontend built + rebranded to Robin Labs art (logo/favicons from the real mark).
- ✅ Indexer + API (reorg-safe, precomputed snapshots, scales behind a CDN).
- ✅ Docs (branded page + GitBook/Mintlify sources).
- ⏳ Native token **$ROBIN** + staking/real-yield rewards — DESIGN IN PROGRESS
  (see "Native token" below).
- ⏳ Go-live: host `pad/`, run the indexer on a DigitalOcean droplet (Docker
  compose + Caddy), point the domain, set `API_BASE` in `pad/assets/config.js`.

## Native token plan ($ROBIN) — in progress

- Fair-launch **on Robin Labs itself** (dogfood; graduates into its own floor).
- **Reward holders with real ETH** (a cut of platform fees → a staking
  distributor; stakers claim ETH). Optional buyback&burn + hold-to-perks.
- Key: rewards are ETH, so no big token treasury is required — fair launch works.
- No router redeploy needed: route already-collected platform ETH into a
  `RobinStaking` distributor.

## How to run / verify

- Frontend: `cd pad && python3 -m http.server 8080` → open a page. Works on the
  public RPC with zero backend (the indexer only speeds up the feed).
- Indexer: `cd indexer && cp .env.example .env` (set `START_BLOCK=11556704`,
  `RPC_URL`, `SITE_DOMAIN`) → `docker compose up -d`.
- Docs: edit `docs/src/*.md`, run `node docs/build.mjs`, connect the output
  folder to GitBook or Mintlify.

## Hard constraints (do not break)

- **Never commit secrets.** Real `.env` files are gitignored; only `.env.example`
  placeholders are tracked. Never commit an RPC key or private key.
- **No AI fingerprints** in any public artifact (contracts, docs, frontend). The
  audit write-ups were scrubbed of tooling references — keep it that way.
- Keep `AUDIT.md` and `pad/overview.html` **private** (they detail attack
  surface) — share directly with an auditor, don't host them.
- Brand: logo mark is `pad/assets/logo-mark.png`; brand color `#dce905`.
