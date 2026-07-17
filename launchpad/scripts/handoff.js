/* eslint-disable no-console */
// Hand the LIVE production contracts to the platform wallet (Ownable2Step: this sets the pending owner; the
// platform must call acceptOwnership() to complete). Run:  npx hardhat run scripts/handoff.js --network robinhood
const { ethers } = require("hardhat");
const PLATFORM = "0xcd04919a51bc0866bba48c300465425d8ff83160";
const ROUTER = "0x1988dEFfE3799Fb56F949ffb20C65D20c1547570";
const FACTORY = "0xc208e393990B6f2BC8D0d330E0be38C6eCA1e25B";
const OWN = [
  "function transferOwnership(address) external",
  "function owner() view returns (address)",
  "function pendingOwner() view returns (address)",
];

async function main() {
  const [me] = await ethers.getSigners();
  console.log("deployer:", me.address, "bal:", ethers.formatEther(await ethers.provider.getBalance(me.address)), "ETH");
  const router = await ethers.getContractAt(OWN, ROUTER);
  const factory = await ethers.getContractAt(OWN, FACTORY);

  await (await router.transferOwnership(PLATFORM)).wait();
  await (await factory.transferOwnership(PLATFORM)).wait();

  console.log("router  owner:", await router.owner(), " pendingOwner:", await router.pendingOwner());
  console.log("factory owner:", await factory.owner(), " pendingOwner:", await factory.pendingOwner());
  console.log(`\n✅ ownership transfer initiated. The platform wallet ${PLATFORM} must now call acceptOwnership()`);
  console.log("   on BOTH the router and the factory to complete the handoff.");
}
main().catch((e) => { console.error(e.shortMessage || e.message); process.exit(1); });
