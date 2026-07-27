# Robin Labs — Uniswap Trading API integration

**Product:** [robinlab.io](https://robinlab.io) — a token launchpad and trading front-end on **Robinhood Chain (chainId 4663)**.

**What we're building:** users swap the chain's top tokens directly on our site. We integrate the
Uniswap Trading API for pricing and execution so trades route through the canonical Universal
Router on 4663, rather than us running our own routing contract.

## Endpoints we use

- `POST /v1/quote` — price a swap (EXACT_INPUT), both native ETH and ERC20 in/out.
- `POST /v1/swap` — build the executable transaction for the quoted route.
- `POST /v1/check_approval` — determine and build any token approval / Permit2 step for sells.

All calls target `chainId 4663`. Buys are native-ETH in; sells are ERC20 in, native-ETH out.

## How we call it (key handling)

- The API key is held **server-side only**, in our indexer service's environment. It is never
  shipped to the browser and never committed to source control.
- The browser calls **our own proxy** (`/api/swap/*` on `api.robinlab.io`); the proxy injects the
  key and forwards to the Uniswap Trading API.
- The proxy **validates every request**: only `chainId 4663`, only a curated token allowlist, and
  bounded amounts. It **caches quotes** briefly and **rate-limits per client IP**, so a launch-day
  crowd is largely served from cache and only a small stream of unique quotes reaches the key.

## Traffic

- Curated set of roughly 20 tokens, WETH-quoted.
- Bursty, launch-day-style spikes (memecoin trading). We're requesting a production rate-limit
  tier for headroom; steady-state load on the key is low thanks to the proxy cache.

## Non-custodial

We take no custody of user funds. Quotes and the executable transaction come from the Trading
API; the user's own wallet signs and submits the swap to the Universal Router. Robinhood Chain
has no EIP-1559, so transactions are submitted as legacy (type-0) with an explicit gas price.

## Contact

Robin Labs — see [robinlab.io](https://robinlab.io).
