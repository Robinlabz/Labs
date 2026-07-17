// OTC revenue model for the pad.
//
// Terms (fixed, oracle-free, per CurveLaunchFactory):
//   - Every launch: 1B supply, OTC vault holds 20% = 200M tokens.
//   - OTC opens once the graduated market TWAP >= the fixed "$10k MC" price.
//   - Buyers BURN $ROBIN to unlock allowance, then buy the 20% at the fixed OTC price.
//   - 100% of the OTC ETH goes to the platform wallet.
//
// This sim answers: "how much ETH does the platform make?" It's a pure accounting model —
// the curve/graduation correctness is covered by curve-sim.mjs + the test suite.

const ETH_USD = 3000;           // assumption for USD framing only
const SUPPLY = 1_000_000_000;   // 1B tokens
const VAULT_FRAC = 0.20;        // 20% held by the OTC vault
const VAULT_TOKENS = SUPPLY * VAULT_FRAC; // 200M

// OTC price: WETH-wei per 1e18 token = 3.33e9  ->  price per whole token in ETH:
const OTC_PRICE_WEI = 3_330_000_000n;           // per 1e18 token
const OTC_PRICE_ETH = Number(OTC_PRICE_WEI) / 1e18; // ETH per whole token
const OTC_MC_ETH = OTC_PRICE_ETH * SUPPLY;          // implied MC at the OTC price

// If the whole 20% is bought out at the OTC price, the platform collects:
const MAX_REV_ETH = OTC_PRICE_ETH * VAULT_TOKENS;

console.log("=== OTC fixed terms ===");
console.log(`OTC price      : ${OTC_PRICE_ETH.toExponential(3)} ETH/token  (MC = ${OTC_MC_ETH.toFixed(3)} ETH ≈ $${Math.round(OTC_MC_ETH*ETH_USD).toLocaleString()})`);
console.log(`Vault holds    : ${(VAULT_TOKENS/1e6).toFixed(0)}M tokens (20%)`);
console.log(`Full sell-out  : ${MAX_REV_ETH.toFixed(4)} ETH  ≈ $${Math.round(MAX_REV_ETH*ETH_USD).toLocaleString()}  per project (platform)`);
console.log("");

// --- Monte-Carlo across a portfolio of launches ---
// Not every project graduates, and of those that do, not all reach the OTC trigger, and of
// those that open, the vault is only partially bought out (depends on demand for the discount
// = depends on how far the market has run above the $10k OTC price, and $ROBIN burn appetite).

// Deterministic RNG (no Date/Math.random dependency for reproducibility).
let seed = 987654321;
const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };

function simPortfolio(nProjects) {
  let totalEth = 0, opened = 0, graduated = 0, sherBurned = 0;
  // $ROBIN burned to unlock: burnRatio = 100 tokens per ROBIN, so buying T tokens burns T/100 ROBIN.
  const TOKENS_PER_ROBIN = 100;
  for (let i = 0; i < nProjects; i++) {
    // ~55% of launches actually graduate (reach 4 ETH raised)
    if (rnd() > 0.55) continue;
    graduated++;
    // of graduates, ~70% run far enough past $10k MC to open + make the OTC discount attractive
    if (rnd() > 0.70) continue;
    opened++;
    // how much of the 20% gets bought — beta-ish: usually partial, sometimes full.
    // higher run-ups => deeper discount => more of the vault clears.
    const runup = 1 + rnd() * 9;            // market is 1x–10x above the OTC price when it opens
    const clear = Math.min(1, 0.15 + (runup / 10) * (0.5 + rnd() * 0.7)); // fraction of vault sold
    const tokensSold = VAULT_TOKENS * clear;
    totalEth += OTC_PRICE_ETH * tokensSold;
    sherBurned += tokensSold / TOKENS_PER_ROBIN;
  }
  return { totalEth, opened, graduated, sherBurned };
}

console.log("=== Portfolio Monte-Carlo (revenue is OTC-only; excludes buy-fee + LP-fee streams) ===");
for (const n of [50, 200, 1000]) {
  // average several runs
  let eth = 0, op = 0, gr = 0, burn = 0, R = 40;
  for (let r = 0; r < R; r++) { const s = simPortfolio(n); eth += s.totalEth; op += s.opened; gr += s.graduated; burn += s.sherBurned; }
  eth/=R; op/=R; gr/=R; burn/=R;
  console.log(`${String(n).padStart(4)} launches -> ${gr.toFixed(0)} grad, ${op.toFixed(0)} OTC-open | ` +
    `platform ${eth.toFixed(2)} ETH ($${Math.round(eth*ETH_USD).toLocaleString()}) | ` +
    `${(eth/n).toFixed(3)} ETH/launch avg | ${Math.round(burn/1e3)}k $ROBIN burned`);
}
console.log("");
console.log("Note: OTC is the discretionary/upside stream. The steady revenue is the 1% buy fee");
console.log("(0.9% streamed live) + LP swap fees, which scale with volume on every launch, not just");
console.log("the ones that run. OTC's second job is the $ROBIN burn sink it forces on every buyer.");
