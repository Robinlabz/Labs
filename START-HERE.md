# START HERE — Robin Labs Launchpad

**Read this first.** It is the single orientation map for the Robin Labs launchpad: what the product is,
what is live on-chain, how the money model works, what lives in this repo, and where the docs are.
Last updated: 2026-08-15.

---

## 1. What this is

**Robin Labs** — a creator-first **memecoin launchpad on Robinhood Chain** (Arbitrum Orbit L2, EVM,
**chainId 4663**). One transaction launches a token into a real Uniswap v3 pool with a bonding curve for
price discovery, a **ceiling-only graduation at 4.2 ETH raised** (the creator receives **0.5 ETH** at
graduation), a permanently-locked protocol-owned floor — **the Bond** — and holder staking.

The contracts are **non-upgradeable**: no proxies, no admin backdoors. The platform owner can retune fee
splits within hard-capped bounds and point new launches at a fee wallet — nothing more.

Brand: neon lime `#dce905` on black.

> **Formerly branded `$SHERIFF`** (Sheriff of Nottingham theme). Any `$SHERIFF`-named file or folder you
> encounter is the **old branding of this same project**, not a separate one.

**This repository — <https://github.com/Robinlabz/Labs> — is the canonical public repo for Robin Labs.**
It is the only repo to reference, link, or hand to a third party (Uniswap, launchers, integrators, docs).

## 2. Repo map

```
launchpad/   Solidity + Hardhat. The launchpad-for-many, the bonding curve, the Bond graduation
             flow, and RobinStaking ($ROBIN → ETH). Unit tests, fork tests, and economic sims.
pad/         Robin Labs Pad — the static web frontend (HTML/CSS/JS + wallet/signing layer),
             wired to the deployed contracts. No backend needed to run it.
indexer/     Reorg-safe Node indexer + JSON API. Serves the feed and per-coin data so the
             frontend needs zero per-coin RPC. Docker Compose + Caddy deploy.
docs/        One markdown source (docs/src/*.md) → GitBook- and Mintlify-ready docs sites.
```

Key files inside those trees:

| Path | What it is |
|---|---|
| `launchpad/SPEC.md` | Full protocol design, confirmed on-chain facts, threat model |
| `launchpad/README.md` | Contract roles, develop/deploy/launch instructions |
| `pad/assets/config.js` | Every address + ABI the frontend uses — **audit this file first** |
| `pad/SECURITY.md` | Frontend security notes |
| `indexer/README.md` | Indexer + API deploy |
| `docs/manifest.json` | Doc page index; `docs/build.mjs` generates both doc sites |

## 3. Quick start

```bash
# contracts
cd launchpad && npm install && npx hardhat test

# frontend (static — serve any way you like)
cd pad && python3 -m http.server 8000

# indexer + API
cd indexer && cp .env.example .env && npm install && npm start
```

Copy each `.env.example` to `.env` before running anything that needs an RPC or a deploy key.
**Real keys are never committed.**

## 4. Live on Robinhood Chain (mainnet, chainId 4663)

**Deployment v2.1 — deployed 2026-07-24.** Factory deploy block **17752965** (use this as the indexer's
`START_BLOCK`). All contracts verified on Blockscout.

| Contract | Address |
|---|---|
| **CurvePadFactory** (launch) | `0x8aa92d5297fEC45cbC7F16A32F4aed5D3AC58074` |
| **PadRouter** (all trades) | `0xA6BaAB820809C7fC8350311776627298f91F07eC` |
| **FeeConfig** (fee dial) | `0x064D977B66FCC29256510dBCD8cC0C51bBb2De14` |
| **FloorCoopFactory** | `0x564EDF561Bed46C972d5D44D84f5FAc9C5118668` |
| **PlatformFeeSplitter** | `0xca0EfD87B983CdeF56459051ecBE91aA5C87E17a` |
| LaunchTokenDeployer | `0xb3748cB6ba4e47b885f8333aCa8C004A4657383d` |
| CurvePoolDeployer | `0x020524511aD8B99828b19DA0FD3Bb7BE919A080c` |
| BondDeployer | `0x8B04d9e55C904d6D371eA6e81ecb2a0911843AD3` |
| RewardVault | `0x03d5d26E492B288e62D897E7dde91af3CceB4347` |
| TokenVestingLock | `0x7453856c3E5f6832dc660e48c7Daa6f46f3355DF` |
| WETH (chain infra) | `0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73` |
| Uniswap v3 Factory (chain infra) | `0x1f7d7550b1b028f7571e69a784071f0205fd2efa` |

- **Owner / platform / poster / guardian / floor treasury:** cold wallet
  `0xCDD5ff5d521D3694c2a2F31eDF7cd3C0E9a6fabf`
