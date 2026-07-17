/* eslint-disable no-console */
// Calibrates the "let it ride" curve on a fork (free). Measures, for candidate (startMag, ceilWidth,
// minGradWidth): the raise + mcap at the MINIMUM graduation point, and the raise + mcap if ridden to the
// CEILING (the max floor / max mcap). FORK_RPC in .env.  npx hardhat run scripts/calibrate.js
const { ethers } = require("hardhat");
const WETH = "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73";
const V3 = "0x1f7d7550b1b028f7571e69a784071f0205fd2efa";
const ONE = 10n ** 18n;
const ETH_USD = 1920;

// target: ~$30k min-grad mcap with a ~4 ETH raise there, and a meaningfully higher ceiling to "ride" into.
const CANDIDATES = [
  { startMag: 196200, ceilWidth: 25800, minGradWidth: 16400 },
  { startMag: 199800, ceilWidth: 25800, minGradWidth: 16400 },
  { startMag: 196200, ceilWidth: 29800, minGradWidth: 16400 },
];

function fdvEth(sqrtP, tokenIsToken0) {
  const s = Number(sqrtP) / 2 ** 96;
  const p01 = s * s;
  const wethPerToken = tokenIsToken0 ? p01 : 1 / p01;
  return wethPerToken * 1e9; // 1e9 whole tokens
}

async function measure(startMag, ceilWidth, minGradWidth) {
  const [dep, platform, dev, buyer] = await ethers.getSigners();
  const ltd = await (await ethers.getContractFactory("LaunchTokenDeployer")).deploy();
  const cpd = await (await ethers.getContractFactory("CurvePoolDeployer")).deploy();
  const bd = await (await ethers.getContractFactory("BondDeployer")).deploy();
  const router = await (await ethers.getContractFactory("PadRouter")).deploy(WETH, dep.address);
  const factory = await (await ethers.getContractFactory("CurvePadFactory")).deploy(
    WETH, V3, platform.address, dep.address, await router.getAddress(),
    await ltd.getAddress(), await cpd.getAddress(), await bd.getAddress(), startMag, ceilWidth, minGradWidth
  );
  await (await router.setFactory(await factory.getAddress())).wait();
  const NOTAX = { buyBps: 100, sellBps: 100, walletBps: 10000, floorBps: 0, burnBps: 0, projectWallet: dev.address };
  const rc = await (await factory.launch({ name: "T", symbol: "T", dev: dev.address, tax: NOTAX })).wait();
  const ev = rc.logs.map((l) => { try { return factory.interface.parseLog(l); } catch { return null; } }).find((e) => e && e.name === "Launched");
  const { token, curve, pool: poolAddr } = ev.args;
  const curveC = await ethers.getContractAt("CurvePool", curve);
  const pool = await ethers.getContractAt("IUniswapV3Pool", poolAddr);
  const tokenIsToken0 = BigInt(token) < BigInt(WETH);

  await ethers.provider.send("evm_increaseTime", [400]);
  await ethers.provider.send("evm_mine", []);
  const probe = await (await ethers.getContractFactory("SwapProbe")).deploy();
  const wethW = await ethers.getContractAt(["function deposit() payable", "function approve(address,uint256) returns (bool)", "function balanceOf(address) view returns (uint256)"], WETH);
  await (await wethW.connect(buyer).deposit({ value: 60n * ONE })).wait();
  await (await wethW.connect(buyer).approve(await probe.getAddress(), 60n * ONE)).wait();

  // (1) buy up to the MINIMUM graduation price
  const b0 = await wethW.balanceOf(buyer.address);
  await (await probe.connect(buyer).swapExactInLimit(poolAddr, WETH, 60n * ONE, await curveC.minGradSqrtPriceX96())).wait();
  const raiseMin = Number(ethers.formatEther(b0 - (await wethW.balanceOf(buyer.address))));
  const mcapMin = fdvEth((await pool.slot0()).sqrtPriceX96, tokenIsToken0);
  const readyAtMin = await curveC.ready();

  // (2) ride the rest of the way to the CEILING
  const b1 = await wethW.balanceOf(buyer.address);
  await (await probe.connect(buyer).swapExactInLimit(poolAddr, WETH, 60n * ONE, await curveC.gradSqrtPriceX96())).wait();
  const raiseCeil = raiseMin + Number(ethers.formatEther(b1 - (await wethW.balanceOf(buyer.address))));
  const mcapCeil = fdvEth((await pool.slot0()).sqrtPriceX96, tokenIsToken0);

  return { raiseMin, mcapMin, readyAtMin, raiseCeil, mcapCeil };
}

async function main() {
  for (const c of CANDIDATES) {
    const r = await measure(c.startMag, c.ceilWidth, c.minGradWidth);
    console.log(
      `startMag=${c.startMag} ceilW=${c.ceilWidth} minGradW=${c.minGradWidth}\n` +
      `   MIN grad: raise ≈ ${r.raiseMin.toFixed(2)} ETH ($${(r.raiseMin*ETH_USD).toFixed(0)}), mcap ≈ $${(r.mcapMin*ETH_USD/1000).toFixed(1)}k, ready=${r.readyAtMin}\n` +
      `   CEILING : raise ≈ ${r.raiseCeil.toFixed(2)} ETH ($${(r.raiseCeil*ETH_USD).toFixed(0)}), mcap ≈ $${(r.mcapCeil*ETH_USD/1000).toFixed(1)}k`
    );
  }
}
main().catch((e) => { console.error(e.shortMessage || e.message); process.exit(1); });
