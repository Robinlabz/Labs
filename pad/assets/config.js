// ─────────────────────────────────────────────────────────────────────────────
// Robin Labs Pad — on-chain config (audit this file first)
//
// Everything the front-end needs to talk to the chain lives here, in the open.
// No secrets: RPC keys stay server-side; this file only holds public addresses.
//
// Addresses marked `DEPLOY:` are filled in AFTER we deploy the contracts and
// have verified them on the explorer. Until then the flows that need them stay
// GATED (the UI says "opens at launch") — nothing can silently send a tx to a
// zero / wrong address. See isDeployed().
// ─────────────────────────────────────────────────────────────────────────────

export const CHAIN = {
  id: 4663,
  hexId: "0x1237", // 4663
  name: "Robinhood Chain",
  currency: { name: "Ether", symbol: "ETH", decimals: 18 },
  // Public RPC. The fork tests use a private archive RPC (never committed); this
  // read-only public endpoint is enough for balances, quotes and simulation.
  rpc: ["https://robinhoodchain.blockscout.com/api/eth-rpc"],
  explorer: "https://robinhoodchain.blockscout.com",
};

export const CONTRACTS = {
  // Known infrastructure on Robinhood Chain (the same addresses the fork tests
  // run against — real Uniswap v3 + WETH, not mocks).
  weth: "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73",
  v3Factory: "0x1f7d7550b1b028f7571e69a784071f0205fd2efa",

  // Our CurvePadFactory (one-call launch) — LIVE on Robinhood Chain.
  padFactory: "0xc208e393990B6f2BC8D0d330E0be38C6eCA1e25B",

  // Our PadRouter — the swap desk + project fee. Robinhood Chain has no canonical
  // Uniswap periphery, so THIS is the router every trade goes through — LIVE.
  padRouter: "0x1988dEFfE3799Fb56F949ffb20C65D20c1547570",

  // The platform's buy-back token + its WETH pool (for links / a future buy widget).
  // The above-default fee's 25% cut is paid to the platform, which buys+burns the
  // platform token off-chain — the router does not swap it on-chain. TBD for Robin Labs.
  platformToken: "",
  platformPool: "",
};

// 1% pool tier — the fee is collected as Uniswap LP fees IN-PROTOCOL. There is
// never a separate fee-transfer instruction bolted onto a user's tx (Rule 3).
export const POOL_FEE = 10000;

export const TOTAL_SUPPLY = 1_000_000_000n; // whole tokens (18 decimals added on-chain)
export const MAX_DEVBUY_BPS = 200n; // contract-enforced 2% cap on the dev's opening buy
export const DEFAULT_FEE_BPS = 100; // the baseline 1% every coin pays (also the floor)
export const MAX_TAX_BPS = 400; // contract-enforced 4% cap per side
export const EXCESS_PLATFORM_BPS = 2500; // 25% of the ABOVE-default fee → platform buy-back

// Gas headroom we require ON TOP of a tx's value before we ever ask a wallet to
// sign, so the wallet never shows its red "insufficient funds / blocked" screen
// (Rule: guard BEFORE signing). ~0.0008 ETH is generous for an L2.
export const GAS_BUFFER_WEI = 800_000_000_000_000n; // 0.0008 ETH

// Minimal ABIs (human-readable — ethers parses these). We deliberately keep the
// surface tiny and readable instead of pasting giant JSON blobs.
export const ABIS = {
  // Our launch entrypoint. Payable: any ETH sent is the dev's OWN opening buy
  // (≤2%), executed atomically before trading opens. Carries the project's tax.
  padFactory: [
    "function launch((string name, string symbol, address dev, (uint16 buyBps, uint16 sellBps, uint16 walletBps, uint16 floorBps, uint16 burnBps, address projectWallet) tax) p) payable returns (address token, address curve, address pool)",
    "function tokenCount() view returns (uint256)",
    "function allTokens(uint256) view returns (address)",
    "function recordOf(address) view returns (address token, address curve, address dev, uint256 at)",
    "event Launched(address indexed token, address indexed curve, address indexed pool, address dev, uint256 devBought)",
  ],
  // Our PadRouter. Buys send native ETH (no approval); sells need one exact-amount
  // approval to the router. The tax split happens inside — no side transfers.
  padRouter: [
    "function buy(address token, uint256 minOut) payable returns (uint256 tokensOut)",
    "function sell(address token, uint256 amountIn, uint256 minOutEth) returns (uint256 ethOut)",
    "function configOf(address token) view returns ((address pool, address curve, address projectWallet, uint16 buyBps, uint16 sellBps, uint16 walletBps, uint16 floorBps, uint16 burnBps, bool set))",
    "function devEscrow(address) view returns (uint256)",
    "function bondOf(address) view returns (address)",
    "function withdrawDev(address token)",
    "function burnDev(address token)",
  ],
  // The CurvePool — the bonding curve + graduation. Read progress, drive the
  // graduate button + the dev's auto-graduate target.
  curve: [
    "function pool() view returns (address)",
    "function dev() view returns (address)",
    "function bond() view returns (address)",
    "function seeded() view returns (bool)",
    "function graduated() view returns (bool)",
    "function ready() view returns (bool)",
    "function seedTime() view returns (uint64)",
    "function startTick() view returns (int24)",
    "function minGradTick() view returns (int24)",
    "function gradTick() view returns (int24)",
    "function gradTarget() view returns (int24)",
    "function setGradTarget(int24 targetTick)",
    "function graduate()",
  ],
  erc20: [
    "function balanceOf(address) view returns (uint256)",
    "function allowance(address owner, address spender) view returns (uint256)",
    "function approve(address spender, uint256 value) returns (bool)",
    "function decimals() view returns (uint8)",
    "function symbol() view returns (string)",
    "function name() view returns (string)",
    "function totalSupply() view returns (uint256)",
  ],
  pool: [
    "function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16 obsIdx, uint16 obsCard, uint16 obsCardNext, uint8 feeProtocol, bool unlocked)",
    "function token0() view returns (address)",
    "function token1() view returns (address)",
  ],
};

// ── Optional indexer/API (see /indexer) ─────────────────────────────────────
// When set to your indexer host (e.g. "https://api.robinlabs.io"), the browse
// feed, search, trending/top sorting and per-coin trade history come from the
// API in ONE request instead of fanning out dozens of RPC calls per page. Leave
// "" and everything falls back to reading the chain directly — the pad works
// either way, the API just makes it fast. No secrets here; the API is read-only.
export const API_BASE = "";

export const isDeployed = (key) => /^0x[0-9a-fA-F]{40}$/.test(CONTRACTS[key] || "");
export const hasApi = () => /^https?:\/\//.test(API_BASE || "");
