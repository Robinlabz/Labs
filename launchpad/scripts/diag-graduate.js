/* eslint-disable no-console */
// Reproduces the test-curve graduation on a fork (fresh deploy, post-fork blocks avoid the hardfork issue).
//   npx hardhat run scripts/diag-graduate.js
const { ethers } = require("hardhat");
const WETH = "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73";
const V3 = "0x1f7d7550b1b028f7571e69a784071f0205fd2efa";
const ONE = 10n ** 18n;

async function main() {
  const [dep, platform, dev, buyer] = await ethers.getSigners();
  const ltd = await (await ethers.getContractFactory("LaunchTokenDeployer")).deploy();
  const cpd = await (await ethers.getContractFactory("CurvePoolDeployer")).deploy();
  const bd = await (await ethers.getContractFactory("BondDeployer")).deploy();
  const router = await (await ethers.getContractFactory("PadRouter")).deploy(WETH, dep.address);
  const factory = await (await ethers.getContractFactory("CurvePadFactory")).deploy(
    WETH, V3, platform.address, dep.address, await router.getAddress(),
    await ltd.getAddress(), await cpd.getAddress(), await bd.getAddress(), 252400, 4000
  );
  await (await router.setFactory(await factory.getAddress())).wait();
  const NOTAX = { buyBps: 100, sellBps: 100, walletBps: 10000, floorBps: 0, burnBps: 0, projectWallet: dev.address };
  const rc = await (await factory.launch({ name: "T", symbol: "T", dev: dev.address, tax: NOTAX })).wait();
  const ev = rc.logs.map((l) => { try { return factory.interface.parseLog(l); } catch { return null; } }).find((e) => e && e.name === "Launched");
  const { token, curve, pool: poolAddr } = ev.args;
  const curveC = await ethers.getContractAt("CurvePool", curve);
  const pool = await ethers.getContractAt("IUniswapV3Pool", poolAddr);

  console.log("tokenIsToken0:", token.toLowerCase() < WETH.toLowerCase(), " gradTick:", (await curveC.gradTick()).toString());

  await ethers.provider.send("evm_increaseTime", [400]);
  await ethers.provider.send("evm_mine", []);
  const probe = await (await ethers.getContractFactory("SwapProbe")).deploy();
  const wethW = await ethers.getContractAt(["function deposit() payable", "function approve(address,uint256) returns (bool)"], WETH);
  await (await wethW.connect(buyer).deposit({ value: 5n * ONE })).wait();
  await (await wethW.connect(buyer).approve(await probe.getAddress(), 5n * ONE)).wait();
  await (await probe.connect(buyer).swapExactInLimit(poolAddr, WETH, 5n * ONE, await curveC.gradSqrtPriceX96())).wait();

  const slot0 = await pool.slot0();
  console.log("ready:", await curveC.ready(), " pool tick at grad:", slot0.tick.toString());

  try {
    await curveC.graduate.staticCall();
    console.log("graduate staticCall OK");
    await (await curveC.graduate()).wait();
    console.log("GRADUATED — bond:", await curveC.bond());
  } catch (e) {
    console.log("\nREVERT:", e.shortMessage || e.message);
    for (const k of ["reason", "code"]) if (e[k]) console.log(" ", k, e[k]);
    if (e.stack) console.log(e.stack.split("\n").slice(0, 4).join("\n"));
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
