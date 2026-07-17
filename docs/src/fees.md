# Fee Model

Every coin pays a mandatory **1% per side**. A creator may set a side higher (up to 4%); the amount *above* 1% is the "raised" fee and splits 25% platform / 75% project.

| Flow | Goes to | Detail |
|------|---------|--------|
| Buy 1% base | **Platform** | 0.9% immediately, 0.1% released at graduation |
| Sell 1% base | **Creator** | Escrowed; collect to wallet or buy+burn |
| Above-1% (raised) | 25% platform / 75% project | Project 75% splits by `walletBps` / `floorBps` / `burnBps` |
| Graduation reward | **Creator** | **25% of the raise** paid at graduation |
| Sherwood LP fees | **The floor** | Compound back into the locked Bond via `poke()` |

> **Creator income** = the 1% sell tax + the 25% graduation reward + any project share of raised tax. Every share is escrowed and paid by separate permissionless flushers, so a trade can never revert on a payout. Accounting is exact to the wei.

## Why fees ride the protocol

The base 1% *is* the Uniswap v3 pool's fee tier — it's collected in-protocol as LP fees, not as an extra transfer bolted onto the user's transaction. This keeps every trade a clean, single-recipient swap: no fan-out, no side transfers, nothing for a wallet's transaction scanner to flag.
