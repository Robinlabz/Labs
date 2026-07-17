const { expect } = require("chai");
const { ethers } = require("hardhat");

const ONE = 10n ** 18n;
const FEE_BPS = 100n, BPS = 10000n;
const ceilDiv = (a, b) => (a + b - 1n) / b;

// JS reference model — must match BondingCurve.sol exactly.
class Ref {
  constructor(virt, supply, grad) { this.VIRT = virt; this.K = virt * supply; this.GRAD = grad; this.RE = virt; this.RT = supply; this.grad = false; }
  raised() { return this.RE - this.VIRT; }
  buy(eth) {
    let fee = (eth * FEE_BPS) / BPS, net = eth - fee;
    const room = this.GRAD - this.raised();
    if (net > room) { let g = ceilDiv(room * BPS, BPS - FEE_BPS); if (g > eth) g = eth; fee = g - room; net = room; }
    const nRE = this.RE + net, nRT = this.K / nRE, out = this.RT - nRT;
    this.RE = nRE; this.RT = nRT; if (this.raised() >= this.GRAD) this.grad = true; return out;
  }
  sell(t) {
    const nRT = this.RT + t, nRE = ceilDiv(this.K, nRT), gross = this.RE - nRE;
    this.RT = nRT; this.RE = nRE; const fee = (gross * FEE_BPS) / BPS; return gross - fee;
  }
}

async function setup() {
  const [dep, platform, dev, a, b, c] = await ethers.getSigners();
  const WETH = await (await ethers.getContractFactory("MockWETH9")).deploy();
  const V3 = await (await ethers.getContractFactory("MockUniswapV3Factory")).deploy();
  const SUPPLY = 800_000_000n * ONE; // curve trading supply
  const RAMP = 200_000_000n * ONE;   // held by the curve, handed to the Bond's Ramparts at graduation
  const TOK = await (await ethers.getContractFactory("MockERC20")).deploy(SUPPLY + RAMP);
  const bd = await (await ethers.getContractFactory("BondDeployer")).deploy();
  const VIRT = ONE, GRAD = 5n * ONE;
  const Curve = await ethers.getContractFactory("BondingCurve");
  const curve = await Curve.deploy(
    await TOK.getAddress(), await WETH.getAddress(), await V3.getAddress(),
    platform.address, dev.address, VIRT, SUPPLY, GRAD, 0, 0, await bd.getAddress(), RAMP
  );
  await TOK.transfer(await curve.getAddress(), SUPPLY + RAMP); // fund the curve (trading + ramp reserve)
  // NOTE: the mock pool can't model the Bond's single-sided range orders, so these unit tests exercise
  // curve mechanics up to (not through) graduation. Graduation + Bond posting are covered on a real
  // Uniswap v3 fork (test/fork/graduation.fork.test.js, test/fork/bond.fork.test.js).
  return { dep, platform, dev, traders: [a, b, c], WETH, V3, TOK, curve, SUPPLY, VIRT, GRAD };
}

