/* eslint-disable no-console */
// Deploys the current Pad stack (CurvePad + PadRouter + Bond) to Robinhood Chain, or estimates on a fork.
//   Fork estimate (free):  npx hardhat run scripts/deploy.js                       (FORK_RPC in .env)
//   Real deploy:           npx hardhat run scripts/deploy.js --network robinhood    (PRIVATE_KEY in .env)
const { ethers, network } = require("hardhat");

// Confirmed Robinhood Chain infra (same addresses the fork tests run against):
const WETH = process.env.WETH || "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73";
const V3_FACTORY = process.env.V3_FACTORY || "0x1f7d7550b1b028f7571e69a784071f0205fd2efa";
const ETH_USD = Number(process.env.ETH_USD || 1920);
// Curve geometry ("let it ride"). MIN_GRAD_WIDTH = start -> the MINIMUM graduation price (~$30k, ~4 ETH
// raise). CURVE_WIDTH = start -> the CEILING (how far price can ride above $30k for a thicker floor). Graduation
// is eligible anywhere in between; the later it's clicked, the bigger the raise/floor. Values below are
// calibrated on the fork. For a cheap TEST factory set small widths. All multiples of 200; MIN_GRAD_WIDTH < CURVE_WIDTH.
// Calibrated on the fork: MIN grad ~$30k mcap / ~4 ETH raise; CEILING ~$76k mcap / ~8.3 ETH raise. So the
// floor is ~3 ETH if graduated at the $30k minimum and up to ~6 ETH if left to ride to the ceiling.
const START_TICK_MAG = Number(process.env.START_TICK_MAG || 196200);
const CURVE_WIDTH = Number(process.env.CURVE_WIDTH || 25800);
const MIN_GRAD_WIDTH = Number(process.env.MIN_GRAD_WIDTH || 16400);

async function main() {
  const [deployer] = await ethers.getSigners();
  const owner = process.env.OWNER || deployer.address; // admin + platform fee sink (use a multisig for prod)
  const platform = process.env.PLATFORM || owner; // Sherwood LP fees + graduation sweep

  console.log(`network=${network.name}  deployer=${deployer.address}`);
  console.log(`owner=${owner}\nplatform=${platform}\n`);

  let totalGas = 0n;
  const track = async (name, contract) => {
    const rc = await contract.deploymentTransaction().wait();
    totalGas += rc.gasUsed;
    console.log(`  ${name.padEnd(20)} ${await contract.getAddress()}  (gas ${rc.gasUsed})`);
    return contract;
  };

  console.log("deploying:");
  // stateless deployers can be REUSED across factories (pass their addresses to save gas)
  const reuse = async (name, addr, factoryName) => {
    if (addr) { console.log(`  ${name.padEnd(20)} ${addr}  (reused)`); return await ethers.getContractAt(factoryName, addr); }
    return await track(name, await (await ethers.getContractFactory(factoryName)).deploy());
  };
  const ltd = await reuse("LaunchTokenDeployer", process.env.LTD, "LaunchTokenDeployer");
  const cpd = await reuse("CurvePoolDeployer", process.env.CPD, "CurvePoolDeployer");
  const bd = await reuse("BondDeployer", process.env.BD, "BondDeployer");
  const router = await track("PadRouter", await (await ethers.getContractFactory("PadRouter")).deploy(WETH, owner));
  const factory = await track("CurvePadFactory", await (await ethers.getContractFactory("CurvePadFactory")).deploy(
    WETH, V3_FACTORY, platform, owner, await router.getAddress(),
    await ltd.getAddress(), await cpd.getAddress(), await bd.getAddress(),
    START_TICK_MAG, CURVE_WIDTH, MIN_GRAD_WIDTH
  ));
  console.log(`  (curve: startTickMag=${START_TICK_MAG} ceilWidth=${CURVE_WIDTH} minGradWidth=${MIN_GRAD_WIDTH})`);
  const wire = await (await router.setFactory(await factory.getAddress())).wait();
  totalGas += wire.gasUsed;
  console.log(`  router.setFactory       (gas ${wire.gasUsed})\n`);

  const gp = (await ethers.provider.getFeeData()).gasPrice ?? 0n;
  const cost = totalGas * gp;
  const costEth = Number(ethers.formatEther(cost));
  console.log(`TOTAL deploy gas: ${totalGas}`);
  console.log(`gas price:        ${ethers.formatUnits(gp, "gwei")} gwei`);
  console.log(`est. cost:        ${costEth.toFixed(6)} ETH  (~$${(costEth * ETH_USD).toFixed(2)} @ $${ETH_USD}/ETH)`);
  console.log(`\n=== paste into pad/assets/config.js CONTRACTS ===`);
  console.log(`  padRouter:  "${await router.getAddress()}",`);
  console.log(`  padFactory: "${await factory.getAddress()}",`);
}

main().catch((e) => { console.error(e); process.exit(1); });
