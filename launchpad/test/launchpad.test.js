const { expect } = require("chai");
const { ethers, network } = require("hardhat");

const ONE = 10n ** 18n;
const SUPPLY = 1_000_000_000n * ONE; // 1B
const SEED = ethers.parseEther("1"); // 1 ETH of seed liquidity

// default guard: dead 2s, phase1 60s, window 300s; caps 0.5%/1% then 1%/2%; 2s cooldown
const GUARD = {
  deadSecs: 2,
  phase1Secs: 60,
  antiSnipeSecs: 300,
  maxTxBps1: 50,
  maxWalletBps1: 100,
  maxTxBps2: 100,
  maxWalletBps2: 200,
  cooldownSecs: 2,
};

// treasury = 30% -> tranches must sum to it. Use 3 milestones (2x,3x,4x).
const TREASURY = (SUPPLY * 3000n) / 10000n;
const MULTIPLES = [200, 300, 400];
const TRANCHES = [TREASURY / 4n, TREASURY / 4n, TREASURY - (TREASURY / 4n) * 2n];

async function deployBase() {
  const [deployer, dev, feeRecipient, user, attacker] = await ethers.getSigners();
  const WETH = await (await ethers.getContractFactory("MockWETH9")).deploy();
  const V3 = await (await ethers.getContractFactory("MockUniswapV3Factory")).deploy();
  const TD = await (await ethers.getContractFactory("TokenDeployer")).deploy();
  const VD = await (await ethers.getContractFactory("VaultDeployer")).deploy();
  const Factory = await (
    await ethers.getContractFactory("LaunchpadFactory")
  ).deploy(
    await WETH.getAddress(),
    await V3.getAddress(),
    feeRecipient.address,
    deployer.address,
    await TD.getAddress(),
    await VD.getAddress()
  );
  return { deployer, dev, feeRecipient, user, attacker, WETH, V3, Factory };
}

async function doLaunch(base, overrides = {}) {
  const { Factory, dev } = base;
  const params = {
    name: "Robin Test",
    symbol: "STEST",
    totalSupply: SUPPLY,
    seedEth: SEED,
    dev: dev.address,
    multiplesX100: MULTIPLES,
    tranches: TRANCHES,
    cardinalityNext: 600,
    twapWindow: 1800,
    salt: ethers.hexlify(ethers.randomBytes(32)),
    guard: GUARD,
    ...overrides,
  };
  params.multiplesX100 = overrides.multiplesX100 ?? MULTIPLES;
  const tx = await Factory.launch(params, { value: SEED });
  const rc = await tx.wait();
  const ev = rc.logs
    .map((l) => {
      try {
        return Factory.interface.parseLog(l);
      } catch {
        return null;
      }
    })
    .find((e) => e && e.name === "Launched");
  return {
    token: ev.args.token,
    pool: ev.args.pool,
    vault: ev.args.vault,
    sqrtPriceX96: ev.args.sqrtPriceX96,
    launchTick: ev.args.launchTick,
  };
}

async function wirePool(base, poolAddr) {
  const { WETH } = base;
  const pool = await ethers.getContractAt("MockUniswapV3Pool", poolAddr);
  await pool.setWeth(await WETH.getAddress());
  return pool;
}

