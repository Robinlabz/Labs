const { expect } = require("chai");
const { ethers } = require("hardhat");

// End-to-end DEX-day-one launch via CurvePadFactory, against real Uniswap v3 on Robinhood Chain.
// Run: FORK_RPC=<rpc> npx hardhat test test/fork/curvepad.fork.test.js
const ONE = 10n ** 18n;
const FACTORY = "0x1f7d7550b1b028f7571e69a784071f0205fd2efa";
const WETH = "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73";

const suite = process.env.FORK_RPC ? describe : describe.skip;

suite("CurvePadFactory — one-call DEX-day-one launch", function () {
  this.timeout(240000);

  it("launch() -> live+tradeable Uniswap pool with opening guard -> buy out -> graduate into the Bond", async () => {
    const [dep, platform, dev, buyer] = await ethers.getSigners();

    const ltd = await (await ethers.getContractFactory("LaunchTokenDeployer")).deploy();
    const cpd = await (await ethers.getContractFactory("CurvePoolDeployer")).deploy();
    const bd = await (await ethers.getContractFactory("BondDeployer")).deploy();
    const router = await (await ethers.getContractFactory("PadRouter")).deploy(WETH, dep.address);
    const factory = await (await ethers.getContractFactory("CurvePadFactory")).deploy(
      WETH, FACTORY, platform.address, dep.address, await router.getAddress(),
      await ltd.getAddress(), await cpd.getAddress(), await bd.getAddress(), 207200, 35800, 19800
    );
    await (await router.setFactory(await factory.getAddress())).wait();
    // plain default 1% here (the above-default split is covered in padrouter.fork.test.js)
    const NOTAX = { buyBps: 100, sellBps: 100, walletBps: 10000, floorBps: 0, burnBps: 0, projectWallet: dev.address };

    // ===== ONE CALL: token + real pool + seeded curve + trading on =====
    const rc = await (await factory.launch({ name: "Robin Meme", symbol: "MEME", dev: dev.address, tax: NOTAX })).wait();
    const ev = rc.logs.map((l) => { try { return factory.interface.parseLog(l); } catch { return null; } })
      .find((e) => e && e.name === "Launched");
    const { token, curve, pool: poolAddr } = ev.args;

    const TOK = await ethers.getContractAt("LaunchToken", token);
    const curveC = await ethers.getContractAt("CurvePool", curve);
    const pool = await ethers.getContractAt("IUniswapV3Pool", poolAddr);

    // live on a real Uniswap pool from block one
    expect(await TOK.totalSupply()).to.equal(1_000_000_000n * ONE);
    expect(await TOK.tradingEnabled()).to.equal(true);
    expect(await TOK.antiSnipeActive()).to.equal(true); // opening guard is on
    expect(await curveC.curveL()).to.be.greaterThan(0n); // curve position seeded
    expect((await pool.slot0()).sqrtPriceX96).to.be.greaterThan(0n);

    const probe = await (await ethers.getContractFactory("SwapProbe")).deploy();
    const probeAddr = await probe.getAddress();
    const wethW = await ethers.getContractAt(
      ["function deposit() payable", "function approve(address,uint256) returns (bool)", "function balanceOf(address) view returns (uint256)"], WETH);
    await (await wethW.connect(buyer).deposit({ value: 60n * ONE })).wait();
    await (await wethW.connect(buyer).approve(probeAddr, 60n * ONE)).wait();
    const buy = (amt, limit) =>
      limit ? probe.connect(buyer).swapExactInLimit(poolAddr, WETH, amt, limit)
            : probe.connect(buyer).swapExactIn(poolAddr, WETH, amt);

    await ethers.provider.send("evm_increaseTime", [5]); // past the 2s dead window, into phase 1
    await ethers.provider.send("evm_mine", []);

    // ===== the opening guard is real: an oversized first-window buy reverts =====
    await expect(buy(ONE / 2n)).to.be.reverted; // 0.5 WETH would blow past the 1% wallet cap -> revert

    // ===== but a small buy trades fine — DEX day one, pre-graduation =====
    const t0 = await TOK.balanceOf(buyer.address);
    await (await buy(ONE / 500n)).wait(); // 0.002 WETH, within the cap
    expect(await TOK.balanceOf(buyer.address)).to.be.greaterThan(t0);

    // ===== after the window, buy out the curve (capped at the graduation price) =====
    await ethers.provider.send("evm_increaseTime", [400]); // guard fully expired
    await ethers.provider.send("evm_mine", []);
    expect(await TOK.antiSnipeActive()).to.equal(false);
    await (await buy(55n * ONE, await curveC.gradSqrtPriceX96())).wait();
    expect(await curveC.ready()).to.equal(true);

    // ===== graduate into the Bond =====
    const devWethBefore = await wethW.balanceOf(dev.address);
    const gradRc = await (await curveC.graduate()).wait();
    expect(await curveC.graduated()).to.equal(true);
    const bond = await ethers.getContractAt("Bond", await curveC.bond());
    expect(await bond.posted()).to.equal(true);
    expect(await bond.sherwoodL()).to.be.greaterThan(0n);
    expect(await bond.bountyL()).to.be.greaterThan(0n);
    expect(await bond.ambushL()).to.be.greaterThan(0n);

    // creator's graduation reward: the dev received 25% of the raise as WETH (the launch incentive), and the
    // Bond was still funded with the remaining 75% (asserted by the nonzero Sherwood/Bounty above)
    const devGain = (await wethW.balanceOf(dev.address)) - devWethBefore;
    expect(devGain).to.be.greaterThan(0n);
    const gradEv = gradRc.logs.map((l) => { try { return curveC.interface.parseLog(l); } catch { return null; } })
      .find((e) => e && e.name === "Graduated");
    const bondRaise = gradEv.args.raisedWeth; // post-reward (the 75% the Bond got)
    // dev's 25% ≈ one-third of the Bond's 75% — allow a small rounding tolerance
    expect(devGain).to.be.closeTo(bondRaise / 3n, bondRaise / 1000n + 1n);

    // still trades after graduation
    const t1 = await TOK.balanceOf(buyer.address);
    await (await buy(ONE / 2n)).wait();
    expect(await TOK.balanceOf(buyer.address)).to.be.greaterThan(t1);
  });

  it("launch() with ETH -> executes the dev's own buy (<=2%) atomically, before anyone else can trade", async () => {
    const [dep, platform, dev] = await ethers.getSigners();

    const ltd = await (await ethers.getContractFactory("LaunchTokenDeployer")).deploy();
    const cpd = await (await ethers.getContractFactory("CurvePoolDeployer")).deploy();
    const bd = await (await ethers.getContractFactory("BondDeployer")).deploy();
    const router = await (await ethers.getContractFactory("PadRouter")).deploy(WETH, dep.address);
    const factory = await (await ethers.getContractFactory("CurvePadFactory")).deploy(
      WETH, FACTORY, platform.address, dep.address, await router.getAddress(),
      await ltd.getAddress(), await cpd.getAddress(), await bd.getAddress(), 207200, 35800, 19800
    );
    await (await router.setFactory(await factory.getAddress())).wait();
    // plain default 1% here (the above-default split is covered in padrouter.fork.test.js)
    const NOTAX = { buyBps: 100, sellBps: 100, walletBps: 10000, floorBps: 0, burnBps: 0, projectWallet: dev.address };

    // dev funds their own opening buy in the SAME launch tx
    const spend = ONE / 100n; // 0.01 ETH
    const before = await ethers.provider.getBalance(dev.address);
    const rc = await (await factory.connect(dev).launch(
      { name: "Robin Dev", symbol: "SDEV", dev: dev.address, tax: NOTAX }, { value: spend }
    )).wait();
    const ev = rc.logs.map((l) => { try { return factory.interface.parseLog(l); } catch { return null; } })
      .find((e) => e && e.name === "Launched");
    const { token, devBought } = ev.args;
    const TOK = await ethers.getContractAt("LaunchToken", token);

    // the dev received real tokens, atomically, ahead of the field — and never more than 2%
    const cap = (1_000_000_000n * ONE * 200n) / 10_000n; // 2% of supply
    expect(devBought).to.be.greaterThan(0n);
    expect(devBought).to.be.at.most(cap);
    expect(await TOK.balanceOf(dev.address)).to.equal(devBought);

    // dev spent no more than they sent (unused ETH is refunded), minus gas
    const after = await ethers.provider.getBalance(dev.address);
    const gas = rc.gasUsed * rc.gasPrice;
    expect(before - after - gas).to.be.at.most(spend);
    // factory holds no leftover ETH/WETH/token dust
    const weth = await ethers.getContractAt(["function balanceOf(address) view returns (uint256)"], WETH);
    expect(await weth.balanceOf(await factory.getAddress())).to.equal(0n);
    expect(await TOK.balanceOf(await factory.getAddress())).to.equal(0n);
  });

  it("LET IT RIDE: graduating higher up the curve posts a thicker floor", async () => {
    const [dep, platform, dev, buyer] = await ethers.getSigners();
    const ltd = await (await ethers.getContractFactory("LaunchTokenDeployer")).deploy();
    const cpd = await (await ethers.getContractFactory("CurvePoolDeployer")).deploy();
    const bd = await (await ethers.getContractFactory("BondDeployer")).deploy();
    const router = await (await ethers.getContractFactory("PadRouter")).deploy(WETH, dep.address);
    // production "let it ride" geometry: min grad ~$30k, ceiling ~$76k
    const factory = await (await ethers.getContractFactory("CurvePadFactory")).deploy(
      WETH, FACTORY, platform.address, dep.address, await router.getAddress(),
      await ltd.getAddress(), await cpd.getAddress(), await bd.getAddress(), 196200, 25800, 16400
    );
    await (await router.setFactory(await factory.getAddress())).wait();
    const NOTAX = { buyBps: 100, sellBps: 100, walletBps: 10000, floorBps: 0, burnBps: 0, projectWallet: dev.address };
    const probe = await (await ethers.getContractFactory("SwapProbe")).deploy();
    const wethW = await ethers.getContractAt(
      ["function deposit() payable", "function approve(address,uint256) returns (bool)"], WETH);
    await (await wethW.connect(buyer).deposit({ value: 40n * ONE })).wait();
    await (await wethW.connect(buyer).approve(await probe.getAddress(), 40n * ONE)).wait();

    // launch a coin, buy up to `cap` (min-grad price or the ceiling), graduate, return the Bond's floor funding
    async function run(name, toCeiling) {
      const rc = await (await factory.launch({ name, symbol: name, dev: dev.address, tax: NOTAX })).wait();
      const ev = rc.logs.map((l) => { try { return factory.interface.parseLog(l); } catch { return null; } }).find((e) => e && e.name === "Launched");
      const { curve, pool: poolAddr } = ev.args;
      const curveC = await ethers.getContractAt("CurvePool", curve);
      // allow graduation from the minimum so the "min" run can graduate there (default target is 40% up)
      await (await curveC.connect(dev).setGradTarget(await curveC.minGradTick())).wait();
      await ethers.provider.send("evm_increaseTime", [400]);
      await ethers.provider.send("evm_mine", []);
      const cap = toCeiling ? await curveC.gradSqrtPriceX96() : await curveC.minGradSqrtPriceX96();
      await (await probe.connect(buyer).swapExactInLimit(poolAddr, WETH, 20n * ONE, cap)).wait();
      expect(await curveC.ready()).to.equal(true);
      const gradRc = await (await curveC.graduate()).wait();
      const gev = gradRc.logs.map((l) => { try { return curveC.interface.parseLog(l); } catch { return null; } }).find((e) => e && e.name === "Graduated");
      const bond = await ethers.getContractAt("Bond", await curveC.bond());
      expect(await bond.posted()).to.equal(true);
      return { raise: gev.args.raisedWeth, bountyL: await bond.bountyL() };
    }

    const atMin = await run("MIN", false); // graduate at the $30k minimum
    const rode = await run("RIDE", true);  // let it ride to the ceiling, then graduate
    // riding up the curve raised strictly more WETH -> a strictly thicker floor
    expect(rode.raise).to.be.greaterThan(atMin.raise);
    expect(rode.bountyL).to.be.greaterThan(atMin.bountyL); // a deeper buy-wall
  });

  it("auto-graduate: the dev sets the target; nobody can graduate before the dev's mark", async () => {
    const [dep, platform, dev, buyer, mallory] = await ethers.getSigners();
    const ltd = await (await ethers.getContractFactory("LaunchTokenDeployer")).deploy();
    const cpd = await (await ethers.getContractFactory("CurvePoolDeployer")).deploy();
    const bd = await (await ethers.getContractFactory("BondDeployer")).deploy();
    const router = await (await ethers.getContractFactory("PadRouter")).deploy(WETH, dep.address);
    const factory = await (await ethers.getContractFactory("CurvePadFactory")).deploy(
      WETH, FACTORY, platform.address, dep.address, await router.getAddress(),
      await ltd.getAddress(), await cpd.getAddress(), await bd.getAddress(), 196200, 25800, 16400
    );
    await (await router.setFactory(await factory.getAddress())).wait();
    const NOTAX = { buyBps: 100, sellBps: 100, walletBps: 10000, floorBps: 0, burnBps: 0, projectWallet: dev.address };
    const rc = await (await factory.launch({ name: "Auto", symbol: "AUTO", dev: dev.address, tax: NOTAX })).wait();
    const ev = rc.logs.map((l) => { try { return factory.interface.parseLog(l); } catch { return null; } }).find((e) => e && e.name === "Launched");
    const { curve, pool: poolAddr } = ev.args;
    const curveC = await ethers.getContractAt("CurvePool", curve);

    // the hands-off DEFAULT target sits strictly between the minimum and the ceiling (Rec #2: healthier default)
    {
      const mn = await curveC.minGradTick(), cl = await curveC.gradTick(), tg = await curveC.gradTarget();
      const between = mn < cl ? (tg > mn && tg < cl) : (tg < mn && tg > cl);
      expect(between, "default target between min and ceiling").to.equal(true);
    }

    // access control + bounds
    await expect(curveC.connect(mallory).setGradTarget(await curveC.gradTick())).to.be.revertedWithCustomError(curveC, "NotDev");
    await expect(curveC.connect(dev).setGradTarget(0)).to.be.revertedWithCustomError(curveC, "BadTarget"); // outside [min, ceiling]

    // the dev chooses to ride all the way: target = the ceiling
    await (await curveC.connect(dev).setGradTarget(await curveC.gradTick())).wait();

    const probe = await (await ethers.getContractFactory("SwapProbe")).deploy();
    const wethW = await ethers.getContractAt(["function deposit() payable", "function approve(address,uint256) returns (bool)"], WETH);
    await (await wethW.connect(buyer).deposit({ value: 30n * ONE })).wait();
    await (await wethW.connect(buyer).approve(await probe.getAddress(), 30n * ONE)).wait();
    await ethers.provider.send("evm_increaseTime", [400]);
    await ethers.provider.send("evm_mine", []);

    // the default target sits ABOVE the minimum (healthier hands-off structure), and the dev raised it to the ceiling
    expect(await curveC.gradTarget()).to.equal(await curveC.gradTick());

    // buy only up to the $30k MINIMUM — past the old graduation point but below the dev's target
    await (await probe.connect(buyer).swapExactInLimit(poolAddr, WETH, 30n * ONE, await curveC.minGradSqrtPriceX96())).wait();
    // ready() is FALSE and graduate() reverts: a sniper can't graduate before the dev's mark
    expect(await curveC.ready()).to.equal(false);
    await expect(curveC.graduate()).to.be.revertedWithCustomError(curveC, "NotReady");

    // ABANDON-PROOF: after the 7-day timeout, anyone can graduate at the minimum even though the dev set the
    // target to the ceiling and never moved it — the floor can be delayed but never denied.
    await ethers.provider.send("evm_increaseTime", [7 * 24 * 3600 + 1]);
    await ethers.provider.send("evm_mine", []);
    expect(await curveC.ready()).to.equal(true);
    await (await curveC.connect(buyer).graduate()).wait(); // buyer (not the dev) can graduate now
    expect(await curveC.graduated()).to.equal(true);
  });

  it("graduate() refuses a MANIPULATED post-buyout price — the floor-drain vector is closed (CP-1)", async () => {
    const [dep, platform, dev, buyer] = await ethers.getSigners();

    const ltd = await (await ethers.getContractFactory("LaunchTokenDeployer")).deploy();
    const cpd = await (await ethers.getContractFactory("CurvePoolDeployer")).deploy();
    const bd = await (await ethers.getContractFactory("BondDeployer")).deploy();
    const router = await (await ethers.getContractFactory("PadRouter")).deploy(WETH, dep.address);
    const factory = await (await ethers.getContractFactory("CurvePadFactory")).deploy(
      WETH, FACTORY, platform.address, dep.address, await router.getAddress(),
      await ltd.getAddress(), await cpd.getAddress(), await bd.getAddress(), 207200, 35800, 19800
    );
    await (await router.setFactory(await factory.getAddress())).wait();
    const NOTAX = { buyBps: 100, sellBps: 100, walletBps: 10000, floorBps: 0, burnBps: 0, projectWallet: dev.address };

    const rc = await (await factory.launch({ name: "Manip", symbol: "MNP", dev: dev.address, tax: NOTAX })).wait();
    const ev = rc.logs.map((l) => { try { return factory.interface.parseLog(l); } catch { return null; } }).find((e) => e && e.name === "Launched");
    const { token, curve, pool: poolAddr } = ev.args;
    const curveC = await ethers.getContractAt("CurvePool", curve);
    const pool = await ethers.getContractAt("IUniswapV3Pool", poolAddr);

    const probe = await (await ethers.getContractFactory("SwapProbe")).deploy();
    const probeAddr = await probe.getAddress();
    const wethW = await ethers.getContractAt(
      ["function deposit() payable", "function approve(address,uint256) returns (bool)", "function balanceOf(address) view returns (uint256)"], WETH);
    await (await wethW.connect(buyer).deposit({ value: 60n * ONE })).wait();
    await (await wethW.connect(buyer).approve(probeAddr, 60n * ONE)).wait();

    await ethers.provider.send("evm_increaseTime", [400]); // clear the anti-snipe window
    await ethers.provider.send("evm_mine", []);

    // buy out the curve with the graduation-price cap -> price parked AT gradTick, curve is ready
    await (await probe.connect(buyer).swapExactInLimit(poolAddr, WETH, 55n * ONE, await curveC.gradSqrtPriceX96())).wait();
    expect(await curveC.ready()).to.equal(true);
    const gradTick = await curveC.gradTick();
    const atGrad = (await pool.slot0()).tick;
    expect(atGrad > gradTick ? atGrad - gradTick : gradTick - atGrad).to.be.at.most(50n); // within tolerance

    // ATTACK: shove spot far past gradTick into the empty region beyond the curve (free — no liquidity there).
    // Direction depends on token ordering; measure the ABSOLUTE deviation (what graduate() actually gates on).
    await (await probe.connect(buyer).swapExactIn(poolAddr, WETH, ONE / 1000n)).wait();
    const shoved = (await pool.slot0()).tick;
    const dev0 = shoved > gradTick ? shoved - gradTick : gradTick - shoved;
    expect(dev0).to.be.greaterThan(50n); // price is now well past the graduation tick (beyond the tolerance)

    // graduate() must REFUSE to post the Bond around this manipulated price (was the floor-drain vector)
    await expect(curveC.graduate()).to.be.revertedWithCustomError(curveC, "NotReady");
    expect(await curveC.graduated()).to.equal(false);
  });
});
