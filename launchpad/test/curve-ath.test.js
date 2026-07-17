const { expect } = require("chai");
const { ethers, network } = require("hardhat");

const ONE = 10n ** 18n;
const Q96 = 79228162514264337593543950336n;

describe("RobinStaking", () => {
  async function setup() {
    const [dep, a, b, funder] = await ethers.getSigners();
    const ROBIN = await (await ethers.getContractFactory("MockERC20")).deploy(1_000_000n * ONE);
    const staking = await (await ethers.getContractFactory("RobinStaking")).deploy(await ROBIN.getAddress());
    await ROBIN.transfer(a.address, 100_000n * ONE);
    await ROBIN.transfer(b.address, 100_000n * ONE);
    return { dep, a, b, funder, ROBIN, staking };
  }

  it("distributes ETH rewards pro-rata; stake/claim/unstake work", async () => {
    const s = await setup();
    const addr = await s.staking.getAddress();
    await s.ROBIN.connect(s.a).approve(addr, 100_000n * ONE);
    await s.ROBIN.connect(s.b).approve(addr, 100_000n * ONE);
    await s.staking.connect(s.a).stake(30_000n * ONE); // a: 30k
    await s.staking.connect(s.b).stake(10_000n * ONE); // b: 10k  -> a:b = 3:1

    // 4 ETH of rewards
    await s.staking.connect(s.funder).notifyReward({ value: 4n * ONE });
    expect(await s.staking.pending(s.a.address)).to.equal(3n * ONE); // 3/4
    expect(await s.staking.pending(s.b.address)).to.equal(1n * ONE); // 1/4

    const before = await ethers.provider.getBalance(s.a.address);
    const rc = await (await s.staking.connect(s.a).claim()).wait();
    const gas = rc.gasUsed * rc.gasPrice;
    expect(await ethers.provider.getBalance(s.a.address)).to.equal(before + 3n * ONE - gas);
    expect(await s.staking.pending(s.a.address)).to.equal(0n);

    // unstake is locked for UNSTAKE_DELAY (anti-JIT), then returns the staked ROBIN
    await expect(s.staking.connect(s.b).unstake(10_000n * ONE)).to.be.revertedWithCustomError(s.staking, "Locked");
    await network.provider.send("evm_increaseTime", [24 * 3600 + 1]);
    await network.provider.send("evm_mine");
    await s.staking.connect(s.b).unstake(10_000n * ONE);
    expect(await s.ROBIN.balanceOf(s.b.address)).to.equal(100_000n * ONE);
  });

  it("queues rewards when nobody is staked, then distributes", async () => {
    const s = await setup();
    const addr = await s.staking.getAddress();
    await s.staking.connect(s.funder).notifyReward({ value: ONE }); // no stakers -> queued
    expect(await s.staking.queuedRewards()).to.equal(ONE);
    await s.ROBIN.connect(s.a).approve(addr, 100_000n * ONE);
    await s.staking.connect(s.a).stake(50_000n * ONE);
    await s.staking.connect(s.funder).notifyReward({ value: ONE }); // flushes queued + new
    expect(await s.staking.pending(s.a.address)).to.equal(2n * ONE);
  });
});

