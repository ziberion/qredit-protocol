// ============================================================
//  Qredit Protocol — Deploy Script
//  Deploys: QRDTBasketOracle → Qredit → QRDTGovernance → QRDTKeeper
//
//  Usage:
//    Local:   npx hardhat run scripts/deploy.js --network localhost
//    Sepolia: npx hardhat run scripts/deploy.js --network sepolia
// ============================================================

const { ethers } = require("hardhat");
const fs = require("fs");

// ── Chainlink feed addresses ───────────────────────────────────────
// Sepolia testnet mock feeds (replace with real addresses if available)
// Real Sepolia feeds: https://docs.chain.link/data-feeds/price-feeds/addresses?network=ethereum&page=1#sepolia-testnet
const FEEDS = {
  sepolia: {
    USD: "0xA2F78ab2355fe2f984D808B5CeE7FD0A93D5270B", // USDC/USD Sepolia
    EUR: "0x1a81afB8146aeFfCFc5E50e8479e826E7D55b910", // EUR/USD Sepolia
    JPY: "0x8A6af2B75F23831ADc973ce6288e5329F63D86c6", // JPY/USD Sepolia (mock if unavailable)
    GBP: "0x91FAB41F5f3bE955963a986366edAcff1aaeaa83", // GBP/USD Sepolia
    XAU: "0xC5981F461d74c46eB4b0CF3f4Ec79f025573B0Ea", // XAU/USD Sepolia
  },
  localhost: {
    // Deployed mock addresses — populated during local deploy
    USD: null, EUR: null, JPY: null, GBP: null, XAU: null,
  },
};

// ── Initial mock prices (8 decimals) ──────────────────────────────
const MOCK_PRICES = {
  USD: 100_000_000n,       // $1.00
  EUR: 108_000_000n,       // $1.08
  JPY:      670_000n,      // $0.0067
  GBP: 126_000_000n,       // $1.26
  XAU: 230_000_000_000n,   // $2300.00
};