describe("LaunchpadFactory.launch", () => {
  it("atomically deploys token, prices pool, funds 30% vault, locks LP, enables trading, burns dust", async () => {
    const base = await deployBase();
    const { token, pool, vault } = await doLaunch(base);

    const tk = await ethers.getContractAt("LaunchToken", token);
    const vlt = await ethers.getContractAt("MilestoneVault", vault);
    const locker = await base.Factory.locker();

    expect(await tk.totalSupply()).to.equal(SUPPLY);
    expect(await tk.tradingEnabled()).to.equal(true);
    expect(await tk.pool()).to.equal(pool);
    // vault holds exactly 30%
    expect(await tk.balanceOf(vault)).to.equal(TREASURY);
    expect(await vlt.allocation()).to.equal(TREASURY);
    // pool holds the LP tokens; factory holds 0 (dust burned)
    expect(await tk.balanceOf(await base.Factory.getAddress())).to.equal(0n);
    // locker is registered as LP owner/beneficiary path
    const lk = await ethers.getContractAt("LiquidityLocker", locker);
    expect(await lk.beneficiaryOf(pool)).to.equal(base.dev.address);
    // record stored
    const rec = await base.Factory.recordOf(token);
    expect(rec.pool).to.equal(pool);
    expect(rec.vault).to.equal(vault);
  });

  it("reverts if msg.value != seedEth + launchFee", async () => {
    const base = await deployBase();
    const params = {
      name: "X", symbol: "X", totalSupply: SUPPLY, seedEth: SEED, dev: base.dev.address,
      multiplesX100: MULTIPLES, tranches: TRANCHES, cardinalityNext: 600, twapWindow: 1800,
      salt: ethers.hexlify(ethers.randomBytes(32)), guard: GUARD,
    };
    await expect(base.Factory.launch(params, { value: SEED - 1n })).to.be.reverted;
  });

  it("reverts if tranches do not sum to the 30% treasury", async () => {
    const base = await deployBase();
    await expect(
      doLaunch(base, { tranches: [TREASURY / 2n, TREASURY / 4n, TREASURY / 4n - 1n] })
    ).to.be.reverted;
  });
});

describe("LaunchToken anti-snipe guard", () => {
  it("blocks buys in the dead window, enforces maxTx/maxWallet/cooldown, then goes normal", async () => {
    const base = await deployBase();
    const { token, pool } = await doLaunch(base);
    const tk = await ethers.getContractAt("LaunchToken", token);

    // impersonate the pool to simulate a "buy" (transfer FROM pool)
    await network.provider.send("hardhat_impersonateAccount", [pool]);
    await network.provider.send("hardhat_setBalance", [pool, "0x56BC75E2D63100000"]);
    const poolSigner = await ethers.getSigner(pool);

    const maxTx1 = (SUPPLY * 50n) / 10000n; // 0.5%
    const user = base.user.address;

    // dead window (timestamp < launchTime+2): buy reverts
    await expect(tk.connect(poolSigner).transfer(user, ONE)).to.be.revertedWithCustomError(tk, "DeadWindow");

    // move past dead window into phase 1
    await network.provider.send("evm_increaseTime", [5]);
    await network.provider.send("evm_mine");

    // oversize buy > maxTx reverts
    await expect(tk.connect(poolSigner).transfer(user, maxTx1 + 1n)).to.be.revertedWithCustomError(tk, "MaxTx");

    // valid buy ok
    await tk.connect(poolSigner).transfer(user, maxTx1 - 1n);
    // immediate second buy hits cooldown
    await expect(tk.connect(poolSigner).transfer(user, 1n)).to.be.revertedWithCustomError(tk, "Cooldown");

    // after window, transfers are unrestricted
    await network.provider.send("evm_increaseTime", [400]);
    await network.provider.send("evm_mine");
    await tk.connect(poolSigner).transfer(user, maxTx1 * 5n); // way over the old cap, now fine
    expect(await tk.antiSnipeActive()).to.equal(false);
  });

  it("never blocks sells (anti-honeypot)", async () => {
    const base = await deployBase();
    const { token, pool } = await doLaunch(base);
    const tk = await ethers.getContractAt("LaunchToken", token);

    // give the user a big bag directly from the pool after the window, then sell during a fresh...
    await network.provider.send("evm_increaseTime", [5]);
    await network.provider.send("evm_mine");
    await network.provider.send("hardhat_impersonateAccount", [pool]);
    await network.provider.send("hardhat_setBalance", [pool, "0x56BC75E2D63100000"]);
    const poolSigner = await ethers.getSigner(pool);
    const amt = (SUPPLY * 40n) / 10000n; // within phase1 maxWallet 1%
    await tk.connect(poolSigner).transfer(base.user.address, amt);
    // selling (to == pool) of a large amount during the window must NOT revert
    await tk.connect(base.user).transfer(pool, amt);
    expect(await tk.balanceOf(base.user.address)).to.equal(0n);
  });
});

