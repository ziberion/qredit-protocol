require("@nomicfoundation/hardhat-toolbox");
require("hardhat-gas-reporter");
require("solidity-coverage");
require("dotenv").config();

const SEPOLIA_RPC   = process.env.SEPOLIA_RPC   || "";
const ETHERSCAN_KEY = process.env.ETHERSCAN_KEY || "";

// Only include accounts when a valid key is present.
// Hardhat requires exactly 32 bytes (64 hex chars, no 0x prefix in length count).
function sepoliaAccounts() {
  const key = (process.env.PRIVATE_KEY || "").trim();
  if (!key) return [];
  const hex = key.startsWith("0x") ? key.slice(2) : key;
  if (hex.length !== 64) return [];
  return ["0x" + hex];
}

/** @type import('hardhat/config').HardhatUserConfig */
module.exports = {
  solidity: {
    version: "0.8.25",
    settings: {
      optimizer: {
        enabled: true,
        runs: 200,
      },
      evmVersion: "cancun",
      viaIR: true,
    },
  },

  networks: {
    localhost: {
      url: "http://127.0.0.1:8545",
      chainId: 31337,
    },

    hardhat: {
      chainId: 31337,
      allowUnlimitedContractSize: false,
    },

    sepolia: {
      url: SEPOLIA_RPC,
      accounts: sepoliaAccounts(),
      chainId: 11155111,
      gasPrice: "auto",
      timeout: 120000,
    },
  },

  etherscan: {
    apiKey: ETHERSCAN_KEY,
  },

  gasReporter: {
    enabled: process.env.REPORT_GAS === "true",
    currency: "USD",
    gasPrice: 20,
    outputFile: "gas-report.txt",
    noColors: true,
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