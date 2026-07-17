const { expect } = require("chai");
const { ethers } = require("hardhat");

// End-to-end fork test: creation -> curve -> graduation -> Bond -> LP, against the REAL Uniswap v3 on
// Robinhood Chain. Run: FORK_RPC=<rpc> npx hardhat test test/fork/graduation.fork.test.js
const ONE = 10n ** 18n;
const FACTORY = "0x1f7d7550b1b028f7571e69a784071f0205fd2efa"; // verified Uniswap v3 factory (chainId 4663)
const WETH = "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73";     // verified WETH

const suite = process.env.FORK_RPC ? describe : describe.skip;

suite("CurveLaunchFactory end-to-end on a Robinhood Chain fork (real Uniswap v3)", function () {
  this.timeout(240000);

  it("launch -> trade -> graduate -> posts the Bond (Sherwood+Bounty+Ambush) into a real, tradeable pool", async () => {
    const [dep, platform, dev, buyer] = await ethers.getSigners();

    // deploy the pad: deployers + factory (fixed oracle-free terms live in the factory)
    const td = await (await ethers.getContractFactory("CurveTokenDeployer")).deploy();
    const cd = await (await ethers.getContractFactory("BondingCurveDeployer")).deploy();
    const bd = await (await ethers.getContractFactory("BondDeployer")).deploy();
    const factory = await (await ethers.getContractFactory("CurveLaunchFactory")).deploy(
      WETH, FACTORY, platform.address, dep.address, await td.getAddress(), await cd.getAddress(), await bd.getAddress()
    );

    // (1) CREATION — one call mints 1B, funds the curve, claims + prices the real pool at launch
    const rc = await (await factory.launch({ name: "Robin Meme", symbol: "MEME", dev: dev.address })).wait();
    const ev = rc.logs.map((l) => { try { return factory.interface.parseLog(l); } catch { return null; } })
      .find((e) => e && e.name === "Launched");
    const { token, curve } = ev.args;
    const TOK = await ethers.getContractAt("CurveToken", token);
    const c = await ethers.getContractAt("BondingCurve", curve);

    const SUPPLY = 1_000_000_000n * ONE;
    expect(await TOK.totalSupply()).to.equal(SUPPLY);
    expect(await TOK.balanceOf(curve)).to.equal(SUPPLY); // curve holds all of it (75% trades, 25% ambush reserve)
    const poolAddr = await c.pool();
    const pool = await ethers.getContractAt("IUniswapV3Pool", poolAddr);
    expect((await pool.slot0()).sqrtPriceX96).to.equal(await c.gradSqrtPriceX96()); // priced at launch
    expect(await pool.liquidity()).to.equal(0n); // empty until graduation

    // (2) TRADE -> GRADUATE — past the 5-min anti-snipe window, buy through the 4-ETH target
    await ethers.provider.send("evm_increaseTime", [400]);
    await ethers.provider.send("evm_mine", []);
    await (await c.connect(buyer).buy(0, { value: 5n * ONE })).wait(); // caps at 4 ETH, refunds the rest
    expect(await c.graduated()).to.equal(true);

    // (3) THE BOND — graduation deployed + posted it (Sherwood + Bounty + Ambush) into the real pool
    const bondAddr = await c.bond();
    expect(bondAddr).to.not.equal(ethers.ZeroAddress);
    const bond = await ethers.getContractAt("Bond", bondAddr);
    expect(await bond.posted()).to.equal(true);
    expect(await bond.sherwoodL()).to.be.greaterThan(0n);  // full-range locked baseline LP
    expect(await bond.bountyL()).to.be.greaterThan(0n);  // ETH floor below price
    expect(await bond.ambushL()).to.be.greaterThan(0n);  // 25% sold high above price
    expect(await pool.slot0()).to.not.be.undefined;
    expect((await pool.slot0()).sqrtPriceX96).to.equal(await c.gradSqrtPriceX96()); // still price-continuous

    // real liquidity + WETH now live in the pool
    expect(await pool.liquidity()).to.be.greaterThan(0n);
    const weth = await ethers.getContractAt("IERC20", WETH);
    expect(await weth.balanceOf(poolAddr)).to.be.greaterThan(2n * ONE); // Sherwood + Bounty WETH seeded

    // curve trading is closed
    await expect(c.connect(buyer).buy(0, { value: ONE })).to.be.revertedWithCustomError(c, "AlreadyGraduated");

    // (4) THE POOL TRADES — a real swap buys the token with WETH
    const probe = await (await ethers.getContractFactory("SwapProbe")).deploy();
    const wethW = await ethers.getContractAt(
      ["function deposit() payable", "function approve(address,uint256) returns (bool)"], WETH);
    await (await wethW.connect(buyer).deposit({ value: ONE / 2n })).wait();
    await (await wethW.connect(buyer).approve(await probe.getAddress(), ONE / 2n)).wait();
    const before = await TOK.balanceOf(buyer.address);
    await (await probe.connect(buyer).swapExactIn(poolAddr, WETH, ONE / 2n)).wait();
    expect(await TOK.balanceOf(buyer.address)).to.be.greaterThan(before);

    // (5) TWAP armed -> Bond.poke() works (recenters the floor). Let the TWAP window build first.
    await ethers.provider.send("evm_increaseTime", [1000]);
    await ethers.provider.send("evm_mine", []);
    await (await bond.poke()).wait();
    expect(await bond.bountyL()).to.be.greaterThan(0n);
    expect(await bond.ambushL()).to.be.greaterThan(0n);
  });
});
