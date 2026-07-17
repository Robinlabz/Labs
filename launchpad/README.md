# $ROBIN Launchpad (Robinhood Chain)

A fair-launch **launchpad-for-many** on **Robinhood Chain** (Arbitrum Orbit L2, chainId 4663). Any team
launches a token that is **tradeable on Uniswap v3 + DexScreener-indexed day one**, with a rule-bound
30% treasury, automatic buy-and-burn, a 1% platform fee, and launch-time anti-snipe guards.

> ⚠️ **Not audited. Reference implementation.** An internal adversarial review was run, but you MUST get a
> professional third-party audit before putting real value on mainnet. Nothing here is financial/legal advice.

See **[SPEC.md](./SPEC.md)** for the full design, the confirmed on-chain facts, and the threat model.

## Contracts
| Contract | Role |
|---|---|
| `LaunchpadFactory` | `launch()` does the whole atomic sequence; owns the LP mint callback; deploys each `MilestoneVault`. Also deploys the shared `LiquidityLocker`. |
| `LaunchToken` | Clean, tax-free ERC20 + auto-expiring, buy-side-only anti-snipe guard. |
| `MilestoneVault` | Holds 30%. Permissionless TWAP-gated tranche sells at 2x/3x/… Splits 50% dev / 50% buyback. Dev-triggered buy-and-burn to `0xdead`. No withdraw/sweep. |
| `LiquidityLocker` | Owns every launch's full-range LP position. `collect`-only (fees to a fixed beneficiary), no burn → liquidity locked forever. |
| `FeeRouter` | The only place the 1% platform fee lives — skims the WETH leg. `FEE_BPS` immutable, no `setFee`. |

Depends on the **verified Uniswap v3 factory + pool only** — no NonfungiblePositionManager / SwapRouter
(none exist for that factory on this chain). All liquidity/swaps go through pool callbacks. No TickMath/FullMath
(milestone gates use tick-offset arithmetic; only OZ `Math` is used).

## Develop
```bash
cd launchpad
npm install
npx hardhat compile
npx hardhat test        # 14 unit tests against mock v3 pool/factory
```

## Deploy (Robinhood Chain)
```bash
# set a funded deployer key + governance addresses
export PRIVATE_KEY=0x...
export OWNER=0xYourMultisig
export FEE_RECIPIENT=0xYourFeeMultisig
export ROBINHOOD_RPC=https://<your-rpc>     # a real RPC; the blockscout proxy is read-only-ish

npx hardhat run scripts/deploy.js --network robinhood
```
`WETH` and `V3_FACTORY` default to the confirmed Robinhood Chain addresses (override via env).

## Launching a token (`LaunchpadFactory.launch`)
`msg.value` must equal `seedEth + launchFeeWei`. Key params:
- `totalSupply`, `seedEth` (WETH side of the LP), `dev` (buyback trigger + 50% payout + LP-fee beneficiary)
- `multiplesX100` (e.g. `[200,300,400]`) and `tranches` (token per milestone, **must sum to exactly 30%** of supply)
- `cardinalityNext` (TWAP cardinality — size to hold ~30 min of history), `twapWindow` (e.g. `1800`)
- `salt` (pass a random/secret value), `guard` (anti-snipe windows/caps)

Milestones fire off the pool's 30-min TWAP; run a keeper that calls `vault.poke()` (permissionless) or wire
Gelato/Chainlink to `vault.pending()`.

## Before mainnet — must confirm
- Third-party audit.
- Is Arbitrum **Timeboost** enabled on 4663? (sizes anti-snipe params; if yes, submit `launch()` via the express lane).
- `factory.feeAmountTickSpacing(10000) == 200` (asserted in the factory constructor).
- Robinhood Chain **block time** (size `cardinalityNext` for a real 30-min TWAP).
- Native gas token is ETH and `IWETH9(WETH).deposit` is the correct wrap path.
- Governance: set `OWNER`/`FEE_RECIPIENT` to a multisig (ideally behind a 48h timelock).
