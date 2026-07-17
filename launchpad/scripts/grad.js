/* eslint-disable no-console */
// Minimal: buy out (capped) -> graduate -> verify the Bond + pool. Conserves gas (no extra trades/payouts).
const { ethers } = require("hardhat");
const R = process.env.PAD_ROUTER, T = process.env.TEST_TOKEN, C = process.env.TEST_CURVE;

async function main() {
  const [me] = await ethers.getSigners();
  const router = await ethers.getContractAt("PadRouter", R);
  const curve = await ethers.getContractAt("CurvePool", C);
  const pool = await ethers.getContractAt("IUniswapV3Pool", await curve.pool());
  const TOK = await ethers.getContractAt("LaunchToken", T);
  console.log("bal:", ethers.formatEther(await ethers.provider.getBalance(me.address)), "ETH, antiSnipeActive:", await TOK.antiSnipeActive());

  console.log("buying out (0.0053, capped at gradTick) …");
  await (await router.buy(T, 0, { value: ethers.parseEther("0.0053"), gasLimit: 900000 })).wait();
  console.log("  tick:", (await pool.slot0()).tick.toString(), "gradTick:", (await curve.gradTick()).toString(), "ready:", await curve.ready());

  console.log("graduating …");
  await (await curve.graduate({ gasLimit: 3500000 })).wait();
  const bond = await ethers.getContractAt("Bond", await curve.bond());
  const s0 = await pool.slot0();
  console.log("  graduated:", await curve.graduated(), "bond:", await curve.bond());
  console.log(`  Bond: posted=${await bond.posted()} sherwoodL=${await bond.sherwoodL()} bountyL=${await bond.bountyL()} ambushL=${await bond.ambushL()}`);
  console.log("  pool AFTER graduation -> tick:", s0.tick.toString(), "liquidity:", (await pool.liquidity()).toString(), "(nonzero = real posted liquidity)");
  console.log("\n✅ live graduation complete. DexScreener:", `https://dexscreener.com/robinhood/${await curve.pool()}`);
}
main().catch((e) => { console.error(e.shortMessage || e.message); process.exit(1); });
