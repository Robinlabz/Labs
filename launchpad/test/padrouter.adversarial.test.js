const { expect } = require("chai");
const { ethers } = require("hardhat");

// "Every which way something could go wrong" — adversarial simulations against the PadRouter tax + swap desk.
const ONE = 10n ** 18n;
const DEAD = "0x000000000000000000000000000000000000dEaD";

describe("PadRouter — adversarial simulations", function () {
  async function fixture(taxOverride) {
    const [dep, platform, dev, buyer, mallory] = await ethers.getSigners();
    const weth = await (await ethers.getContractFactory("MockWETH9")).deploy();
    const token = await (await ethers.getContractFactory("MockERC20")).deploy(1_000_000n * ONE);
    const wethAddr = await weth.getAddress();
    const tokAddr = await token.getAddress();
    const [t0, t1] = tokAddr.toLowerCase() < wethAddr.toLowerCase() ? [tokAddr, wethAddr] : [wethAddr, tokAddr];
    const pool = await (await ethers.getContractFactory("MockUniswapV3Pool")).deploy(t0, t1, 10000);
    await (await pool.setWeth(wethAddr)).wait();
    await (await pool.setPrice(ONE)).wait();
    const poolAddr = await pool.getAddress();
    await (await token.transfer(poolAddr, 500_000n * ONE)).wait();
    await (await weth.deposit({ value: 200n * ONE })).wait();
    await (await weth.transfer(poolAddr, 200n * ONE)).wait();

    const router = await (await ethers.getContractFactory("PadRouter")).deploy(wethAddr, platform.address);
    await (await router.connect(platform).setFactory(dep.address)).wait();
    const tax = taxOverride || { buy: 400, sell: 400, w: 5000, f: 3000, b: 2000 };
    await (await router.register(tokAddr, poolAddr, ethers.ZeroAddress, dev.address, tax.buy, tax.sell, tax.w, tax.f, tax.b)).wait();
    return { dep, platform, dev, buyer, mallory, weth, token, tokAddr, pool, poolAddr, router };
  }

  it("the swap callback can't be invoked out of band (no funds leak via a spoofed callback)", async () => {
    const { tokAddr, router } = await fixture();
    const atk = await (await ethers.getContractFactory("RouterAttacker")).deploy(await router.getAddress(), tokAddr);
    await expect(atk.pokeCallback()).to.be.revertedWith("no swap");
    // even a direct EOA call reverts
    await expect(router.uniswapV3SwapCallback(1, -1, ethers.AbiCoder.defaultAbiCoder().encode(["address"], [tokAddr])))
      .to.be.revertedWith("no swap");
  });

  it("reentrancy: a hostile seller re-entering on its ETH payout cannot double-dip", async () => {
    const { token, tokAddr, router, buyer } = await fixture();
    const atk = await (await ethers.getContractFactory("RouterAttacker")).deploy(await router.getAddress(), tokAddr);
    const atkAddr = await atk.getAddress();
    await (await token.transfer(atkAddr, 100n * ONE)).wait();

    // seed some platform escrow (so a re-entrant withdrawPlatform would have something to steal)
    await (await router.connect(buyer).buy(tokAddr, 0, { value: ONE })).wait();

    // mode 1: re-enter buy() (nonReentrant) -> the payout call fails -> the sell reverts atomically
    await expect(atk.doSell(10n * ONE, 1)).to.be.reverted;
    // mode 2: re-enter withdrawPlatform() during payout -> also blocked, sell reverts, escrow intact
    const platEscrowBefore = await router.platformEscrow();
    await expect(atk.doSell(10n * ONE, 2)).to.be.reverted;
    expect(await router.platformEscrow()).to.equal(platEscrowBefore); // nothing siphoned
    // a passive (mode 0) sell of the same size works fine
    await expect(atk.doSell(10n * ONE, 0)).to.not.be.reverted;
  });

  it("escrow accounting is exact: platform + dev + floor + burn == every wei of tax, over many trades", async () => {
    const { token, tokAddr, router, buyer, mallory } = await fixture({ buy: 350, sell: 275, w: 4000, f: 3500, b: 2500 });
    // sum the ACTUAL fee the contract charged, from its own events (no JS re-rounding drift)
    const feeFromEvents = async (txp) => {
      const rc = await (await txp).wait();
      const ev = rc.logs.map((l) => { try { return router.interface.parseLog(l); } catch { return null; } })
        .find((e) => e && (e.name === "Bought" || e.name === "Sold"));
      return ev.args.fee;
    };
    let feeTotal = 0n;
    for (const v of [ONE / 3n, ONE, ONE / 7n, 3n * ONE, ONE / 1000n])
      feeTotal += await feeFromEvents(router.connect(buyer).buy(tokAddr, 0, { value: v }));
    await (await token.transfer(mallory.address, 50n * ONE)).wait();
    for (const a of [5n * ONE, ONE, 12n * ONE]) {
      await (await token.connect(mallory).approve(await router.getAddress(), a)).wait();
      feeTotal += await feeFromEvents(router.connect(mallory).sell(tokAddr, a, 0));
    }
    // not a single wei is created or destroyed: the four escrows sum to exactly the tax charged
    const sum = (await router.platformEscrow()) + (await router.platformCutEscrow())
      + (await router.deferredEscrow(tokAddr))
      + (await router.devEscrow(tokAddr)) + (await router.floorEscrow(tokAddr)) + (await router.burnEscrow(tokAddr));
    expect(sum).to.equal(feeTotal);
  });

  it("dust & degenerate inputs are handled, never stuck", async () => {
    const { token, tokAddr, router, buyer } = await fixture({ buy: 100, sell: 100, w: 10000, f: 0, b: 0 });
    // buy of 0 -> Dust
    await expect(router.connect(buyer).buy(tokAddr, 0, { value: 0 })).to.be.revertedWithCustomError(router, "Dust");
    // a fee that rounds to zero (tiny buy) still trades, just accrues nothing
    await (await router.connect(buyer).buy(tokAddr, 0, { value: 50n })).wait(); // 50 wei * 100/10000 = 0 fee
    expect(await router.platformEscrow()).to.equal(0n);
    // sell without approval -> reverts (no silent pull)
    await (await token.transfer(buyer.address, ONE)).wait();
    await expect(router.connect(buyer).sell(tokAddr, ONE, 0)).to.be.reverted;
    // unknown token -> Unknown
    await expect(router.connect(buyer).buy(buyer.address, 0, { value: ONE })).to.be.revertedWithCustomError(router, "Unknown");
  });

  it("payout flushers are safe no-ops when empty and can't be double-spent", async () => {
    const { dep, platform, dev, token, tokAddr, router, buyer } = await fixture();
    // nothing accrued yet -> all flushers are no-ops
    await expect(router.flushFloor(tokAddr)).to.not.be.reverted;
    await expect(router.flushBurn(tokAddr)).to.not.be.reverted;
    await expect(router.withdrawDev(tokAddr)).to.not.be.reverted;

    await (await router.connect(buyer).buy(tokAddr, 0, { value: ONE })).wait();
    const devEsc = await router.devEscrow(tokAddr);
    expect(devEsc).to.be.greaterThan(0n);
    // first withdrawDev pays, second is a 0 no-op (no double spend)
    const before = await ethers.provider.getBalance(dev.address);
    await (await router.connect(buyer).withdrawDev(tokAddr)).wait();
    await (await router.connect(buyer).withdrawDev(tokAddr)).wait();
    expect(await ethers.provider.getBalance(dev.address)).to.equal(before + devEsc);
    expect(await router.devEscrow(tokAddr)).to.equal(0n);

    // floor share can't leave before graduation (no Bond) — stays escrowed, not lost
    const floor = await router.floorEscrow(tokAddr);
    await (await router.flushFloor(tokAddr)).wait();
    expect(await router.floorEscrow(tokAddr)).to.equal(floor); // unchanged, safely held
  });

  it("burn flush actually removes supply, and re-credits any residual instead of stranding WETH", async () => {
    const { token, tokAddr, router, buyer } = await fixture({ buy: 400, sell: 100, w: 0, f: 0, b: 10000 });
    await (await router.connect(buyer).buy(tokAddr, 0, { value: ONE })).wait();
    const burnEsc = await router.burnEscrow(tokAddr);
    expect(burnEsc).to.be.greaterThan(0n);
    const deadBefore = await token.balanceOf(DEAD);
    await (await router.flushBurn(tokAddr)).wait();
    expect(await token.balanceOf(DEAD)).to.be.greaterThan(deadBefore); // supply burned
    // router holds no stray WETH afterwards (residual, if any, was re-credited to escrow)
    const weth = await ethers.getContractAt(["function balanceOf(address) view returns (uint256)"], await router.WETH());
    expect(await weth.balanceOf(await router.getAddress())).to.equal(0n);
  });

  it("conservation: the router's ETH balance always equals the sum of what it owes (escrows)", async () => {
    const { token, tokAddr, router, buyer, mallory } = await fixture({ buy: 300, sell: 200, w: 6000, f: 3000, b: 1000 });
    const routerAddr = await router.getAddress();
    const owed = async () => (await router.platformEscrow()) + (await router.platformCutEscrow())
      + (await router.deferredEscrow(tokAddr))
      + (await router.devEscrow(tokAddr)) + (await router.floorEscrow(tokAddr)) + (await router.burnEscrow(tokAddr));

    await (await router.connect(buyer).buy(tokAddr, 0, { value: 2n * ONE })).wait();
    await (await router.connect(buyer).buy(tokAddr, 0, { value: ONE / 5n })).wait();
    await (await token.transfer(mallory.address, 30n * ONE)).wait();
    await (await token.connect(mallory).approve(routerAddr, 30n * ONE)).wait();
    await (await router.connect(mallory).sell(tokAddr, 15n * ONE, 0)).wait();
    // held ETH == owed, before AND after a burn flush (which spends real ETH)
    expect(await ethers.provider.getBalance(routerAddr)).to.equal(await owed());
    await (await router.flushBurn(tokAddr)).wait();
    expect(await ethers.provider.getBalance(routerAddr)).to.equal(await owed());
    // and after paying the dev out
    await (await router.withdrawDev(tokAddr)).wait();
    expect(await ethers.provider.getBalance(routerAddr)).to.equal(await owed());
  });

  it("the fee constants are immutable — no setter to weaponize the split", async () => {
    const { router } = await fixture();
    expect(await router.DEFAULT_FEE_BPS()).to.equal(100); // 1% floor
    expect(await router.MAX_TAX_BPS()).to.equal(400); // 4% cap
    expect(await router.EXCESS_PLATFORM_BPS()).to.equal(2500); // 25% of the above-default fee -> platform buy-back
    expect(await router.PLATFORM_IMMEDIATE_BPS()).to.equal(90);
    expect(await router.PLATFORM_DEFERRED_BPS()).to.equal(10);
    // these are constants with no setter (only setFactory exists, owner-only + one-time)
    const names = router.interface.fragments.filter((f) => f.type === "function").map((f) => f.name);
    for (const bad of ["setPlatformBps", "setTax", "setDefaultFee", "setExcessBps"]) expect(names).to.not.include(bad);
  });
});
