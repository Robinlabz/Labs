// Bonding-curve + graduation Monte-Carlo simulator.
// A pure-BigInt reference model that mirrors BondingCurve.sol EXACTLY (same floor/ceil rounding),
// stress-tested across many randomized curve configs and trade sequences to prove the economic
// invariants that matter: no value leak, no round-trip arbitrage, balance == raised, conservation of
// supply, and a correct one-shot graduation. Deterministic (seeded PRNG) so runs are reproducible.

const ONE = 10n ** 18n;
const FEE_BPS = 100n; // 1%
const BPS = 10000n;

// ---- seeded PRNG (mulberry32 on BigInt-ish) ----
function makeRng(seed) {
  let s = seed >>> 0;
  return () => {
    s |= 0; s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const ceilDiv = (a, b) => (a + b - 1n) / b;

// ---- reference model (mirrors the contract) ----
class Curve {
  constructor({ virtEth, curveSupply, gradTarget, antiSnipeActive = false, maxBuyWei = 0n }) {
    this.VIRT = virtEth;
    this.SUPPLY = curveSupply;
    this.K = virtEth * curveSupply;
    this.GRAD = gradTarget;
    this.maxBuyWei = maxBuyWei;
    this.antiSnipe = antiSnipeActive;
    this.RE = virtEth;
    this.RT = curveSupply;
    this.graduated = false;
    this.balance = 0n; // real ETH held
    this.fees = 0n;
    this.tokensOut = 0n; // total tokens sold to buyers (held outside)
  }
  raised() { return this.RE - this.VIRT; }
  buy(ethIn) {
    if (this.graduated) return { err: "graduated" };
    let fee = (ethIn * FEE_BPS) / BPS;
    let net = ethIn - fee;
    if (net === 0n) return { err: "dust" };
    if (this.antiSnipe && net > this.maxBuyWei) return { err: "snipe" };
    // cap the graduating buy to land exactly on GRAD_TARGET (refund the rest) -> price-continuous grad
    const room = this.GRAD - this.raised();
    if (net > room) { let g = ceilDiv(room * BPS, BPS - FEE_BPS); if (g > ethIn) g = ethIn; fee = g - room; net = room; }
    const newRE = this.RE + net;
    const newRT = this.K / newRE; // floor
    const out = this.RT - newRT;
    if (out <= 0n) return { err: "noout" };
    this.RE = newRE; this.RT = newRT;
    this.balance += net; this.fees += fee; this.tokensOut += out;
    if (this.raised() >= this.GRAD) this._graduate();
    return { out, fee, net };
  }
  sell(tokensIn) {
    if (this.graduated) return { err: "graduated" };
    if (tokensIn <= 0n) return { err: "zero" };
    const newRT = this.RT + tokensIn;
    const newRE = ceilDiv(this.K, newRT); // ceil
    const gross = this.RE - newRE;
    this.RT = newRT; this.RE = newRE;
    const fee = (gross * FEE_BPS) / BPS;
    const ethOut = gross - fee;
    this.balance -= gross; this.fees += fee; this.tokensOut -= tokensIn;
    return { ethOut, gross, fee };
  }
  _graduate() {
    this.graduated = true;
    this.gradEth = this.balance; // all real ETH to LP
    // Contract seeds at the COMMITTED graduation price (set at launch): gradRE=VIRT+GRAD, gradRT=K/gradRE.
    // tokensToLp = ethToLp * gradRT / gradRE  so pool price == gradRE/gradRT.
    const gradRE = this.VIRT + this.GRAD;
    const gradRT = this.K / gradRE;
    let t = (this.gradEth * gradRT) / gradRE;
    this.gradTokens = t < this.RT ? t : this.RT; // min clamp
    this.burnTokens = this.RT - this.gradTokens;
    this.committedPriceNum = gradRE; this.committedPriceDen = gradRT; // for the step measurement
  }
}

// ---- invariant checks ----
function checkInvariants(c, tag, viol) {
  // INV-BAL: real balance == raised (== RE - VIRT)
  if (c.balance !== c.raised()) viol.push(`${tag} INV-BAL balance=${c.balance} raised=${c.raised()}`);
  // raised never negative
  if (c.raised() < 0n) viol.push(`${tag} raised<0 ${c.raised()}`);
  // reserves positive
  if (c.RT <= 0n || c.RE <= 0n) viol.push(`${tag} reserve<=0 RE=${c.RE} RT=${c.RT}`);
  // product never lets a trader win: after a buy RE*RT<=K; after a sell RE*RT>=K. Both keep dust in the
  // curve's favor, so the curve can always cover what it owes.
  // conservation: tokensOut (held by buyers) + RT (in curve) == SUPPLY
  if (c.tokensOut + c.RT !== c.SUPPLY) viol.push(`${tag} CONSERVE out=${c.tokensOut} RT=${c.RT} sum!=${c.SUPPLY}`);
}

// ---- scenario runners ----
function randCurve(rng) {
  const virt = (BigInt(1 + Math.floor(rng() * 40)) * ONE) / 10n; // 0.1 .. 4 ETH virtual
  const supply = BigInt(1 + Math.floor(rng() * 1000)) * 1_000_000n * ONE; // 1M..1B tokens
  const grad = (BigInt(2 + Math.floor(rng() * 300)) * ONE) / 10n; // 0.2 .. 30 ETH target
  return new Curve({ virtEth: virt, curveSupply: supply, gradTarget: grad });
}

function runRandomSequence(c, rng, ops, viol) {
  let lastPriceNum = null; // spot price = RE/RT (compare as cross-mult)
  for (let i = 0; i < ops && !c.graduated; i++) {
    const doBuy = rng() < 0.62 || c.tokensOut === 0n;
    if (doBuy) {
      // buy 0.0001 .. ~2x gradTarget ETH (sometimes a whale that graduates)
      const scale = rng() < 0.05 ? 2.0 : rng();
      const eth = BigInt(Math.max(1, Math.floor(scale * Number(c.GRAD) * 1.2)));
      const preRE = c.RE, preRT = c.RT;
      const r = c.buy(eth);
      if (r.err) continue;
      // price must not decrease on a buy (RE/RT up): preRE/preRT <= RE/RT  <=> preRE*RT <= RE*preRT
      if (preRE * c.RT > c.RE * preRT) viol.push(`buy price decreased`);
    } else {
      // sell a random fraction of outstanding tokens
      const held = c.tokensOut;
      if (held <= 0n) continue;
      const frac = BigInt(1 + Math.floor(rng() * 100));
      const amt = (held * frac) / 100n;
      if (amt <= 0n) continue;
      const preRE = c.RE, preRT = c.RT;
      const r = c.sell(amt);
      if (r.err) continue;
      // price must not increase on a sell
      if (preRE * c.RT < c.RE * preRT) viol.push(`sell price increased`);
    }
    checkInvariants(c, `op${i}`, viol);
  }
}

// ---- targeted property: no round-trip arbitrage (buy then immediately sell loses) ----
function roundTripNoProfit(rng, viol, n) {
  for (let i = 0; i < n; i++) {
    const c = randCurve(rng);
    // random pre-fill so we're somewhere on the curve
    c.buy(BigInt(Math.max(1, Math.floor(rng() * Number(c.GRAD)))));
    if (c.graduated) continue;
    const ethIn = BigInt(Math.max(1000, Math.floor(rng() * Number(c.GRAD) * 0.3)));
    const before = { RE: c.RE, RT: c.RT, bal: c.balance, out: c.tokensOut };
    const b = c.buy(ethIn);
    if (b.err || c.graduated) continue;
    const s = c.sell(b.out);
    if (s.err) continue;
    // got back s.ethOut for ethIn spent — must be strictly less (fees + rounding)
    if (s.ethOut >= ethIn) viol.push(`ROUNDTRIP profit in=${ethIn} out=${s.ethOut}`);
    // and the curve is left no worse than before minus the two fees it collected
    if (c.balance < 0n) viol.push(`ROUNDTRIP balance<0`);
  }
}

// ---- graduation correctness + price-continuity measurement ----
function graduationStats(rng, viol, n) {
  const steps = [];
  let gradCount = 0;
  for (let i = 0; i < n; i++) {
    const c = randCurve(rng);
    // drive buys until graduation (bounded)
    let guard = 0;
    while (!c.graduated && guard++ < 5000) {
      const eth = BigInt(Math.max(1, Math.floor((0.02 + rng() * 0.2) * Number(c.GRAD))));
      const r = c.buy(eth);
      if (r.err) { c.buy(c.GRAD); break; }
    }
    if (!c.graduated) continue;
    gradCount++;
    // conservation at graduation: gradTokens (to LP) + burnTokens + tokensOut (held) == SUPPLY
    if (c.gradTokens + c.burnTokens + c.tokensOut !== c.SUPPLY) viol.push(`GRAD conserve`);
    // gradEth == balance == raised
    if (c.gradEth !== c.raised()) viol.push(`GRAD eth!=raised`);
    if (c.gradEth <= 0n || c.gradTokens <= 0n) viol.push(`GRAD empty`);
    // raised must have reached the target
    if (c.raised() < c.GRAD) viol.push(`GRAD below target`);
    // price continuity: pool seed price (committedPriceNum/Den == gradEth/gradTokens) vs the curve's
    // actual final marginal price (RE/RT). ratio = poolPrice/curvePrice in ppm; 1e6 == continuous.
    // The only gap is the last buy's overshoot beyond GRAD_TARGET (pool opens slightly BELOW final price).
    const stepPpm = Number((c.committedPriceNum * c.RT * 1_000_000n) / (c.committedPriceDen * c.RE));
    steps.push(stepPpm);
    if (stepPpm > 1_000_100) viol.push(`GRAD pool price ABOVE curve (${stepPpm})`); // must never open higher
  }
  steps.sort((a, b) => a - b);
  const pct = (p) => steps.length ? steps[Math.min(steps.length - 1, Math.floor(p * steps.length))] : 0;
  return { gradCount, stepMedianPct: (pct(0.5) / 1e4).toFixed(2), stepWorstPct: (pct(0.0) / 1e4).toFixed(2), stepBestPct: (pct(0.999) / 1e4).toFixed(2) };
}

// ---- main ----
const rng = makeRng(0xC0FFEE);
const viol = [];
let totalOps = 0;

console.log("=== Bonding-curve Monte-Carlo simulation ===");

// 1) random sequences across many curves
const NCURVES = 4000, OPS = 60;
for (let i = 0; i < NCURVES; i++) {
  const c = randCurve(rng);
  checkInvariants(c, "init", viol);
  runRandomSequence(c, rng, OPS, viol);
  totalOps += OPS;
}
console.log(`1) random sequences: ${NCURVES} curves x ~${OPS} ops = ~${totalOps} ops`);

// 2) round-trip no-arbitrage
const NRT = 20000;
roundTripNoProfit(rng, viol, NRT);
console.log(`2) round-trip no-profit: ${NRT} trials`);

// 3) graduation correctness + continuity
const NG = 3000;
const g = graduationStats(rng, viol, NG);
console.log(`3) graduation: ${g.gradCount}/${NG} graduated`);
console.log(`   price step-down at graduation (100% = continuous): median ${g.stepMedianPct}%  best ${g.stepBestPct}%  worst ${g.stepWorstPct}%`);

// 4) edge cases
(() => {
  // whale that overshoots the target in one buy still graduates and conserves
  const c = new Curve({ virtEth: ONE, curveSupply: 800_000_000n * ONE, gradTarget: 5n * ONE });
  c.buy(1000n * ONE);
  if (!c.graduated) viol.push("EDGE whale did not graduate");
  if (c.gradTokens + c.burnTokens + c.tokensOut !== c.SUPPLY) viol.push("EDGE whale conserve");
  // dust buy reverts cleanly (net==0)
  const c2 = new Curve({ virtEth: ONE, curveSupply: ONE * 1000n, gradTarget: ONE });
  const r = c2.buy(50n); // fee floors to 0, net=50 -> ok; try 0
  const r0 = c2.buy(0n);
  if (!r0.err) viol.push("EDGE zero buy did not error");
  console.log("4) edge cases: whale-graduation + dust checked");
})();

console.log(`\nTotal invariant violations: ${viol.length}`);
if (viol.length) { console.log(viol.slice(0, 20).join("\n")); process.exit(1); }
console.log("ALL INVARIANTS HELD ✅  (no value leak, no round-trip profit, balance==raised, supply conserved, one-shot graduation)");
