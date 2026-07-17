const { expect } = require("chai");
const { ethers } = require("hardhat");

// The project tax, enforced at the PadRouter swap desk, against real Uniswap v3 on Robinhood Chain.
// Run: FORK_RPC=<rpc> npx hardhat test test/fork/padrouter.fork.test.js
const ONE = 10n ** 18n;
const FACTORY = "0x1f7d7550b1b028f7571e69a784071f0205fd2efa";
const WETH = "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73";
const SUPPLY = 1_000_000_000n * ONE;

const suite = process.env.FORK_RPC ? describe : describe.skip;

async function stack(dep, platform, startMag = 207200, width = 35800, minGradWidth = 19800) {
  const ltd = await (await ethers.getContractFactory("LaunchTokenDeployer")).deploy();
  const cpd = await (await ethers.getContractFactory("CurvePoolDeployer")).deploy();
  const bd = await (await ethers.getContractFactory("BondDeployer")).deploy();
  const router = await (await ethers.getContractFactory("PadRouter")).deploy(WETH, dep.address);
  const factory = await (await ethers.getContractFactory("CurvePadFactory")).deploy(
    WETH, FACTORY, platform.address, dep.address, await router.getAddress(),
    await ltd.getAddress(), await cpd.getAddress(), await bd.getAddress(), startMag, width, minGradWidth
  );
  await (await router.setFactory(await factory.getAddress())).wait();
  return { router, factory };
}

