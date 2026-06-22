require("@nomicfoundation/hardhat-toolbox");
require("hardhat-gas-reporter");
require("solidity-coverage");
require("dotenv").config();

const PRIVATE_KEY   = process.env.PRIVATE_KEY   || "0x" + "0".repeat(64);
const SEPOLIA_RPC   = process.env.SEPOLIA_RPC    || "";
const ETHERSCAN_KEY = process.env.ETHERSCAN_KEY  || "";

/** @type import('hardhat/config').HardhatUserConfig */
module.exports = {
  solidity: {
    version: "0.8.20",
    settings: {
      optimizer: {
        enabled: true,
        runs: 200,
      },
      viaIR: false,
    },
  },

  networks: {
    // ── Local node (hardhat node) ──────────────────────────────
    localhost: {
      url: "http://127.0.0.1:8545",
      chainId: 31337,
    },

    // ── Hardhat in-process network (default for tests) ─────────
    hardhat: {
      chainId: 31337,
      allowUnlimitedContractSize: false,
      gas: "auto",
    },

    // ── Ethereum Sepolia testnet ───────────────────────────────
    sepolia: {
      url: SEPOLIA_RPC,
      accounts: PRIVATE_KEY !== "0x" + "0".repeat(64) ? [PRIVATE_KEY] : [],
      chainId: 11155111,
      gasPrice: "auto",
      timeout: 120000,
    },
  },

  etherscan: {
    apiKey: {
      sepolia: ETHERSCAN_KEY,
    },
  },

  gasReporter: {
    enabled: process.env.REPORT_GAS === "true",
    currency: "USD",
    gasPrice: 20,
    coinmarketcap: process.env.CMC_API_KEY || "",
    outputFile: "gas-report.txt",
    noColors: true,
  },

  coverage: {
    exclude: ["contracts/mocks/"],
  },

  paths: {
    sources:   "./contracts",
    tests:     "./test",
    cache:     "./cache",
    artifacts: "./artifacts",
  },

  mocha: {
    timeout: 120000,
  },
};