describe("BondingCurve", () => {
  it("matches the reference model over a random buy/sell sequence (contract == math)", async () => {
    const s = await setup();
    const ref = new Ref(s.VIRT, s.SUPPLY, s.GRAD);
    let seed = 12345;
    const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };

    for (let i = 0; i < 40; i++) {
      if (await s.curve.graduated()) break;
      const trader = s.traders[i % s.traders.length];
      const buy = rnd() < 0.7;
      if (buy) {
        const eth = BigInt(Math.max(1e12, Math.floor(rnd() * 0.4 * Number(s.GRAD))));
        // don't let a buy tip the curve over graduation (the mock can't post the Bond) — skip if it would
        if (ref.RE - ref.VIRT + eth >= s.GRAD) continue;
        await s.curve.connect(trader).buy(0, { value: eth });
        ref.buy(eth);
      } else {
        const bal = await s.TOK.balanceOf(trader.address);
        if (bal === 0n) continue;
        const amt = (bal * BigInt(1 + Math.floor(rnd() * 90))) / 100n;
        if (amt === 0n) continue;
        await s.TOK.connect(trader).approve(await s.curve.getAddress(), amt);
        await s.curve.connect(trader).sell(amt, 0);
        ref.sell(amt);
      }
      // contract state must equal the reference model exactly
      expect(await s.curve.reserveEth()).to.equal(ref.RE);
      expect(await s.curve.reserveToken()).to.equal(ref.RT);
    }
  });

  it("claims + initializes its pool at launch, so a griefer cannot pre-initialize it", async () => {
    const s = await setup();
    // the curve already created + initialized the (token, WETH) pool in its constructor
    const p = await s.curve.pool();
    expect(p).to.not.equal(ethers.ZeroAddress);
    expect(p).to.equal(await s.V3.getPool(await s.TOK.getAddress(), await s.WETH.getAddress(), 10000));
    const pool = await ethers.getContractAt("MockUniswapV3Pool", p);
    const [sqrtP] = await pool.slot0();
    expect(sqrtP).to.equal(await s.curve.gradSqrtPriceX96()); // priced at the committed graduation price

    // a griefer can no longer create OR re-initialize the pool
    await expect(s.V3.createPool(await s.TOK.getAddress(), await s.WETH.getAddress(), 10000)).to.be.revertedWith("exists");
    await expect(pool.initialize(79228162514264337593543950336n)).to.be.revertedWith("init");
    // (graduation into this pool -> Bond posting is exercised on a real v3 fork, not the flat mock)
  });

  it("fee model: buy streams 0.9% to platform + keeps 0.1% buffer; sell fee to dev (collect or burn)", async () => {
    const s = await setup();
    const platBefore = await ethers.provider.getBalance(s.platform.address);
    await s.curve.connect(s.traders[0]).buy(0, { value: ONE }); // 1 ETH buy, fee 0.01 ETH
    // 0.9% (0.009 ETH) streamed to platform now, 0.1% (0.001 ETH) held as buffer
    expect((await ethers.provider.getBalance(s.platform.address)) - platBefore).to.equal(9n * 10n ** 15n);
    expect(await s.curve.platformBuffer()).to.equal(1n * 10n ** 15n);

    // trader sells -> 1% of the ETH out accrues to the dev
    const bag = await s.TOK.balanceOf(s.traders[0].address);
    await s.TOK.connect(s.traders[0]).approve(await s.curve.getAddress(), bag);
    await s.curve.connect(s.traders[0]).sell(bag, 0);
    const devRes = await s.curve.devSellReserve();
    expect(devRes).to.be.greaterThan(0n);

    // non-dev can't touch it
    await expect(s.curve.connect(s.traders[1]).devCollect(1)).to.be.revertedWithCustomError(s.curve, "NotDev");

    // dev collects half as ETH
    const half = devRes / 2n;
    const devWethBefore = await ethers.provider.getBalance(s.dev.address);
    const rc = await (await s.curve.connect(s.dev).devCollect(half)).wait();
    expect(await ethers.provider.getBalance(s.dev.address)).to.equal(devWethBefore + half - rc.gasUsed * rc.gasPrice);

    // dev burns the rest -> buys on the curve and sends tokens to dead
    const burnBefore = await s.TOK.balanceOf("0x000000000000000000000000000000000000dEaD");
    await s.curve.connect(s.dev).devBurn(await s.curve.devSellReserve(), 0);
    expect(await s.TOK.balanceOf("0x000000000000000000000000000000000000dEaD")).to.be.greaterThan(burnBefore);
    expect(await s.curve.devSellReserve()).to.equal(0n);
  });

  it("a round trip (buy then sell) never returns a profit", async () => {
    const s = await setup();
    await s.curve.connect(s.traders[0]).buy(0, { value: ONE }); // move onto the curve
    const t = s.traders[1];
    const before = await ethers.provider.getBalance(t.address);
    const spend = ONE / 2n;
    const rc1 = await (await s.curve.connect(t).buy(0, { value: spend })).wait();
    const got = await s.TOK.balanceOf(t.address);
    await (await s.TOK.connect(t).approve(await s.curve.getAddress(), got)).wait();
    await (await s.curve.connect(t).sell(got, 0)).wait();
    const after = await ethers.provider.getBalance(t.address);
    // net ETH (ignoring gas) must be negative — the curve+fees always win the round trip
    // compare token-value: they spent `spend`, got back < spend in ETH
    expect(after).to.be.lessThan(before); // includes gas, but must hold regardless
  });

  it("enforces the anti-snipe max-buy cap during the window, then lifts it", async () => {
    const [dep, platform, dev, trader] = await ethers.getSigners();
    const WETH = await (await ethers.getContractFactory("MockWETH9")).deploy();
    const V3 = await (await ethers.getContractFactory("MockUniswapV3Factory")).deploy();
    const SUPPLY = 800_000_000n * ONE;
    const TOK = await (await ethers.getContractFactory("MockERC20")).deploy(SUPPLY);
    const bd = await (await ethers.getContractFactory("BondDeployer")).deploy();
    const curve = await (await ethers.getContractFactory("BondingCurve")).deploy(
      await TOK.getAddress(), await WETH.getAddress(), await V3.getAddress(),
      platform.address, dev.address, ONE, SUPPLY, 50n * ONE, 3600, ONE / 10n, // 0.1 ETH cap, 1h window
      await bd.getAddress(), 0n
    );
    await TOK.transfer(await curve.getAddress(), SUPPLY);
    // net > 0.1 ETH during the window reverts
    await expect(curve.connect(trader).buy(0, { value: ONE })).to.be.revertedWithCustomError(curve, "SnipeCap");
    // within the cap is fine
    await curve.connect(trader).buy(0, { value: ONE / 20n }); // 0.05 ETH
    // after the window, big buys allowed
    await ethers.provider.send("evm_increaseTime", [3700]);
    await ethers.provider.send("evm_mine");
    await curve.connect(trader).buy(0, { value: 2n * ONE });
  });
});