describe("MilestoneVault", () => {
  it("sells a tranche when TWAP crosses 2x, splits 50/50, then buy-and-burns", async () => {
    const base = await deployBase();
    const { token, pool, vault } = await doLaunch(base);
    const tk = await ethers.getContractAt("LaunchToken", token);
    const vlt = await ethers.getContractAt("MilestoneVault", vault);
    const p = await wirePool(base, pool);
    const launchPrice = await vlt.launchPriceWethPerToken();

    const tokenIsToken0 = BigInt(token) < BigInt(await base.WETH.getAddress());
    const MT = tokenIsToken0 ? 7000 : -7000; // past the 2x threshold (6932) in the right direction
    // spot tick must track the TWAP mean (H-1 defense); set both
    await p.setObserveMeanTick(MT);
    await p.setTick(MT);
    await p.setPrice(launchPrice * 2n);

    const devBefore = await base.WETH.balanceOf(base.dev.address);
    await vlt.poke();
    expect(await vlt.nextMilestone()).to.equal(1n);
    const reserve = await vlt.buybackReserve();
    const devAfter = await base.WETH.balanceOf(base.dev.address);
    expect(devAfter - devBefore).to.be.greaterThan(0n);
    // 50/50 split (allow 1 wei rounding toward reserve)
    expect(reserve).to.be.greaterThanOrEqual(devAfter - devBefore);

    // cooldown: immediate second poke (even if eligible for next) reverts
    const MT2 = tokenIsToken0 ? 12000 : -12000; // past 3x (10987)
    await p.setObserveMeanTick(MT2);
    await p.setTick(MT2);
    await expect(vlt.poke()).to.be.revertedWithCustomError(vlt, "CooldownActive");

    // dev buy-and-burn from reserve -> tokens go to 0xdead (past the anti-snipe window, as in reality)
    await network.provider.send("evm_increaseTime", [400]);
    await network.provider.send("evm_mine");
    const burnBefore = await tk.balanceOf("0x000000000000000000000000000000000000dEaD");
    const spend = reserve / 5n; // <=25%
    await vlt.connect(base.dev).buyback(spend, 0);
    const burnAfter = await tk.balanceOf("0x000000000000000000000000000000000000dEaD");
    expect(burnAfter - burnBefore).to.be.greaterThan(0n);
    expect(await vlt.buybackReserve()).to.be.lessThan(reserve);
  });

  it("reverts poke when TWAP threshold not met (fail-closed)", async () => {
    const base = await deployBase();
    const { pool, vault } = await doLaunch(base);
    const vlt = await ethers.getContractAt("MilestoneVault", vault);
    const p = await wirePool(base, pool);
    await p.setObserveMeanTick(100); // nowhere near 2x
    await expect(vlt.poke()).to.be.revertedWithCustomError(vlt, "NotEligible");
  });

  it("rejects slippage when the swap executes below the spot-anchored floor", async () => {
    const base = await deployBase();
    const { token, pool, vault } = await doLaunch(base);
    const vlt = await ethers.getContractAt("MilestoneVault", vault);
    const p = await wirePool(base, pool);
    const launchPrice = await vlt.launchPriceWethPerToken();
    const tokenIsToken0 = BigInt(token) < BigInt(await base.WETH.getAddress());
    const MT = tokenIsToken0 ? 7000 : -7000;
    await p.setObserveMeanTick(MT);
    await p.setTick(MT); // spot tracks TWAP (deviation ok)
    await p.setPrice(launchPrice / 2n); // but the swap fills at half the anchored price -> minOut fails
    await expect(vlt.poke()).to.be.revertedWithCustomError(vlt, "Slippage");
  });

  it("blocks a milestone sell when spot deviates from the TWAP (H-1 defense)", async () => {
    const base = await deployBase();
    const { token, pool, vault } = await doLaunch(base);
    const vlt = await ethers.getContractAt("MilestoneVault", vault);
    const p = await wirePool(base, pool);
    const launchPrice = await vlt.launchPriceWethPerToken();
    const tokenIsToken0 = BigInt(token) < BigInt(await base.WETH.getAddress());
    await p.setObserveMeanTick(tokenIsToken0 ? 7000 : -7000); // TWAP says 2x reached
    await p.setTick(0); // but spot cratered thousands of ticks away (attacker manipulation)
    await p.setPrice(launchPrice * 2n);
    await expect(vlt.poke()).to.be.revertedWithCustomError(vlt, "NotEligible");
  });

  it("has no withdraw/sweep path (anti-rug)", async () => {
    const base = await deployBase();
    const { vault } = await doLaunch(base);
    const vlt = await ethers.getContractAt("MilestoneVault", vault);
    expect(vlt.interface.fragments.find((f) => f.type === "function" && /withdraw|sweep|rescue/i.test(f.name))).to.be.undefined;
  });

  it("only the dev can call buyback", async () => {
    const base = await deployBase();
    const { pool, vault } = await doLaunch(base);
    const vlt = await ethers.getContractAt("MilestoneVault", vault);
    await wirePool(base, pool);
    await expect(vlt.connect(base.attacker).buyback(1, 0)).to.be.revertedWithCustomError(vlt, "NotDev");
  });
});

