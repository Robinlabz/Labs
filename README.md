# Robin Labs

A creator-first memecoin launchpad on **Robinhood Chain** (Arbitrum Orbit L2,
chainId 4663). One transaction launches a token into a real Uniswap v3 pool with
a bonding curve for price discovery, a "let it ride" graduation, and a
permanently-locked floor — **the Bond**. The contracts are non-upgradeable: no
proxies, no admin backdoors, the platform owner can only point new launches at a
fee wallet.

## Native token — $ROBIN

$ROBIN is the platform token. Stake it and earn **ETH**: every coin launched
through Robin Labs routes a share of its vault proceeds to stakers, paid pro-rata
in ETH (`RobinStaking` — an O(1) accumulator, no reward loops, with an
anti-just-in-time unstake delay).

## Layout

```
launchpad/   Solidity + Hardhat. The launchpad-for-many, the $ROBIN staking
             contract, the bonding curve, and the Bond graduation flow.
             Tests, fork tests, and economic sims included.
pad/         Robin Labs Pad — the web frontend (static HTML/CSS/JS, wallet +
             signing layer, live-wired to the deployed contracts).
indexer/     Reorg-safe indexer + JSON API that reads pad activity off-chain
             so the feed needs zero per-coin RPC. Docker Compose + Caddy deploy.
docs/        One markdown source → GitBook- and Mintlify-ready docs sites.
```

## Quick start

```bash
# contracts
cd launchpad && npm install && npx hardhat test

# frontend (static — serve any way you like)
cd pad && python3 -m http.server 8000

# indexer + API
cd indexer && cp .env.example .env && npm install && npm start
```

Copy each `.env.example` to `.env` before running anything that needs an RPC or
a deploy key. Real keys are never committed.

## Deployed contracts (Robinhood Chain)

| Contract | Address |
|---|---|
| Pad factory | `0x8aa92d5297fEC45cbC7F16A32F4aed5D3AC58074` |
| Pad router  | `0x1988dEFfE3799Fb56F949ffb20C65D20c1547570` |
| WETH        | `0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73` |
| UniswapV3 factory | `0x1f7d7550b1b028f7571e69a784071f0205fd2efa` |

## Disclaimer

Memecoins are high-risk and for entertainment. Nothing here is financial or
legal advice. Get a professional audit before putting real value on any
contract.
