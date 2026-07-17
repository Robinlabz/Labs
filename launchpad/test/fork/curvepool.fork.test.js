const { expect } = require("chai");
const { ethers } = require("hardhat");

// Fork test: the v3-concentrated-liquidity curve (DEX + DexScreener from block one) against real Uniswap v3.
// Run: FORK_RPC=<rpc> npx hardhat test test/fork/curvepool.fork.test.js
const ONE = 10n ** 18n;
const FACTORY = "0x1f7d7550b1b028f7571e69a784071f0205fd2efa";
const WETH = "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73";

const suite = process.env.FORK_RPC ? describe : describe.skip;

suite("CurvePool on a Robinhood Chain fork — DEX day one", function () {
  this.timeout(240000);

  it("launches straight into a real, tradeable Uniswap pool, walks the curve, then graduates into the Bond", async () => {
    const [dep, platform, dev, buyer] = await ethers.getSigners();

    const CURVE = 750_000_000n * ONE, AMBUSH = 250_000_000n * ONE; // 75% curve / 25% ambush = 1B
    const TOK = await (await ethers.getContractFactory("CurveToken")).deploy("Meme", "MEME", CURVE + AMBUSH, dep.address);
    const tokAddr = await TOK.getAddress();
    const bd = await (await ethers.getContractFactory("BondDeployer")).deploy();

    // start price = ~1e-9 WETH/token (start MC ~1 ETH); tick sign depends on token/WETH ordering. width ~= 36x.
    const tokenIsToken0 = BigInt(tokAddr) < BigInt(WETH);
    const startTick = tokenIsToken0 ? -207200 : 207200;
    const width = 35800, minGradWidth = 19800;

    const curve = await (await ethers.getContractFactory("CurvePool")).deploy(
      tokAddr, WETH, FACTORY, platform.address, dev.address, await bd.getAddress(),
      CURVE, AMBUSH, startTick, width, minGradWidth
    );
    const curveAddr = await curve.getAddress();
    await (await TOK.connect(dep).transfer(curveAddr, CURVE + AMBUSH)).wait(); // token seeds itself — no ETH from us

    // pool exists + is initialized at the start price the moment the contract deploys
    const factory = await ethers.getContractAt("IUniswapV3Factory", FACTORY);
    const poolAddr = await factory.getPool(tokAddr, WETH, 10000);
    expect(poolAddr).to.equal(await curve.pool());
    const pool = await ethers.getContractAt("IUniswapV3Pool", poolAddr);
    expect((await pool.slot0()).sqrtPriceX96).to.be.greaterThan(0n);

    // SEED — mint the single-sided curve position (this is the whole liquidity; no ETH needed)
    await (await curve.seed()).wait();
    expect(await curve.curveL()).to.be.greaterThan(0n);

    // ===== DEX DAY ONE: a real buy trades against the pool immediately, no graduation needed =====
    const probe = await (await ethers.getContractFactory("SwapProbe")).deploy();
    const probeAddr = await probe.getAddress();
    const wethW = await ethers.getContractAt(
      ["function deposit() payable", "function approve(address,uint256) returns (bool)", "function balanceOf(address) view returns (uint256)"], WETH);
    await (await wethW.connect(buyer).deposit({ value: 60n * ONE })).wait();
    await (await wethW.connect(buyer).approve(probeAddr, 60n * ONE)).wait();

    const t0 = await TOK.balanceOf(buyer.address);
    await (await probe.connect(buyer).swapExactIn(poolAddr, WETH, ONE / 10n)).wait(); // tiny 0.1 WETH buy
    expect(await TOK.balanceOf(buyer.address)).to.be.greaterThan(t0); // ✅ tradeable from block one, pre-graduation

    // ===== walk the curve to the top (buy it out), capping the swap at the graduation price =====
    expect(await curve.ready()).to.equal(false);
    const gradSqrt = await curve.gradSqrtPriceX96();
    await (await probe.connect(buyer).swapExactInLimit(poolAddr, WETH, 55n * ONE, gradSqrt)).wait();
    expect(await curve.ready()).to.equal(true); // price reached the graduation end (and stopped there)

    // ===== GRADUATE into the Bond (same pool) =====
    await (await curve.graduate()).wait();
    expect(await curve.graduated()).to.equal(true);
    const bondAddr = await curve.bond();
    expect(bondAddr).to.not.equal(ethers.ZeroAddress);
    const bond = await ethers.getContractAt("Bond", bondAddr);
    expect(await bond.posted()).to.equal(true);
    expect(await bond.sherwoodL()).to.be.greaterThan(0n);
    expect(await bond.bountyL()).to.be.greaterThan(0n);
    expect(await bond.ambushL()).to.be.greaterThan(0n);

    // still a real, tradeable pool after graduation
    const t1 = await TOK.balanceOf(buyer.address);
    await (await probe.connect(buyer).swapExactIn(poolAddr, WETH, ONE / 2n)).wait();
    expect(await TOK.balanceOf(buyer.address)).to.be.greaterThan(t1);
  });
});
