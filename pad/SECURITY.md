# The Sheriff's Pad — signing safety (audit before deploy)

Our anti-drainer rulebook was written for Solana / Phantom / Blowfish. Robinhood
Chain is an **EVM L2**, so the primitives are different (no `SystemProgram`, no
Jupiter, no client-side mint keypair) — but every safety rule maps 1:1. This
doc is the translation and the pre-deploy checklist. The enforcement lives in
`assets/wallet.js` (each rule is tagged `[Rule N]` in the code) and
`assets/config.js`.

Everything here is public. No RPC keys, no secrets — those never leave the
server / your `.env`.

---

## Rule-by-rule: Solana → EVM

### Rule 1 — No `approve` / `delegate` / `setAuthority` in a user-signed tx
The classic drainer signature. On EVM the equivalents are `approve`,
`increaseAllowance`, `setApprovalForAll`, and `permit`.

- **Launch** (`launch()`): approval-free. The only value moved is native ETH via
  `msg.value` (the optional dev buy). No token touches an allowance.
- **Buy** (`exactInputSingle`, `tokenIn = WETH` + `msg.value`): approval-free.
  We pay **native ETH**; the router wraps it. The buyer never approves anything.
- **Sell**: EVM has **no** approval-free way to sell a standard ERC-20 through an
  AMM. So this is the single, isolated approval in the whole app — and we keep it
  the safe form Blowfish does **not** flag:
  - **exact amount**, never `MaxUint256` / infinite;
  - to **our own explorer-verified `PadRouter`** only (never an unknown
    contract). Robinhood Chain has no canonical Uniswap periphery, so PadRouter
    *is* the swap desk every trade goes through;
  - **simulated first**, and only sent if allowance is short.
  We never use `permit` (a gasless approval is still an approval and reads as one
  to scanners).

### Rule 2 — One recipient, one signer, feePayer = the user. No fan-out.
- `launch()` sends to **one** contract (the factory). Swaps go to **one** router.
- No multi-recipient transfer is ever bundled into a signed tx. Any splitting
  (platform vs. creator, fee routing) happens **in-protocol or off-chain**, never
  as extra transfer calls in the user's tx.

### Trading fee — a swap-desk fee, not a token transfer tax
Every coin pays a **swap-desk fee taken by `PadRouter`** (the EVM equivalent of
Jupiter's `platformFee`) — **not** a fee-on-transfer token (that would break
Uniswap v3 and flag as a honeypot). The token itself stays clean and tradeable.
- **1% floor, 4% cap per side**, enforced on-chain at registration.
- The **default 1% is the platform's** — 0.9% immediate, 0.1% held until the coin
  graduates.
- Anything **above 1%** splits **25% → the platform's $SHERIFF cut** (paid to the
  platform, which buys/burns $SHERIFF off-chain), **75% → the project** (wallet /
  Bond floor / auto-burn).
- Every share is computed **inside the router** and paid out by separate,
  permissionless escrow flushers — **never** as extra transfers inside the user's
  signed trade. So a bad project wallet or paused Bond can't revert a trade, and
  the signed tx is still one call to one router (Rules 2 & 4 hold).

### Rule 3 — Fees ride the protocol's native fee, not a side transfer
- Solana: Jupiter `platformFee` → referral account.
- EVM: the platform's own 1% and every project tax are taken **at the swap desk**
  (`PadRouter`), collected as escrow and paid out separately. There is **never**
  an extra fee-transfer instruction bolted onto a user's swap. If a fee path is
  ever unavailable, trading still
  falls back to a plain swap — it never hard-fails.

### Rule 4 — Swaps are the standard single-signer shape
- Every EVM tx is single-signer by construction (`from` = the connected wallet).
  We use the canonical `exactInputSingle` shape — nothing custom that a scanner
  wouldn't recognize.

### Guard — simulate + balance-check BEFORE any signature
Phantom's scary red "malicious / blocked" screen is usually just *insufficient
funds*. We never let the user reach it:
1. `staticCall` the exact tx (an `eth_call` simulation) — catches contract
   reverts (anti-snipe cap, dev-buy > 2%, slippage) up front.
2. `estimateGas` (a second simulation) to price it.
3. `getBalance` ≥ `value + gasCost + GAS_BUFFER_WEI` — if not, we show a calm
   "Not enough ETH — needs ≈ X, you have Y" **locally**, and never open the
   wallet.
4. Only then send.

See `guardedSend()`.

### Link — `signMessage` for ownership, kept off the payment path
Binding a wallet to Telegram uses `personal_sign` (`linkTelegram()`) — a **free
signature, not a transaction**, never flagged. It moves no funds and is entirely
separate from any payment, exactly as on Solana.

### Deploy/launch — simulate before signing; nothing custom leaves the browser
Solana generates a mint keypair client-side. On EVM there is no client keypair:
the **factory contract** deploys the token deterministically on-chain. The
browser only builds and **simulates** the `launch()` call before asking for a
signature. Same spirit (nothing opaque leaves the browser, always simulate),
different mechanism.

---

## TL;DR checklist (enforced in code)

- ✅ Single-recipient, single-signer, feePayer = the user
- ✅ Simulate + balance-check before every signature
- ❌ No `approve` / `delegate` / `setApprovalForAll` / `permit` on launch or buy
- ⚠️ Sell = the one approval: **exact amount, verified router, simulated** (EVM
  has no approval-free AMM sell)
- ❌ No multi-recipient transfer inside a signed tx (splits are escrowed in the
  router, paid out separately)
- ✅ Fee = swap-desk fee (platform 1% + project tax ≤4%/side, platform's 25% cut),
  never a side transfer bolted onto the trade
- ✅ `signMessage` for ownership, separate from payment

---

## Pre-deploy checklist (fill `config.js`, then flip live)

Buys/sells and launch are **gated** until these are set — the UI honestly says
"opens at launch" and no tx can go to a zero/wrong address (`isDeployed()`).

1. Deploy `PadRouter` (the swap desk + tax) and `CurvePadFactory` (+ deployers)
   to Robinhood Chain. Wire them: `router.setFactory(factory)`. **Verify both on
   the explorer.** Set `CONTRACTS.padRouter` and `CONTRACTS.padFactory`.
2. (Recommended) Point the min-out estimate at a real quoter if one is deployed;
   otherwise the spot-price fallback (with a slippage buffer) applies.
3. Re-run the fork tests (`FORK_RPC=<archive rpc>`): the dev-buy test and the
   `PadRouter` tax test, plus the `padrouter` mock unit test, against the
   deployed addresses.
4. Independent review of `wallet.js` + `PadRouter.sol` against this doc.
5. Test on Robinhood Chain with a real wallet: launch (no dev buy), launch (with
   dev buy + a tax), buy, sell, and the Telegram signature — confirm none trip
   Blowfish, and that the tax split lands in the escrows as expected.

## Trust surface

- **`assets/wallet.js`** — all in the open. The whole client-side safety story.
- **`launchpad/contracts/PadRouter.sol`** — the swap desk + project tax. Its tax
  math is verified to the wei in `launchpad/test/padrouter.test.js` (and on a real
  fork in `test/fork/padrouter.fork.test.js`).
- **`assets/config.js`** — addresses + ABIs, no secrets.
- **`assets/ethers.min.js`** — ethers **v6.13.4**, vendored (no runtime CDN), so
  the app is self-contained and pinned. Verify its hash against npm if desired.
- **RPC** — a public read-only endpoint for balances/quotes/simulation. The
  private archive RPC used by the fork tests is never shipped to the browser.
