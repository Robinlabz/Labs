# Overview

**Robin Labs Pad** is a creator-first memecoin launchpad on **Robinhood Chain**. One-transaction launches into a real Uniswap v3 pool, a bonding-curve for price discovery, a strategic "let it ride" graduation, and a permanently-locked floor — **the Bond**.

Robin Labs is a set of audited, non-upgradeable contracts. There are no proxies and no admin backdoors — the platform owner can point new launches at a fee wallet and nothing else. A launch is a single transaction that deploys the token, seeds the bonding curve, opens trading, and (optionally) executes the creator's own opening buy — atomically.

- **Real DEX from block one.** Every coin is a genuine Uniswap v3 pool, so it's chartable on DexScreener the moment it launches.
- **Approval-free buys.** Buying sends native ETH — no token approval. Selling needs one exact-amount approval to the router (never infinite, never to a personal wallet).
- **Fees ride the protocol.** The 1% is the Uniswap LP fee tier, collected in-protocol — there's never a side-transfer bolted onto your transaction.
- **Un-ruggable graduation.** At graduation, liquidity is posted to the Bond and locked forever, with a WETH floor that only deepens with volume.

## Architecture

A coin's whole life touches four contracts:

| Contract | Owns |
|----------|------|
| `CurvePadFactory` | Deploys the token + curve + pool in one tx, registers the coin with the router, runs the anti-snipe opening buy. |
| `CurvePool` | The bonding curve — a single-sided v3 position spanning `[startTick → gradTick]`. Owns graduation and the "let it ride" logic. |
| `PadRouter` | The only trade path. Applies the 1% fee in-protocol, splits it to escrows, exposes dev fee controls. |
| `Bond` | Protocol-owned floor posted at graduation and locked forever — *Sherwood* (full-range LP), *Bounty* (WETH buy-wall), *Ambush* (token sell-wall). Fees compound back in via `poke()`. |