suite("PadRouter — the project tax (swap desk, 4% cap, platform 25%)", function () {
  this.timeout(240000);

  it("registration enforces the 4% caps and a 100% project-share allocation", async () => {
    const [dep, platform, dev] = await ethers.getSigners();
    const { factory } = await stack(dep, platform);
    const base = { name: "X", symbol: "X", dev: dev.address };

    // buy tax over 4% -> revert
    await expect(factory.launch({ ...base,
      tax: { buyBps: 401, sellBps: 0, walletBps: 10000, floorBps: 0, burnBps: 0, projectWallet: dev.address } }))
      .to.be.reverted;
    // allocation that doesn't sum to 100% -> revert
    await expect(factory.launch({ ...base,
      tax: { buyBps: 100, sellBps: 100, walletBps: 5000, floorBps: 3000, burnBps: 1000, projectWallet: dev.address } }))
      .to.be.reverted;
  });

  it("splits a buy/sell tax: platform 25%, project 75% across wallet / floor / burn — and pays out", async () => {
    const [dep, platform, dev, buyer] = await ethers.getSigners();
    const { router, factory } = await stack(dep, platform);

    // 3% buy, 3% sell; project 75% split 50% wallet / 30% floor / 20% burn
    const tax = { buyBps: 300, sellBps: 300, walletBps: 5000, floorBps: 3000, burnBps: 2000, projectWallet: dev.address };
    const rc = await (await factory.launch({ name: "Taxed", symbol: "TAX", dev: dev.address, tax })).wait();
    const ev = rc.logs.map((l) => { try { return factory.interface.parseLog(l); } catch { return null; } })
      .find((e) => e && e.name === "Launched");
    const { token } = ev.args;
    const TOK = await ethers.getContractAt("LaunchToken", token);
    const routerAddr = await router.getAddress();

    // past the opening anti-snipe window
    await ethers.provider.send("evm_increaseTime", [400]);
    await ethers.provider.send("evm_mine", []);
    expect(await TOK.antiSnipeActive()).to.equal(false);

    // ===== BUY through the router (native ETH, no approval) =====
    // 3% fee: 0.9% immediate + 0.1% deferred (platform), then 2% above-default split 25%/75%
    const spend = ONE; // 1 ETH
    const immediate = (spend * 90n) / 10_000n; // 0.9%
    const deferred = (spend * 10n) / 10_000n; // 0.1%
    const excess = (spend * 200n) / 10_000n; // 2% above the 1% default
    const platformCut = (excess * 2500n) / 10_000n; // 25% -> the platform buy-back cut
    const proj = excess - platformCut; // 75%
    const devCut = (proj * 5000n) / 10_000n;
    const burnCut = (proj * 2000n) / 10_000n;
    const floorCut = proj - devCut - burnCut;

    const t0 = await TOK.balanceOf(buyer.address);
    await (await router.connect(buyer).buy(token, 0, { value: spend })).wait();
    expect(await TOK.balanceOf(buyer.address)).to.be.greaterThan(t0); // got tokens

    // the fee split landed in escrow, to the exact bps
    expect(await router.platformEscrow()).to.equal(immediate);
    expect(await router.deferredEscrow(token)).to.equal(deferred);
    expect(await router.platformCutEscrow()).to.equal(platformCut);
    expect(await router.devEscrow(token)).to.equal(devCut);
    expect(await router.floorEscrow(token)).to.equal(floorCut);
    expect(await router.burnEscrow(token)).to.equal(burnCut);

    // ===== payouts =====
    // dev share -> the project wallet (anyone may trigger; funds only go to the configured wallet)
    const devBefore = await ethers.provider.getBalance(dev.address);
    await (await router.connect(buyer).withdrawDev(token)).wait();
    expect(await ethers.provider.getBalance(dev.address)).to.equal(devBefore + devCut);
    expect(await router.devEscrow(token)).to.equal(0n);

    // platform immediate share -> owner() (dep here). withdrawPlatform pays owner().
    const depBefore = await ethers.provider.getBalance(dep.address);
    await (await router.connect(buyer).withdrawPlatform()).wait();
    expect(await router.platformEscrow()).to.equal(0n);
    expect(await ethers.provider.getBalance(dep.address)).to.equal(depBefore + immediate);

    // burn share -> buys the token and sends it to dead
    const deadBefore = await TOK.balanceOf("0x000000000000000000000000000000000000dEaD");
    await (await router.connect(buyer).flushBurn(token)).wait();
    expect(await router.burnEscrow(token)).to.equal(0n);
    expect(await TOK.balanceOf("0x000000000000000000000000000000000000dEaD")).to.be.greaterThan(deadBefore);

    // ===== SELL through the router (one exact-amount approval) =====
    const bal = await TOK.balanceOf(buyer.address);
    const sellAmt = bal / 2n;
    await (await TOK.connect(buyer).approve(routerAddr, sellAmt)).wait();
    const ethBefore = await ethers.provider.getBalance(buyer.address);
    const floorBefore = await router.floorEscrow(token);
    const sr = await (await router.connect(buyer).sell(token, sellAmt, 0)).wait();
    // seller received native ETH (net of gas), and the sell tax grew the escrows
    const gas = sr.gasUsed * sr.gasPrice;
    expect(await ethers.provider.getBalance(buyer.address)).to.be.greaterThan(ethBefore - gas);
    expect(await router.floorEscrow(token)).to.be.greaterThan(floorBefore); // sell fee added to the floor share
  });

  it("a full buy-out THROUGH THE ROUTER caps at the graduation price (no overshoot) and graduates cleanly", async () => {
    const [dep, platform, dev, buyer] = await ethers.getSigners();
    const { router, factory } = await stack(dep, platform);
    const tax = { buyBps: 100, sellBps: 100, walletBps: 10000, floorBps: 0, burnBps: 0, projectWallet: dev.address };
    const rc = await (await factory.launch({ name: "Grad", symbol: "GRAD", dev: dev.address, tax })).wait();
    const ev = rc.logs.map((l) => { try { return factory.interface.parseLog(l); } catch { return null; } }).find((e) => e && e.name === "Launched");
    const { token, curve, pool: poolAddr } = ev.args;
    const curveC = await ethers.getContractAt("CurvePool", curve);
    const pool = await ethers.getContractAt("IUniswapV3Pool", poolAddr);

    await ethers.provider.send("evm_increaseTime", [400]);
    await ethers.provider.send("evm_mine", []);

    // buy out with FAR more ETH than the curve needs — the router's cap must stop the price at the curve
    // top (graduation tick), NOT run it into the empty space beyond (which crashed the live pool to MIN_TICK)
    await (await router.connect(buyer).buy(token, 0, { value: 20n * ONE })).wait();
    const tick = (await pool.slot0()).tick;
    const gradTick = await curveC.gradTick();
    expect(await curveC.ready()).to.equal(true);
    expect(tick).to.not.equal(-887272); // did NOT crash to MIN_TICK
    // the price is parked right at the graduation tick (within one spacing), so the Bond can post there
    const diff = tick > gradTick ? tick - gradTick : gradTick - tick;
    expect(diff).to.be.at.most(200n);

    // graduate cleanly (this is exactly what reverted on the live overshoot)
    await (await curveC.graduate()).wait();
    const bond = await ethers.getContractAt("Bond", await curveC.bond());
    expect(await bond.posted()).to.equal(true);
    expect(await bond.sherwoodL()).to.be.greaterThan(0n);
    expect(await bond.bountyL()).to.be.greaterThan(0n);
    expect(await bond.ambushL()).to.be.greaterThan(0n);
  });

  it("an overshoot buy is taxed only on what the curve actually absorbed, not the gross sent (PR-3)", async () => {
    const [dep, platform, dev, buyer] = await ethers.getSigners();
    const { router, factory } = await stack(dep, platform);
    // plain 1% coin so the whole fee lands in platform escrow (immediate + deferred) — easy to total
    const tax = { buyBps: 100, sellBps: 100, walletBps: 10000, floorBps: 0, burnBps: 0, projectWallet: dev.address };
    const rc = await (await factory.launch({ name: "Over", symbol: "OVER", dev: dev.address, tax })).wait();
    const ev = rc.logs.map((l) => { try { return factory.interface.parseLog(l); } catch { return null; } }).find((e) => e && e.name === "Launched");
    const { token } = ev.args;
    const routerAddr = await router.getAddress();

    await ethers.provider.send("evm_increaseTime", [400]);
    await ethers.provider.send("evm_mine", []);

    // Fire 20 ETH at a curve that only needs a few — the swap caps at the graduation tick and refunds the rest.
    const before = await ethers.provider.getBalance(buyer.address);
    const r = await (await router.connect(buyer).buy(token, 0, { value: 20n * ONE })).wait();
    const spentOnGas = r.gasUsed * r.gasPrice;
    const after = await ethers.provider.getBalance(buyer.address);
    const netSpent = before - after - spentOnGas; // ETH the buyer actually parted with (consumed + fee)

    // The buyer paid far less than the 20 ETH sent — the unconsumed remainder (fee included) was refunded.
    expect(netSpent).to.be.lessThan(10n * ONE);

    // Fee is charged on the consumed amount, so total escrow is WAY under 1% of the 20 ETH gross (0.2 ETH).
    const escrow = (await router.platformEscrow())
      + (await router.deferredEscrow(token))
      + (await router.platformCutEscrow())
      + (await router.devEscrow(token))
      + (await router.floorEscrow(token))
      + (await router.burnEscrow(token));
    expect(escrow).to.be.lessThan((20n * ONE * 100n) / 10_000n); // < 1% of gross -> not taxed on gross

    // Conservation: the router holds exactly the escrowed fee as native ETH, nothing stranded.
    expect(await ethers.provider.getBalance(routerAddr)).to.equal(escrow);
    expect(await ethers.provider.getBalance(routerAddr)).to.be.greaterThan(0n);
  });

  it("a tiny-raise curve graduates cleanly even when Sherwood absorbs all the Ambush supply (ambush=0)", async () => {
    const [dep, platform, dev, buyer] = await ethers.getSigners();
    // the cheap TEST curve: graduates after a few $ of buys — so little WETH that Sherwood takes ALL the
    // ambush token supply, leaving 0 for the Ambush band. The Bond must post Sherwood+Bounty and skip Ambush.
    const { router, factory } = await stack(dep, platform, 259400, 4000, 2000);
    const tax = { buyBps: 100, sellBps: 100, walletBps: 10000, floorBps: 0, burnBps: 0, projectWallet: dev.address };
    const rc = await (await factory.launch({ name: "Tiny", symbol: "TINY", dev: dev.address, tax })).wait();
    const ev = rc.logs.map((l) => { try { return factory.interface.parseLog(l); } catch { return null; } }).find((e) => e && e.name === "Launched");
    const { token, curve } = ev.args;
    const curveC = await ethers.getContractAt("CurvePool", curve);

    await ethers.provider.send("evm_increaseTime", [400]);
    await ethers.provider.send("evm_mine", []);
    await (await router.connect(buyer).buy(token, 0, { value: ONE })).wait(); // 1 ETH, capped at gradTick
    expect(await curveC.ready()).to.equal(true);

    await (await curveC.graduate()).wait(); // used to revert "bad L"; now skips the empty Ambush
    const bond = await ethers.getContractAt("Bond", await curveC.bond());
    expect(await bond.posted()).to.equal(true);
    expect(await bond.sherwoodL()).to.be.greaterThan(0n); // the floor's locked LP still posts
    // ambushL may be 0 here (all supply went to Sherwood) — that's allowed, not a revert
  });
});
