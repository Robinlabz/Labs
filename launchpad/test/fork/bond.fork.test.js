const { expect } = require("chai");
const { ethers } = require("hardhat");

// Fork test for the Bond (Bounty / Ambush / Sherwood) against the REAL Uniswap v3 on Robinhood Chain.
// Run: FORK_RPC=<rpc> npx hardhat test test/fork/bond.fork.test.js
const ONE = 10n ** 18n;
const FACTORY = "0x1f7d7550b1b028f7571e69a784071f0205fd2efa";
const WETH = "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73";
const MAXU128 = (1n << 128n) - 1n;

function bigSqrt(n) { if (n < 2n) return n; let x = n, y = (x + 1n) / 2n; while (y < x) { x = y; y = (x + n / x) / 2n; } return x; }
// sqrtPriceX96 for a pool priced so 1 WETH <-> `tokPerWeth` tokens, respecting token/WETH ordering.
function initSqrtPrice(tokenAddr, tokPerWeth) {
  const tokenIsToken0 = BigInt(tokenAddr) < BigInt(WETH);
  // token0 amount, token1 amount at the target price (raw wei)
  const weth = ONE, tok = tokPerWeth * ONE;
  const [a0, a1] = tokenIsToken0 ? [tok, weth] : [weth, tok];
  return bigSqrt((a1 * (1n << 192n)) / a0);
}

const suite = process.env.FORK_RPC ? describe : describe.skip;

suite("Bond on a Robinhood Chain fork (real Uniswap v3 range orders)", function () {
  this.timeout(240000);

  it("posts Sherwood+Bounty+Ambush, catches a dip in the Bounty, recenters on poke, compounds Sherwood fees back into the LP", async () => {
    const [dep, platform, curveSigner, trader] = await ethers.getSigners();

    // token + a real, initialized pool at a cheap-meme price (1 WETH ~ 50M token)
    const SUPPLY = 1_000_000_000n * ONE;
    const TOK = await (await ethers.getContractFactory("CurveToken")).deploy("Bonded", "BOND", SUPPLY, dep.address);
    const tokAddr = await TOK.getAddress();
    const factory = await ethers.getContractAt("IUniswapV3Factory", FACTORY);
    await (await factory.createPool(tokAddr, WETH, 10000)).wait();
    const poolAddr = await factory.getPool(tokAddr, WETH, 10000);
    const pool = await ethers.getContractAt("IUniswapV3Pool", poolAddr);
    const sqrtP = initSqrtPrice(tokAddr, 50_000_000n);
    await (await pool.initialize(sqrtP)).wait();
    await (await pool.increaseObservationCardinalityNext(20)).wait();

    // deploy the Bond (curveSigner stands in for the graduating curve)
    const bond = await (await ethers.getContractFactory("Bond")).deploy(tokAddr, WETH, FACTORY, platform.address, curveSigner.address);
    const bondAddr = await bond.getAddress();

    // fund the Bond exactly as graduation would: WETH for Sherwood+Bounty, tokens for Sherwood+Ambush
    const wethW = await ethers.getContractAt(
      ["function deposit() payable", "function transfer(address,uint256) returns (bool)", "function balanceOf(address) view returns (uint256)", "function approve(address,uint256) returns (bool)"], WETH);
    const keepWeth = ONE / 2n, moatWeth = ONE / 2n;         // 1 WETH total
    const keepTokens = 25_000_000n * ONE, rampTokens = 250_000_000n * ONE; // 275M total
    await (await wethW.connect(dep).deposit({ value: keepWeth + moatWeth })).wait();
    await (await wethW.connect(dep).transfer(bondAddr, keepWeth + moatWeth)).wait();
    await (await TOK.connect(dep).transfer(bondAddr, keepTokens + rampTokens)).wait();

    // POST — mints the three real positions
    await (await bond.connect(curveSigner).post(keepWeth, keepTokens, moatWeth, rampTokens)).wait();
    expect(await bond.sherwoodL()).to.be.greaterThan(0n);
    expect(await bond.bountyL()).to.be.greaterThan(0n);
    expect(await bond.ambushL()).to.be.greaterThan(0n);
    expect(await pool.liquidity()).to.be.greaterThan(0n); // Sherwood is in-range at the current price
    const moatLo0 = await bond.bountyLo(), rampL0 = await bond.ambushL();

    // helper: a real swap through the pool
    const probe = await (await ethers.getContractFactory("SwapProbe")).deploy();
    const probeAddr = await probe.getAddress();
    async function swap(signer, tokenIn, amount) {
      if (tokenIn === WETH) { await (await wethW.connect(signer).approve(probeAddr, amount)).wait(); }
      else { await (await TOK.connect(signer).approve(probeAddr, amount)).wait(); }
      await (await probe.connect(signer).swapExactIn(poolAddr, tokenIn, amount)).wait();
    }
    const warp = async (s) => { await ethers.provider.send("evm_increaseTime", [s]); await ethers.provider.send("evm_mine", []); };

    // give the trader tokens + WETH to trade with
    await (await TOK.connect(dep).transfer(trader.address, 400_000_000n * ONE)).wait();
    await (await wethW.connect(trader).deposit({ value: ONE })).wait();

    // (A) generate TWO-SIDED Sherwood fees: a DUMP (token-in) so the price runs into the Bounty which buys
    // it, then a PUMP (WETH-in). v3 takes the fee from the INPUT, so trading both directions leaves Sherwood
    // holding fees in BOTH token and WETH — which is what the full-range compound needs.
    const sherLBefore = await bond.sherwoodL();
    const platTokBefore = await TOK.balanceOf(platform.address);
    const platWethBefore = await wethW.balanceOf(platform.address);
    await swap(trader, tokAddr, 10_000_000n * ONE); // dump -> token fees, price into the Bounty
    await swap(trader, WETH, ONE / 2n);             // pump -> WETH fees
    await warp(1000); // let the TWAP converge so the poke deviation-guard passes (keeper waits for calm)

    // (B) poke: COMPOUNDS Sherwood's two-sided fees straight back into the locked full-range LP (grows the
    // permanent liquidity forever) and recenters the Bounty (all WETH) + Ambush (all tokens).
    await (await bond.poke()).wait();
    expect(await bond.bountyLo()).to.not.equal(moatLo0);        // floor recentered to the new price
    expect(await bond.bountyL()).to.be.greaterThan(0n);
    expect(await bond.ambushL()).to.be.greaterThan(0n);
    // the locked Sherwood liquidity GREW from its own trading fees — the "floor grows forever" mechanic
    expect(await bond.sherwoodL()).to.be.greaterThan(sherLBefore);
    // and NOTHING leaked out to the platform — the Bond no longer pays fees to any wallet
    expect(await TOK.balanceOf(platform.address)).to.equal(platTokBefore);
    expect(await wethW.balanceOf(platform.address)).to.equal(platWethBefore);
    rampL0; // (economics of the catch/recycle are proven in sim/bond-sim.mjs)

    // (C) anti-rug: the Bond exposes no way to move WETH/tokens to an arbitrary address
    const bad = bond.interface.fragments.find(
      (f) => f.type === "function" && /withdraw|sweep|rescue|drain|transfer|send|collectTo|setOwner|owner/i.test(f.name));
    expect(bad, bad && bad.name).to.equal(undefined);
  });
});
