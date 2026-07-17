/* eslint-disable no-console */
// Finish the live lifecycle on an existing (post-window) coin: buy out -> graduate -> verify Bond -> payouts.
//   PAD_ROUTER=.. TEST_TOKEN=.. TEST_CURVE=.. npx hardhat run scripts/livetest-finish.js --network robinhood
const { ethers } = require("hardhat");
const R = process.env.PAD_ROUTER, T = process.env.TEST_TOKEN, C = process.env.TEST_CURVE;

async function main() {
  const [me] = await ethers.getSigners();
  const router = await ethers.getContractAt("PadRouter", R);
  const curve = await ethers.getContractAt("CurvePool", C);
  const pool = await ethers.getContractAt("IUniswapV3Pool", await curve.pool());
  console.log("bal:", ethers.formatEther(await ethers.provider.getBalance(me.address)), "ETH");

  // buy out (price-capped at gradTick, excess refunds). Explicit gas so estimation can't flake.
  console.log("buying out …");
  await (await router.buy(T, 0, { value: ethers.parseEther("0.008"), gasLimit: 900000 })).wait();
  console.log("  pool tick:", (await pool.slot0()).tick.toString(), " gradTick:", (await curve.gradTick()).toString(), " ready:", await curve.ready());

  console.log("graduating …");
  await (await curve.graduate({ gasLimit: 3000000 })).wait();
  const bond = await ethers.getContractAt("Bond", await curve.bond());
  console.log("  graduated:", await curve.graduated(), " bond:", await curve.bond());
  console.log(`  Bond posted=${await bond.posted()} sherwoodL=${await bond.sherwoodL()} bountyL=${await bond.bountyL()} ambushL=${await bond.ambushL()}`);
  console.log("  pool tick after graduation:", (await pool.slot0()).tick.toString(), " liquidity:", (await pool.liquidity()).toString());

  // still trades post-graduation
  const TOK = await ethers.getContractAt("LaunchToken", T);
  const b0 = await TOK.balanceOf(me.address);
  await (await router.buy(T, 0, { value: ethers.parseEther("0.0003"), gasLimit: 500000 })).wait();
  console.log("  post-graduation buy worked:", (await TOK.balanceOf(me.address)) > b0);

  // payouts
  await (await router.withdrawPlatformCut()).wait();
  await (await router.claimDeferred(T)).wait();
  await (await router.withdrawPlatform()).wait();
  await (await router.withdrawDev(T)).wait();
  console.log("\n✅ graduated live — Bond posted, real liquidity in the pool, payouts run.");
  console.log("   DexScreener:", `https://dexscreener.com/robinhood/${await curve.pool()}`);
}
main().catch((e) => { console.error(e.shortMessage || e.message); process.exit(1); });
