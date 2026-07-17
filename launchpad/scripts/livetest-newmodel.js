/* eslint-disable no-console */
// LIVE test of the new model on Robinhood Chain mainnet, cheaply: deploy a TEST factory (tiny curve),
// launch a coin, wait out the anti-snipe window, buy up to the MINIMUM graduation price (so there are unsold
// curve tokens to roll), graduate, and verify the Bond posts + the dev gets its 25% reward.
//   npx hardhat run scripts/livetest-newmodel.js --network robinhood
const { ethers } = require("hardhat");
const WETH = "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73";
const V3 = "0x1f7d7550b1b028f7571e69a784071f0205fd2efa";
const ONE = 10n ** 18n;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const [me] = await ethers.getSigners();
  console.log("deployer:", me.address, "bal:", ethers.formatEther(await ethers.provider.getBalance(me.address)), "ETH");

  // ---- deploy the TEST stack (new code, tiny curve: graduates for a few $) ----
  const g = (n) => ({ gasLimit: n });
  const ltd = await (await ethers.getContractFactory("LaunchTokenDeployer")).deploy();  await ltd.waitForDeployment();
  const cpd = await (await ethers.getContractFactory("CurvePoolDeployer")).deploy();    await cpd.waitForDeployment();
  const bd  = await (await ethers.getContractFactory("BondDeployer")).deploy();         await bd.waitForDeployment();
  const router = await (await ethers.getContractFactory("PadRouter")).deploy(WETH, me.address); await router.waitForDeployment();
  // tiny curve: start 207200, ceiling width 4000, min-grad width 2000
  const factory = await (await ethers.getContractFactory("CurvePadFactory")).deploy(
    WETH, V3, me.address, me.address, await router.getAddress(),
    await ltd.getAddress(), await cpd.getAddress(), await bd.getAddress(), 259400, 4000, 2000
  );
  await factory.waitForDeployment();
  await (await router.setFactory(await factory.getAddress())).wait();
  console.log("factory:", await factory.getAddress(), " router:", await router.getAddress());

  // ---- launch a coin ----
  const tax = { buyBps: 100, sellBps: 100, walletBps: 10000, floorBps: 0, burnBps: 0, projectWallet: me.address };
  const rc = await (await factory.launch({ name: "Robin Test", symbol: "RBNT", dev: me.address, tax }, g(15_000_000))).wait();
  const ev = rc.logs.map((l) => { try { return factory.interface.parseLog(l); } catch { return null; } }).find((e) => e && e.name === "Launched");
  const { token, curve, pool: poolAddr } = ev.args;
  const curveC = await ethers.getContractAt("CurvePool", curve);
  const TOK = await ethers.getContractAt("LaunchToken", token);
  console.log("launched token:", token, " curve:", curve, " pool:", poolAddr);
  console.log("DexScreener: https://dexscreener.com/robinhood/" + poolAddr.toLowerCase());
  await (await curveC.setGradTarget(await curveC.minGradTick())).wait();
  console.log("dev set gradTarget to the minimum (testing the min-graduation / roll-unsold path)");

  // ---- wait out the anti-snipe window ----
  process.stdout.write("waiting for anti-snipe window to close");
  while (await TOK.antiSnipeActive()) { process.stdout.write("."); await sleep(20000); }
  console.log(" clear.");

  // ---- buy up to the MINIMUM graduation price (leaves unsold curve tokens to roll into the Bond) ----
  const probe = await (await ethers.getContractFactory("SwapProbe")).deploy(); await probe.waitForDeployment();
  const wethW = await ethers.getContractAt(
    ["function deposit() payable", "function approve(address,uint256) returns (bool)", "function balanceOf(address) view returns (uint256)"], WETH);
  await (await wethW.deposit({ value: 6n * ONE / 1000n })).wait(); // 0.006 ETH is plenty for the tiny curve
  await (await wethW.approve(await probe.getAddress(), 6n * ONE / 1000n)).wait();
  await (await probe.swapExactInLimit(poolAddr, WETH, 6n * ONE / 1000n, await curveC.minGradSqrtPriceX96(), g(2_000_000))).wait();
  console.log("bought to min-grad. ready:", await curveC.ready());

  // ---- graduate ----
  const devWethBefore = await wethW.balanceOf(me.address);
  await (await curveC.graduate(g(9_000_000))).wait();
  const bond = await ethers.getContractAt("Bond", await curveC.bond());
  const pool = await ethers.getContractAt("IUniswapV3Pool", poolAddr);
  console.log("\n=== RESULTS ===");
  console.log("graduated:", await curveC.graduated(), " bond:", await curveC.bond());
  console.log("Bond posted:", await bond.posted(),
    " sherwoodL:", (await bond.sherwoodL()).toString(),
    " bountyL:", (await bond.bountyL()).toString(),
    " ambushL:", (await bond.ambushL()).toString());
  console.log("dev graduation reward (WETH):", ethers.formatEther((await wethW.balanceOf(me.address)) - devWethBefore));
  console.log("pool liquidity after grad:", (await pool.liquidity()).toString(), " tick:", (await pool.slot0()).tick.toString());
  console.log("\n✅ live Robin Labs new-model test complete.");
}
main().catch((e) => { console.error(e.shortMessage || e.message); process.exit(1); });