describe("AthVault (isolated)", () => {
  async function setup() {
    const [dep, dev, platform, staker] = await ethers.getSigners();
    const WETH = await (await ethers.getContractFactory("MockWETH9")).deploy();
    const V3 = await (await ethers.getContractFactory("MockUniswapV3Factory")).deploy();
    const ROBIN = await (await ethers.getContractFactory("MockERC20")).deploy(1_000_000n * ONE);
    const staking = await (await ethers.getContractFactory("RobinStaking")).deploy(await ROBIN.getAddress());

    const SUPPLY = 1_000_000n * ONE;
    const TOK = await (await ethers.getContractFactory("MockERC20")).deploy(SUPPLY);
    const vaultAmt = SUPPLY / 10n; // 10%

    const startLevel = -1000000; // gate effectively open for the test
    const vault = await (await ethers.getContractFactory("AthVault")).deploy(
      await V3.getAddress(), await TOK.getAddress(), await WETH.getAddress(),
      dev.address, platform.address, await staking.getAddress(), 1800, startLevel
    );
    await TOK.transfer(await vault.getAddress(), vaultAmt);

    // create + initialize the pool (as graduation would), fund it with WETH + tokens for swaps
    await V3.createPool(await TOK.getAddress(), await WETH.getAddress(), 10000);
    const poolAddr = await V3.getPool(await TOK.getAddress(), await WETH.getAddress(), 10000);
    const pool = await ethers.getContractAt("MockUniswapV3Pool", poolAddr);
    await pool.setWeth(await WETH.getAddress());
    const tokenIsToken0 = BigInt(await TOK.getAddress()) < BigInt(await WETH.getAddress());
    // spot sqrtPrice giving quoteWethPerToken ~ 1e6 wei/token (a cheap meme), per ordering
    const spot = tokenIsToken0 ? Q96 / 1_000_000n : Q96 * 1_000_000n;
    await pool.initialize(spot);
    await pool.setPrice(1_000_000n); // wei per token, matches spot so sells clear minOut
    // fund pool reserves
    await WETH.deposit({ value: 5n * ONE });
    await WETH.transfer(poolAddr, 5n * ONE);
    await TOK.transfer(poolAddr, SUPPLY / 20n);

    return { dep, dev, platform, staker, WETH, V3, ROBIN, staking, TOK, vault, pool, tokenIsToken0, vaultAmt };
  }

  // helper: set the TWAP mean + spot tick to a given price-level (direction-aware)
  async function setLevel(s, level) {
    const tick = s.tokenIsToken0 ? level : -level;
    await s.pool.setObserveMeanTick(tick);
    await s.pool.setTick(tick);
  }

  it("activates, ladders sales on new ATHs, splits 40/20/40, decays geometrically", async () => {
    const s = await setup();
    await s.vault.activate();
    expect(await s.vault.active()).to.equal(true);

    // no new ATH yet (level 0 == graduation hwm) -> not eligible
    await setLevel(s, 0);
    await expect(s.vault.poke()).to.be.revertedWithCustomError(s.vault, "NotEligible");

    // first ATH: level 600 (> gap 488)
    await setLevel(s, 600);
    const stakeBefore = await ethers.provider.getBalance(await s.staking.getAddress());
    const platBefore = await s.WETH.balanceOf(s.platform.address);
    const vaultTokBefore = await s.TOK.balanceOf(await s.vault.getAddress());

    await s.vault.poke();
    const sold1 = vaultTokBefore - (await s.TOK.balanceOf(await s.vault.getAddress()));
    expect(sold1).to.equal(vaultTokBefore * 150n / 10000n); // 1.5% of remaining

    // split checks: staking got ETH (20%), platform got WETH (40%), dev reserve holds WETH (40%)
    const devRes = await s.vault.devReserveWeth();
    const platGot = (await s.WETH.balanceOf(s.platform.address)) - platBefore;
    const stakeGot = (await ethers.provider.getBalance(await s.staking.getAddress())) - stakeBefore;
    expect(devRes).to.be.greaterThan(0n);
    expect(platGot).to.equal(devRes); // 40% == 40%
    // stakeGot ~= half of devRes (20% vs 40%), allow rounding
    expect(stakeGot * 2n).to.be.closeTo(devRes, 5n);

    // same level -> no new ATH
    await expect(s.vault.poke()).to.be.revertedWithCustomError(s.vault, "CooldownActive");
    await network.provider.send("evm_increaseTime", [3700]);
    await network.provider.send("evm_mine");
    await setLevel(s, 700); // < 600 + 488 -> not a new-enough high
    await expect(s.vault.poke()).to.be.revertedWithCustomError(s.vault, "NotEligible");

    // higher ATH -> sells again, smaller tranche (geometric decay)
    await setLevel(s, 1200);
    const before2 = await s.TOK.balanceOf(await s.vault.getAddress());
    await s.vault.poke();
    const sold2 = before2 - (await s.TOK.balanceOf(await s.vault.getAddress()));
    expect(sold2).to.be.lessThan(sold1); // decays
  });

  it("dev can burn OR withdraw the 40% reserve; nobody else can", async () => {
    const s = await setup();
    await s.vault.activate();
    await setLevel(s, 800);
    await s.vault.poke();
    const reserve = await s.vault.devReserveWeth();
    expect(reserve).to.be.greaterThan(0n);

    // non-dev blocked
    await expect(s.vault.connect(s.platform).devWithdraw(1)).to.be.revertedWithCustomError(s.vault, "NotDev");

    // withdraw half
    const half = reserve / 2n;
    const devWethBefore = await s.WETH.balanceOf(s.dev.address);
    await s.vault.connect(s.dev).devWithdraw(half);
    expect(await s.WETH.balanceOf(s.dev.address)).to.equal(devWethBefore + half);

    // burn the rest -> tokens to dead
    const burnBefore = await s.TOK.balanceOf("0x000000000000000000000000000000000000dEaD");
    await s.vault.connect(s.dev).devBurn(await s.vault.devReserveWeth(), 0);
    expect(await s.TOK.balanceOf("0x000000000000000000000000000000000000dEaD")).to.be.greaterThan(burnBefore);
    expect(await s.vault.devReserveWeth()).to.equal(0n);
  });

  it("has no path to withdraw the token allocation itself (anti-rug)", async () => {
    const s = await setup();
    const has = s.vault.interface.fragments.find(
      (f) => f.type === "function" && /withdrawToken|sweep|rescue|drain/i.test(f.name)
    );
    expect(has).to.be.undefined;
  });
});