describe("FeeRouter", () => {
  async function setupRouter(base, launched) {
    const Router = await (
      await ethers.getContractFactory("FeeRouter")
    ).deploy(
      await base.WETH.getAddress(),
      await base.V3.getAddress(),
      base.feeRecipient.address,
      base.deployer.address
    );
    const p = await wirePool(base, launched.pool);
    const vlt = await ethers.getContractAt("MilestoneVault", launched.vault);
    await p.setPrice(await vlt.launchPriceWethPerToken());
    return { Router, p };
  }

  it("skims 1% WETH on a buy and delivers tokens", async () => {
    const base = await deployBase();
    const launched = await doLaunch(base);
    const { Router } = await setupRouter(base, launched);
    const tk = await ethers.getContractAt("LaunchToken", launched.token);

    // past the anti-snipe window so a normal-sized buy isn't capped
    await network.provider.send("evm_increaseTime", [400]);
    await network.provider.send("evm_mine");
    const spend = ethers.parseEther("0.01");
    const before = await tk.balanceOf(base.user.address);
    await Router.connect(base.user).buyExactInETH(launched.token, 0, (await time()) + 300, { value: spend });
    expect(await tk.balanceOf(base.user.address)).to.be.greaterThan(before);
    expect(await Router.feesAccrued()).to.equal((spend * 100n) / 10000n); // 1%
  });

  it("skims 1% WETH on a sell (net check) and withdraws fees to recipient", async () => {
    const base = await deployBase();
    const launched = await doLaunch(base);
    const { Router } = await setupRouter(base, launched);
    const tk = await ethers.getContractAt("LaunchToken", launched.token);

    // move past window, get the user some tokens from the pool
    await network.provider.send("evm_increaseTime", [400]);
    await network.provider.send("evm_mine");
    await network.provider.send("hardhat_impersonateAccount", [launched.pool]);
    await network.provider.send("hardhat_setBalance", [launched.pool, "0x56BC75E2D63100000"]);
    const poolSigner = await ethers.getSigner(launched.pool);
    const amt = 1_000_000n * ONE;
    await tk.connect(poolSigner).transfer(base.user.address, amt);

    await tk.connect(base.user).approve(await Router.getAddress(), amt);
    await Router.connect(base.user).sellExactIn(launched.token, amt, 0, (await time()) + 300, false);
    expect(await Router.feesAccrued()).to.be.greaterThan(0n);

    const recipBefore = await base.WETH.balanceOf(base.feeRecipient.address);
    await Router.withdrawFees();
    expect(await base.WETH.balanceOf(base.feeRecipient.address)).to.be.greaterThan(recipBefore);
    expect(await Router.feesAccrued()).to.equal(0n);
  });

  it("fee is immutable at 1% (no setFee, capped)", async () => {
    const base = await deployBase();
    const launched = await doLaunch(base);
    const { Router } = await setupRouter(base, launched);
    expect(await Router.FEE_BPS()).to.equal(100n);
    expect(await Router.MAX_FEE_BPS()).to.equal(100n);
    expect(Router.interface.fragments.find((f) => f.type === "function" && /setFee\b/i.test(f.name))).to.be.undefined;
  });

  it("rejects a fake-pool swap callback", async () => {
    const base = await deployBase();
    const launched = await doLaunch(base);
    const { Router } = await setupRouter(base, launched);
    const t0 = base.attacker.address;
    const t1 = base.user.address;
    const data = ethers.AbiCoder.defaultAbiCoder().encode(["address", "address"], [t0, t1]);
    await expect(
      Router.connect(base.attacker).uniswapV3SwapCallback(1, -1, data)
    ).to.be.revertedWithCustomError(Router, "NotPool");
  });
});

async function time() {
  const b = await ethers.provider.getBlock("latest");
  return b.timestamp;
}
