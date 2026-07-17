/* eslint-disable no-console */
// LIVE test step 2 (run AFTER the anti-snipe window): buy out the tiny curve -> graduate -> verify the Bond,
// then exercise the payouts. TEST_TOKEN / TEST_CURVE / TEST_POOL + PAD_ROUTER from env.
//   npx hardhat run scripts/livetest-graduate.js --network robinhood
const { ethers } = require("hardhat");
const R = process.env.PAD_ROUTER, T = process.env.TEST_TOKEN, C = process.env.TEST_CURVE;

async function main() {
  const [me] = await ethers.getSigners();
  const router = await ethers.getContractAt("PadRouter", R);
  const curve = await ethers.getContractAt("CurvePool", C);
  const TOK = await ethers.getContractAt("LaunchToken", T);
  console.log("tester:", me.address, "bal:", ethers.formatEther(await ethers.provider.getBalance(me.address)), "ETH");
  console.log("antiSnipeActive:", await TOK.antiSnipeActive(), "(must be false)\n");
  if (await TOK.antiSnipeActive()) { console.log("window still open — wait and re-run"); return; }

  // ── normal trade now that the guard has expired: a clean buy + sell through the router ──
  console.log("buy 0.0006 ETH …");
  const b0 = await TOK.balanceOf(me.address);
  await (await router.buy(T, 0, { value: ethers.parseEther("0.0006") })).wait();
  const got = (await TOK.balanceOf(me.address)) - b0;
  console.log(`  got ${ethers.formatUnits(got, 18)} TEST`);
  console.log(`  escrows -> platform=${ethers.formatEther(await router.platformEscrow())} deferred=${ethers.formatEther(await router.deferredEscrow(T))} platformCut=${ethers.formatEther(await router.platformCutEscrow())} dev=${ethers.formatEther(await router.devEscrow(T))}`);
  const sellAmt = got / 3n;
  await (await TOK.approve(R, sellAmt)).wait();
  const eb = await ethers.provider.getBalance(me.address);
  await (await router.sell(T, sellAmt, 0)).wait();
  console.log(`  sold ${ethers.formatUnits(sellAmt, 18)} TEST, net ETH change incl gas ${ethers.formatEther((await ethers.provider.getBalance(me.address)) - eb)}\n`);

  // buy out the curve via the router (now price-capped at gradTick; excess auto-refunds).
  console.log("buying out the curve (0.008 ETH, capped at gradTick, excess refunds) …");
  await (await router.buy(T, 0, { value: ethers.parseEther("0.008") })).wait();
  console.log("  curve.ready():", await curve.ready());

  // graduate -> posts the Bond into the same pool
  console.log("\ngraduating …");
  await (await curve.graduate()).wait();
  const bondAddr = await curve.bond();
  const bond = await ethers.getContractAt("Bond", bondAddr);
  console.log("  graduated:", await curve.graduated(), " bond:", bondAddr);
  console.log(`  Bond posted=${await bond.posted()} sherwoodL=${await bond.sherwoodL()} bountyL=${await bond.bountyL()} ambushL=${await bond.ambushL()}`);

  // still trades after graduation (buy against the Bond's liquidity)
  const bg = await TOK.balanceOf(me.address);
  await (await router.buy(T, 0, { value: ethers.parseEther("0.0003") })).wait();
  console.log("\n  post-graduation buy worked:", (await TOK.balanceOf(me.address)) > bg);

  // exercise the payouts (all permissionless). platform/robin -> owner(); dev -> projectWallet.
  console.log("\npayouts:");
  console.log("  platformCut escrow:", ethers.formatEther(await router.platformCutEscrow()), "-> withdrawing to owner");
  await (await router.withdrawPlatformCut()).wait();
  await (await router.claimDeferred(T)).wait();
  console.log("  deferred after claim (post-grad):", ethers.formatEther(await router.deferredEscrow(T)));
  await (await router.withdrawPlatform()).wait();
  console.log("  platform escrow after withdraw:", ethers.formatEther(await router.platformEscrow()));
  await (await router.withdrawDev(T)).wait();
  console.log("  dev escrow after withdraw:", ethers.formatEther(await router.devEscrow(T)));
  // deepen the floor with the accrued floor share (no-op here since floorBps=0)
  await (await router.flushFloor(T)).wait();
  console.log("\n✅ full lifecycle verified live: launch -> DEX day one -> buy/sell -> graduate -> Bond -> payouts");
}
main().catch((e) => { console.error(e.shortMessage || e.message); process.exit(1); });