async function main() {
  const [deployer] = await ethers.getSigners();
  const network    = await ethers.provider.getNetwork();
  const netName    = network.name === "unknown" ? "localhost" : network.name;

  console.log("\n══════════════════════════════════════════");
  console.log("  Qredit Protocol — Deployment");
  console.log("══════════════════════════════════════════");
  console.log(`  Network:  ${netName} (chainId: ${network.chainId})`);
  console.log(`  Deployer: ${deployer.address}`);
  console.log(`  Balance:  ${ethers.formatEther(await ethers.provider.getBalance(deployer.address))} ETH`);
  console.log("══════════════════════════════════════════\n");

  let feeds = FEEDS[netName] || FEEDS.localhost;

  // ── Step 1: Deploy mock aggregators on local/testnet ────────────
  if (netName === "localhost" || !feeds.USD) {
    console.log("📡 Deploying mock Chainlink aggregators...");
    const MockAgg = await ethers.getContractFactory("MockAggregatorV3");

    const mockUSD = await MockAgg.deploy(MOCK_PRICES.USD);
    const mockEUR = await MockAgg.deploy(MOCK_PRICES.EUR);
    const mockJPY = await MockAgg.deploy(MOCK_PRICES.JPY);
    const mockGBP = await MockAgg.deploy(MOCK_PRICES.GBP);
    const mockXAU = await MockAgg.deploy(MOCK_PRICES.XAU);

    await Promise.all([
      mockUSD.waitForDeployment(),
      mockEUR.waitForDeployment(),
      mockJPY.waitForDeployment(),
      mockGBP.waitForDeployment(),
      mockXAU.waitForDeployment(),
    ]);

    feeds = {
      USD: await mockUSD.getAddress(),
      EUR: await mockEUR.getAddress(),
      JPY: await mockJPY.getAddress(),
      GBP: await mockGBP.getAddress(),
      XAU: await mockXAU.getAddress(),
    };

    console.log("  ✓ MockAggregator USD:", feeds.USD);
    console.log("  ✓ MockAggregator EUR:", feeds.EUR);
    console.log("  ✓ MockAggregator JPY:", feeds.JPY);
    console.log("  ✓ MockAggregator GBP:", feeds.GBP);
    console.log("  ✓ MockAggregator XAU:", feeds.XAU);
  }

  // ── Step 2: Deploy QRDTBasketOracle ─────────────────────────────
  console.log("\n📦 Deploying QRDTBasketOracle...");
  const Oracle = await ethers.getContractFactory("QRDTBasketOracle");
  const oracle = await Oracle.deploy(
    deployer.address,
    feeds.USD, feeds.EUR, feeds.JPY, feeds.GBP, feeds.XAU
  );
  await oracle.waitForDeployment();
  const oracleAddr = await oracle.getAddress();
  console.log("  ✓ QRDTBasketOracle:", oracleAddr);

  // ── Step 3: Deploy Qredit token ─────────────────────────────────
  console.log("\n📦 Deploying Qredit (QRDT)...");
  const Token = await ethers.getContractFactory("Qredit");
  const token = await Token.deploy(deployer.address, oracleAddr);
  await token.waitForDeployment();
  const tokenAddr = await token.getAddress();
  console.log("  ✓ Qredit (QRDT):", tokenAddr);

  // ── Step 4: Deploy QRDTGovernance ───────────────────────────────
  console.log("\n📦 Deploying QRDTGovernance...");
  const Gov = await ethers.getContractFactory("QRDTGovernance");
  const gov = await Gov.deploy(deployer.address, tokenAddr, oracleAddr);
  await gov.waitForDeployment();
  const govAddr = await gov.getAddress();
  console.log("  ✓ QRDTGovernance:", govAddr);

  // ── Step 5: Deploy QRDTKeeper ───────────────────────────────────
  console.log("\n📦 Deploying QRDTKeeper...");
  const Keeper = await ethers.getContractFactory("QRDTKeeper");
  const keeper = await Keeper.deploy(
    deployer.address,
    oracleAddr,
    900  // 15-minute update interval
  );
  await keeper.waitForDeployment();
  const keeperAddr = await keeper.getAddress();
  console.log("  ✓ QRDTKeeper:", keeperAddr);

  // ── Step 6: Grant roles ─────────────────────────────────────────
  console.log("\n🔑 Configuring roles...");

  const UPDATER_ROLE     = ethers.keccak256(ethers.toUtf8Bytes("UPDATER_ROLE"));
  const GUARDIAN_ROLE    = ethers.keccak256(ethers.toUtf8Bytes("GUARDIAN_ROLE"));
  const MINTER_ROLE      = ethers.keccak256(ethers.toUtf8Bytes("MINTER_ROLE"));
  const STABILIZER_ROLE  = ethers.keccak256(ethers.toUtf8Bytes("STABILIZER_ROLE"));
  const RESERVE_ROLE     = ethers.keccak256(ethers.toUtf8Bytes("RESERVE_ROLE"));

  // Keeper gets UPDATER_ROLE on oracle (so it can call updatePrice)
  await (await oracle.grantRole(UPDATER_ROLE, keeperAddr)).wait();
  console.log("  ✓ Keeper → UPDATER_ROLE on Oracle");

  // Governance gets GUARDIAN_ROLE on oracle
  await (await oracle.grantRole(GUARDIAN_ROLE, govAddr)).wait();
  console.log("  ✓ Governance → GUARDIAN_ROLE on Oracle");

  // Governance gets STABILIZER_ROLE on token
  await (await token.grantRole(STABILIZER_ROLE, govAddr)).wait();
  console.log("  ✓ Governance → STABILIZER_ROLE on Token");

  // ── Step 7: Initial oracle price update ─────────────────────────
  console.log("\n🔄 Performing initial price update...");
  await (await oracle.updatePrice()).wait();
  const [price, valid] = await oracle.getPrice();
  console.log(`  ✓ Initial basket price: $${(Number(price) / 1e8).toFixed(6)} (valid: ${valid})`);

  // ── Step 8: Save deployment addresses ───────────────────────────
  const deployment = {
    network:   netName,
    chainId:   network.chainId.toString(),
    timestamp: new Date().toISOString(),
    deployer:  deployer.address,
    contracts: {
      oracle:      oracleAddr,
      token:       tokenAddr,
      governance:  govAddr,
      keeper:      keeperAddr,
    },
    feeds: {
      USD: feeds.USD,
      EUR: feeds.EUR,
      JPY: feeds.JPY,
      GBP: feeds.GBP,
      XAU: feeds.XAU,
    },
  };

  const outDir = "./deployments";
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir);
  const outFile = `${outDir}/${netName}-${Date.now()}.json`;
  fs.writeFileSync(outFile, JSON.stringify(deployment, null, 2));

  console.log("\n══════════════════════════════════════════");
  console.log("  Deployment Complete");
  console.log("══════════════════════════════════════════");
  console.log(`  Oracle:     ${oracleAddr}`);
  console.log(`  Token:      ${tokenAddr}`);
  console.log(`  Governance: ${govAddr}`);
  console.log(`  Keeper:     ${keeperAddr}`);
  console.log(`\n  Saved to: ${outFile}`);

  if (netName === "sepolia") {
    console.log("\n  Next steps:");
    console.log("  1. npx hardhat run scripts/verify.js --network sepolia");
    console.log("  2. Register QRDTKeeper at https://automation.chain.link");
    console.log("  3. Fund keeper with LINK tokens");
  }

  console.log("══════════════════════════════════════════\n");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
