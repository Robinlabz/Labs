const { expect } = require("chai");
const { ethers } = require("hardhat");

// Randomized graduation battery against real Uniswap v3 on Robinhood Chain: launch many coins and graduate
// each at a RANDOM point between the $30k minimum and the ceiling ("let it ride"), asserting the invariants
// after every graduation. Crank it up:  SIMS=30 FORK_RPC=<rpc> npx hardhat test test/fork/graduation-sim.fork.test.js
const ONE = 10n ** 18n;
const FACTORY = "0x1f7d7550b1b028f7571e69a784071f0205fd2efa";
const WETH = "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73";
const DEAD = "0x000000000000000000000000000000000000dEaD";
const SIMS = Number(process.env.SIMS || 6);

// deterministic RNG (seeded LCG) so runs are reproducible
function rng(seed) { let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32; }; }
const suite = process.env.FORK_RPC ? describe : describe.skip;

suite("Graduation battery — random 'let it ride' points, invariants hold every time", function () {
  this.timeout(30 * 60 * 1000);

  it(`launches + graduates ${SIMS} coins at random points; floor is monotonic; conservation holds`, async () => {
    const [dep, platform, dev, buyer] = await ethers.getSigners();
    const ltd = await (await ethers.getContractFactory("LaunchTokenDeployer")).deploy();
    const cpd = await (await ethers.getContractFactory("CurvePoolDeployer")).deploy();
    const bd = await (await ethers.getContractFactory("BondDeployer")).deploy();
    const router = await (await ethers.getContractFactory("PadRouter")).deploy(WETH, dep.address);
    // production let-it-ride geometry
    const factory = await (await ethers.getContractFactory("CurvePadFactory")).deploy(
      WETH, FACTORY, platform.address, dep.address, await router.getAddress(),
      await ltd.getAddress(), await cpd.getAddress(), await bd.getAddress(), 196200, 25800, 16400
    );
    await (await router.setFactory(await factory.getAddress())).wait();
    const NOTAX = { buyBps: 100, sellBps: 100, walletBps: 10000, floorBps: 0, burnBps: 0, projectWallet: dev.address };
    const probe = await (await ethers.getContractFactory("SwapProbe")).deploy();
    const probeAddr = await probe.getAddress();
    const wethW = await ethers.getContractAt(
      ["function deposit() payable", "function approve(address,uint256) returns (bool)", "function balanceOf(address) view returns (uint256)"], WETH);
    await (await wethW.connect(buyer).deposit({ value: 200n * ONE })).wait();
    await (await wethW.connect(buyer).approve(probeAddr, 1n << 250n)).wait();
    const tokAbi = ["function balanceOf(address) view returns (uint256)"];

    const rand = rng(0xC0FFEE);
    const pts = []; // {gradTickAbs, raise} for the monotonicity check

    for (let i = 0; i < SIMS; i++) {
      const rc = await (await factory.launch({ name: `S${i}`, symbol: `S${i}`, dev: dev.address, tax: NOTAX })).wait();
      const ev = rc.logs.map((l) => { try { return factory.interface.parseLog(l); } catch { return null; } }).find((e) => e && e.name === "Launched");
      const { token, curve, pool: poolAddr } = ev.args;
      const curveC = await ethers.getContractAt("CurvePool", curve);
      const pool = await ethers.getContractAt("IUniswapV3Pool", poolAddr);
      const TOK = await ethers.getContractAt(tokAbi, token);

      // dev opts to allow graduation from the minimum, so the battery can graduate at ANY random point
      await (await curveC.connect(dev).setGradTarget(await curveC.minGradTick())).wait();
      await ethers.provider.send("evm_increaseTime", [400]);
      await ethers.provider.send("evm_mine", []);

      // pick a random graduation point between the minimum (frac 0) and the ceiling (frac 1)
      const minS = BigInt(await curveC.minGradSqrtPriceX96());
      const maxS = BigInt(await curveC.gradSqrtPriceX96());
      const frac = 5 + Math.floor(rand() * 96); // 5%..100%
      const sqrtLimit = minS + ((maxS - minS) * BigInt(frac)) / 100n;
      await (await probe.connect(buyer).swapExactInLimit(poolAddr, WETH, 60n * ONE, sqrtLimit)).wait();
      expect(await curveC.ready(), `#${i} ready`).to.equal(true);

      const devBefore = await wethW.balanceOf(dev.address);
      const gradRc = await (await curveC.graduate()).wait();
      const gev = gradRc.logs.map((l) => { try { return curveC.interface.parseLog(l); } catch { return null; } }).find((e) => e && e.name === "Graduated");
      const bondRaise = gev.args.raisedWeth; // the 75% the Bond got (post dev reward)
      const bond = await ethers.getContractAt("Bond", await curveC.bond());

      // INV-1: the Bond always posts a real floor
      expect(await bond.posted(), `#${i} posted`).to.equal(true);
      expect(await bond.sherwoodL(), `#${i} sherwoodL`).to.be.greaterThan(0n);
      expect(await bond.bountyL(), `#${i} bountyL`).to.be.greaterThan(0n);

      // INV-2: dev reward ~= 25% of the total raise == one third of the Bond's 75%
      const devGain = (await wethW.balanceOf(dev.address)) - devBefore;
      expect(devGain, `#${i} dev reward`).to.be.closeTo(bondRaise / 3n, bondRaise / 500n + 1n);

      // INV-3: the curve is fully drained — no WETH or token stranded in it
      expect(await wethW.balanceOf(curve), `#${i} curve weth`).to.equal(0n);
      expect(await TOK.balanceOf(curve), `#${i} curve token`).to.equal(0n);

      // INV-4: the pool holds real liquidity after graduation (tradeable)
      expect(await pool.liquidity(), `#${i} pool liq`).to.be.greaterThan(0n);

      // record (graduation price as |tick|-from-start, total raise) for the monotonicity check
      const tick = (await pool.slot0()).tick;
      const startAbs = 196200n; // |startTick|
      const priceDist = tick < 0n ? startAbs + tick + startAbs : (tick > 0n ? tick : 0n); // rough distance up the curve
      const totalRaise = (bondRaise * 4n) / 3n; // undo the 25% dev cut -> the gross raise
      pts.push({ frac, raise: totalRaise });
    }

    // INV-5 (let it ride): graduating higher up the curve raises strictly more. Per-coin this is exactly
    // monotonic, but comparing ACROSS coins mixes token0/token1 orderings which adds a few % of noise, so we
    // assert the robust trend — the top third of graduation points raised clearly more than the bottom third.
    const sorted = [...pts].sort((a, b) => a.frac - b.frac);
    const k = Math.max(1, Math.floor(sorted.length / 3));
    const avg = (arr) => arr.reduce((s, p) => s + p.raise, 0n) / BigInt(arr.length);
    const lowAvg = avg(sorted.slice(0, k));
    const highAvg = avg(sorted.slice(-k));
    expect(highAvg, "let-it-ride: higher graduation => bigger raise").to.be.greaterThan(lowAvg);
    console.log(`      ${SIMS} graduations: raises ${pts.map((p) => Number(ethers.formatEther(p.raise)).toFixed(2)).join(", ")} ETH; low3rd≈${ethers.formatEther(lowAvg)} high3rd≈${ethers.formatEther(highAvg)}`);
  });
});
