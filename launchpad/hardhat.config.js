require("@nomicfoundation/hardhat-toolbox");
require("dotenv").config(); // loads FORK_RPC / ROBINHOOD_RPC / PRIVATE_KEY from .env (gitignored)

/** @type import('hardhat/config').HardhatUserConfig */
module.exports = {
  solidity: {
    version: "0.8.24",
    settings: {
      optimizer: { enabled: true, runs: 1 },
      viaIR: true,
    },
  },
  networks: {
    // When FORK_RPC is set, the in-process hardhat network forks Robinhood Chain so tests
    // run against the REAL Uniswap v3 factory + WETH (not the mock). Never commit the key —
    // pass it via env: `FORK_RPC=<alchemy url> npx hardhat test test/fork/*.js`.
    hardhat: process.env.FORK_RPC
      ? { forking: { url: process.env.FORK_RPC }, chainId: 4663 }
      : {},
    // Robinhood Chain (fill RPC + PRIVATE_KEY via env before deploying)
    robinhood: {
      url: process.env.ROBINHOOD_RPC || "https://robinhoodchain.blockscout.com/api/eth-rpc",
      chainId: 4663,
      accounts: process.env.PRIVATE_KEY ? [process.env.PRIVATE_KEY] : [],
    },
  },
};
