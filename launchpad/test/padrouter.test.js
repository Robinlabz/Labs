const { expect } = require("chai");
const { ethers } = require("hardhat");

// Exact-math unit tests of the PadRouter fee model on a mock Uniswap v3 pool (no fork needed).
// Model: default 1%/side is the platform's (0.9% immediate + 0.1% deferred to graduation); anything
// stacked ABOVE 1% splits 25% -> the platform buy-back cut and 75% -> the project (wallet/floor/burn).
const ONE = 10n ** 18n;
const DEAD = "0x000000000000000000000000000000000000dEaD";

describe("PadRouter — fee model (mock pool)", function () {
  async function mkCoin(dep, sharedWeth = null, supply = 1_000_000n * ONE, priceE = ONE) {
    const weth = sharedWeth || (await (await ethers.getContractFactory("MockWETH9")).deploy());
    const wethAddr = await weth.getAddress();
    const token = await (await ethers.getContractFactory("MockERC20")).deploy(supply);
    const tokAddr = await token.getAddress();
    const [t0, t1] = tokAddr.toLowerCase() < wethAddr.toLowerCase() ? [tokAddr, wethAddr] : [wethAddr, tokAddr];
    const pool = await (await ethers.getContractFactory("MockUniswapV3Pool")).deploy(t0, t1, 10000);
    await (await pool.setWeth(wethAddr)).wait();
    await (await pool.setPrice(priceE)).wait();
    const poolAddr = await pool.getAddress();
    await (await token.transfer(poolAddr, supply / 2n)).wait();
    await (await weth.deposit({ value: 100n * ONE })).wait();
    await (await weth.transfer(poolAddr, 100n * ONE)).wait();
    return { weth, wethAddr, token, tokAddr, pool, poolAddr };
  }

  async function deploy() {
    const [dep, platform, dev, buyer] = await ethers.getSigners();
    const base = await mkCoin(dep);
    const router = await (await ethers.getContractFactory("PadRouter")).deploy(base.wethAddr, platform.address);
    await (await router.connect(platform).setFactory(dep.address)).wait();
    const curve = await (await ethers.getContractFactory("MockCurve")).deploy();
    return { dep, platform, dev, buyer, ...base, router, curve, curveAddr: await curve.getAddress() };
  }

  it("registration enforces the 1% floor, the 4% cap, 100% allocation, and factory-only", async () => {
    const { dep, dev, tokAddr, poolAddr, router } = await deploy();
    const reg = (buy, sell, w, f, b) =>
      router.register(tokAddr, poolAddr, ethers.ZeroAddress, dev.address, buy, sell, w, f, b);
    await expect(reg(99, 100, 10000, 0, 0)).to.be.revertedWithCustomError(router, "BadTax"); // below 1%
    await expect(reg(100, 401, 10000, 0, 0)).to.be.revertedWithCustomError(router, "BadTax"); // above 4%
    await expect(reg(200, 200, 5000, 3000, 1000)).to.be.revertedWithCustomError(router, "BadAlloc");
    await expect(router.connect(dev).register(tokAddr, poolAddr, ethers.ZeroAddress, dev.address, 100, 100, 10000, 0, 0))
      .to.be.revertedWithCustomError(router, "OnlyFactory");
    await expect(reg(100, 100, 10000, 0, 0)).to.not.be.reverted; // plain default 1%
    // register-once: a coin's config can never be overwritten, even by the factory (PR-6)
    await expect(reg(400, 400, 5000, 3000, 2000)).to.be.revertedWithCustomError(router, "AlreadySet");
  });

  it("register is one-shot per token, and renounceOwnership is permanently disabled (PR-6, PR-7)", async () => {
    const { dep, dev, tokAddr, poolAddr, router } = await deploy();
    await (await router.register(tokAddr, poolAddr, ethers.ZeroAddress, dev.address, 100, 100, 10000, 0, 0)).wait();
    // a second register for the same token reverts, so a coin's fee config is immutable after launch
    await expect(router.register(tokAddr, poolAddr, ethers.ZeroAddress, dev.address, 400, 400, 10000, 0, 0))
      .to.be.revertedWithCustomError(router, "AlreadySet");
    // ownership is load-bearing (all platform payouts route to owner()); renouncing is blocked forever
    await expect(router.connect(dep).renounceOwnership()).to.be.reverted;
  });

  it("a WETH donation can't evade the buy fee — consumed comes from the swap, not balanceOf", async () => {
    const { dep, dev, buyer, weth, token, tokAddr, poolAddr, router } = await deploy();
    await (await router.register(tokAddr, poolAddr, ethers.ZeroAddress, dev.address, 100, 100, 10000, 0, 0)).wait();
    // attacker plants stray WETH in the router (under balanceOf-based accounting this would zero/shrink the fee)
    const donation = ONE / 2n;
    await (await weth.connect(dep).deposit({ value: donation })).wait();
    await (await weth.connect(dep).transfer(await router.getAddress(), donation)).wait();

    const v = ONE;
    await (await router.connect(buyer).buy(tokAddr, 0, { value: v })).wait();
    // the fee is STILL charged on the full trade (0.9% + 0.1%), not evaded by the donation
    expect(await router.platformEscrow()).to.equal((v * 90n) / 10_000n);
    expect(await router.deferredEscrow(tokAddr)).to.equal((v * 10n) / 10_000n);
    // and the buyer received tokens for the full net (donation didn't reduce what they paid in fee)
    expect(await token.balanceOf(buyer.address)).to.equal(v - (v * 100n) / 10_000n);
  });

  it("a plain 1% coin: platform gets 0.9% now + 0.1% deferred; nothing else moves", async () => {
    const { dep, platform, dev, buyer, token, tokAddr, poolAddr, router } = await deploy();
    await (await router.register(tokAddr, poolAddr, ethers.ZeroAddress, dev.address, 100, 100, 10000, 0, 0)).wait();

    const v = ONE;
    await (await router.connect(buyer).buy(tokAddr, 0, { value: v })).wait();
    expect(await router.platformEscrow()).to.equal((v * 90n) / 10_000n); // 0.9%
    expect(await router.deferredEscrow(tokAddr)).to.equal((v * 10n) / 10_000n); // 0.1%
    // no above-default fee => these stay empty
    expect(await router.platformCutEscrow()).to.equal(0n);
    expect(await router.devEscrow(tokAddr)).to.equal(0n);
    expect(await router.floorEscrow(tokAddr)).to.equal(0n);
    expect(await router.burnEscrow(tokAddr)).to.equal(0n);
    // trader received net of the full 1%
    expect(await token.balanceOf(buyer.address)).to.equal(v - (v * 100n) / 10_000n);
  });

  it("a 4% coin: 0.9%+0.1% platform, then 25% of the extra 3% is the platform buy-back cut, 75% to the project", async () => {
    const { dep, platform, dev, buyer, token, tokAddr, poolAddr, router } = await deploy();
    // 4% buy; project split 50% wallet / 30% floor / 20% burn
    await (await router.register(tokAddr, poolAddr, ethers.ZeroAddress, dev.address, 400, 400, 5000, 3000, 2000)).wait();

    const v = ONE;
    const immediate = (v * 90n) / 10_000n; // 0.9%
    const deferred = (v * 10n) / 10_000n; // 0.1%
    const excess = (v * 300n) / 10_000n; // 3%
    const platformCut = (excess * 2500n) / 10_000n; // 25% of the excess
    const proj = excess - platformCut; // 75%
    const devCut = (proj * 5000n) / 10_000n;
    const burnCut = (proj * 2000n) / 10_000n;
    const floorCut = proj - devCut - burnCut;

    await (await router.connect(buyer).buy(tokAddr, 0, { value: v })).wait();
    expect(await router.platformEscrow()).to.equal(immediate);
    expect(await router.deferredEscrow(tokAddr)).to.equal(deferred);
    expect(await router.platformCutEscrow()).to.equal(platformCut);
    expect(await router.devEscrow(tokAddr)).to.equal(devCut);
    expect(await router.floorEscrow(tokAddr)).to.equal(floorCut);
    expect(await router.burnEscrow(tokAddr)).to.equal(burnCut);
    // everything sums to the full 4% fee
    const total = immediate + deferred + platformCut + devCut + floorCut + burnCut;
    expect(total).to.equal((v * 400n) / 10_000n);
  });

  it("the deferred 0.1% is held until graduation, then releases to the platform", async () => {
    const { dep, platform, dev, buyer, tokAddr, poolAddr, router, curve, curveAddr } = await deploy();
    await (await router.register(tokAddr, poolAddr, curveAddr, dev.address, 100, 100, 10000, 0, 0)).wait();
    await (await router.connect(buyer).buy(tokAddr, 0, { value: ONE })).wait();
    const deferred = await router.deferredEscrow(tokAddr);
    expect(deferred).to.be.greaterThan(0n);

    // before graduation: claim is a no-op
    await (await router.claimDeferred(tokAddr)).wait();
    expect(await router.deferredEscrow(tokAddr)).to.equal(deferred);

    // graduate the coin (bond appears) -> claim moves the deferred 0.1% into platform escrow
    await (await curve.setBond(dev.address)).wait();
    const platBefore = await router.platformEscrow();
    await (await router.claimDeferred(tokAddr)).wait();
    expect(await router.deferredEscrow(tokAddr)).to.equal(0n);
    expect(await router.platformEscrow()).to.equal(platBefore + deferred);
  });

  it("the above-default 25% platform buy-back cut accrues separately and pays out to the platform", async () => {
    const { dep, platform, dev, buyer, tokAddr, poolAddr, router } = await deploy();
    await (await router.register(tokAddr, poolAddr, ethers.ZeroAddress, dev.address, 400, 400, 10000, 0, 0)).wait();

    // a 4% buy: the 25% of the 3% excess is earmarked as the platform buy-back cut
    await (await router.connect(buyer).buy(tokAddr, 0, { value: ONE })).wait();
    const excess = (ONE * 300n) / 10_000n;
    const cut = (excess * 2500n) / 10_000n;
    expect(await router.platformCutEscrow()).to.equal(cut);

    // withdraw pays it to the platform (owner), who buys/burns the platform token off-chain
    const platBefore = await ethers.provider.getBalance(platform.address);
    await (await router.connect(buyer).withdrawPlatformCut()).wait();
    expect(await router.platformCutEscrow()).to.equal(0n);
    expect(await ethers.provider.getBalance(platform.address)).to.equal(platBefore + cut);
  });

  it("the creator can BURN their sell-fee escrow instead of collecting it — and only they can", async () => {
    const { dep, dev, buyer, token, tokAddr, poolAddr, router, curveAddr } = await deploy();
    await (await router.register(tokAddr, poolAddr, curveAddr, dev.address, 100, 100, 10000, 0, 0)).wait();
    // accrue a sell-fee escrow for the creator
    await (await token.transfer(buyer.address, 10n * ONE)).wait();
    await (await token.connect(buyer).approve(await router.getAddress(), 10n * ONE)).wait();
    await (await router.connect(buyer).sell(tokAddr, 10n * ONE, 0)).wait();
    const esc = await router.devEscrow(tokAddr);
    expect(esc).to.be.greaterThan(0n);

    // a random caller cannot torch the creator's money
    await expect(router.connect(buyer).burnDev(tokAddr)).to.be.revertedWithCustomError(router, "NotCreator");

    // the creator chooses to burn: escrow buys the token and sends it to dead
    const deadBefore = await token.balanceOf(DEAD);
    await (await router.connect(dev).burnDev(tokAddr)).wait();
    expect(await token.balanceOf(DEAD)).to.be.greaterThan(deadBefore);
    // escrow is spent (mock pool fully fills, so no residual re-credit)
    expect(await router.devEscrow(tokAddr)).to.equal(0n);
  });

  it("a plain 1% sell: the CREATOR gets the whole 1%, the platform gets nothing", async () => {
    const { dep, dev, buyer, token, tokAddr, poolAddr, router } = await deploy();
    await (await router.register(tokAddr, poolAddr, ethers.ZeroAddress, dev.address, 100, 100, 10000, 0, 0)).wait();
    await (await token.transfer(buyer.address, 10n * ONE)).wait();
    const amt = 10n * ONE;
    await (await token.connect(buyer).approve(await router.getAddress(), amt)).wait();

    const wethOut = amt; // 1:1
    await (await router.connect(buyer).sell(tokAddr, amt, 0)).wait();
    // the sell-side default 1% is the creator's, accrued to the project wallet's escrow
    expect(await router.devEscrow(tokAddr)).to.equal((wethOut * 100n) / 10_000n);
    // platform gets nothing off a plain sell — no immediate, no deferred, no platform buy-back cut
    expect(await router.platformEscrow()).to.equal(0n);
    expect(await router.deferredEscrow(tokAddr)).to.equal(0n);
    expect(await router.platformCutEscrow()).to.equal(0n);
    expect(await router.floorEscrow(tokAddr)).to.equal(0n);
    expect(await router.burnEscrow(tokAddr)).to.equal(0n);
  });

  it("sell with a raised tax: creator gets the 1% base + wallet share; platform gets only the platform buy-back cut", async () => {
    const { dep, dev, buyer, token, tokAddr, poolAddr, router } = await deploy();
    await (await router.register(tokAddr, poolAddr, ethers.ZeroAddress, dev.address, 100, 300, 4000, 4000, 2000)).wait();
    await (await token.transfer(buyer.address, 10n * ONE)).wait();
    const amt = 10n * ONE;
    await (await token.connect(buyer).approve(await router.getAddress(), amt)).wait();

    const wethOut = amt; // 1:1
    // 3% sell = 1% base -> creator, then 2% excess splits 25% platform / 75% project (wallet/floor/burn)
    const base = (wethOut * 100n) / 10_000n;
    const excess = (wethOut * 200n) / 10_000n;
    const platformCut = (excess * 2500n) / 10_000n;
    const proj = excess - platformCut;
    const walletCut = (proj * 4000n) / 10_000n;
    const burnCut = (proj * 2000n) / 10_000n;
    const floorCut = proj - walletCut - burnCut;

    await (await router.connect(buyer).sell(tokAddr, amt, 0)).wait();
    expect(await router.devEscrow(tokAddr)).to.equal(base + walletCut); // creator: base + wallet share
    expect(await router.platformCutEscrow()).to.equal(platformCut);       // platform's only cut on a sell
    expect(await router.floorEscrow(tokAddr)).to.equal(floorCut);
    expect(await router.burnEscrow(tokAddr)).to.equal(burnCut);
    expect(await router.platformEscrow()).to.equal(0n);                 // no platform base off a sell
    expect(await router.deferredEscrow(tokAddr)).to.equal(0n);
    // conservation: every wei of the 3% fee is accounted for
    const total = base + platformCut + walletCut + floorCut + burnCut;
    expect(total).to.equal((wethOut * 300n) / 10_000n);
  });
});