- **Public RPC:** `https://robinhoodchain.blockscout.com/api/eth-rpc`
- **Explorer:** <https://robinhoodchain.blockscout.com>
- **Site:** www.robinlab.io / www.robinlabs.fun
- **API:** `api.robinlab.io` (see `indexer/`)
- **Coin sites:** each launched coin can claim its own `<slug>.robinlabs.fun` site — the creator connects
  their wallet, picks a style and slug, and signs once.

Robin Labs depends on the **verified Uniswap v3 factory + pool only** — there is no
NonfungiblePositionManager or SwapRouter for that factory on this chain. All liquidity and swaps go
through pool callbacks.

## 5. The money model (v2.1 — what is live today)

All splits below are owner-tunable through `FeeConfig` within hard caps — **no redeploy**, retuned from
`pad/admin.html` → Fee dials (owner-only).

- **LP fee** — the in-protocol Uniswap 1% charged on every trade: **platform 90% / creator 10%**
  (`lpCreatorBps = 1000`, hard cap 5000 = 50%). Swept by `CurvePool.collectFees()`; principal is never
  touched.
- **Swap-desk fee** — the router's cut: **platform 45% / creator 45% / floor 10%**
  (`swapPlatformBps / swapCreatorBps / swapFloorBps = 4500 / 4500 / 1000`, must sum to 10000). Applied in
  `PadRouter._distribute`.
- **Graduation** — ceiling-only at **4.2 ETH** raised. There is no dev-settable target and no timeout: a
  coin graduates at exactly one price, the top of the curve. The **creator receives 0.5 ETH** at
  graduation; the rest funds the permanently-locked floor.
- **Burn** — `MilestoneVault` holds 30% of supply and sells TWAP-gated tranches at 2x/3x/… milestones,
  splitting **50% dev / 50% buyback**. The dev-triggered buyback holds WETH, swaps to the token, and burns
  it to `0x…dEaD`. The vault has **no withdraw and no sweep**.
- **Liquidity** — `LiquidityLocker` owns every launch's full-range LP position and is **`collect`-only**
  (fees to a fixed beneficiary, no burn), so liquidity is locked forever.

Per-coin supply is **1,000,000,000**. The base fee is 1% per side — the Uniswap v3 pool's own fee tier.

## 6. $ROBIN — the platform token

$ROBIN is the Robin Labs platform token. Stake it and earn **ETH**: every coin launched through Robin Labs
routes a share of its vault proceeds to stakers, paid pro-rata in ETH. `RobinStaking` is an O(1)
accumulator — no reward loops — with an anti-just-in-time unstake delay.

## 7. Docs

`docs/src/*.md` is the single source; `docs/build.mjs` generates both the GitBook (`docs/gitbook/`) and
Mintlify (`docs/mintlify/`) sites. Pages: overview, network & addresses, contracts & ABI, build-a-bot,
integration guide, fee model, graduation, security. Edit `docs/src/`, never the generated trees.

## 8. State of this repo

The tracked code here is a **snapshot taken 2026-07-17**, which **predates the v2.1 mainnet deployment**
of 2026-07-24. Two consequences worth knowing before you read the code:

1. The v2.1 fee stack (`FeeConfig`, `PlatformFeeSplitter`, `FloorCoop`) is **live on-chain but not yet in
   this tree**. The address table and money model in §4–§5 above describe what is actually deployed and
   are the authoritative reference until the snapshot is refreshed.
2. `README.md` and `launchpad/README.md` still describe the pre-v2.1 shape — an older address set and a
   "let it ride" graduation. **Graduation is ceiling-only** (§5). Where those READMEs and this file
   disagree, **this file is correct**.

Refreshing the snapshot to v2.1 is tracked work, not a defect in the deployment.

## 9. What is next — the v4 rewrite

A next-generation rewrite of the launchpad on **Uniswap v4 hooks** exists. Its contracts and tests are
complete and it is **audit-pending and not deployed** — nothing about it is live, and its fee model
**diverges** from the v2.1 model in §5. It is not in this repo yet, and its economics are not published
here, so **do not quote v4 numbers as Robin Labs' fee model**: anything live today is §5.

## 10. Rules

- **Canonical repo is this one** — `https://github.com/Robinlabz/Labs`. Every link, doc, and integration
  write-up handed to a third party points here.
- **Never commit a secret.** No private keys, no `.env`, no API tokens. A key that has ever been exposed
  must not be reused for mainnet.
- **Any fee sheet must state which version it represents.** The live model is v2.1 (§5).

## Disclaimer

Memecoins are high-risk and for entertainment. Nothing here is financial or legal advice. Get a
professional third-party audit before putting real value on any contract.
