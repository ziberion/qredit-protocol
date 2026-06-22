// ============================================================
//  Qredit Protocol — Etherscan Verification Script
//  Run after deploy.js with the same network flag.
//  Usage: npx hardhat run scripts/verify.js --network sepolia
// ============================================================

const { run } = require("hardhat");
const fs = require("fs");
const path = require("path");

async function main() {
  // Load most recent deployment file
  const dir   = "./deployments";
  const files = fs.readdirSync(dir)
    .filter(f => f.startsWith("sepolia-"))
    .sort()
    .reverse();

  if (files.length === 0) {
    throw new Error("No sepolia deployment found. Run deploy.js first.");
  }

  const deployment = JSON.parse(fs.readFileSync(path.join(dir, files[0]), "utf8"));
  console.log(`\nVerifying deployment from: ${files[0]}`);
  console.log(`Deployer: ${deployment.deployer}\n`);

  const { contracts, feeds } = deployment;

  // ── Verify QRDTBasketOracle ──────────────────────────────────
  console.log("Verifying QRDTBasketOracle...");
  await verify(contracts.oracle, [
    deployment.deployer,
    feeds.USD, feeds.EUR, feeds.JPY, feeds.GBP, feeds.XAU,
  ]);

  // ── Verify Qredit token ──────────────────────────────────────
  console.log("Verifying Qredit (QRDT)...");
  await verify(contracts.token, [deployment.deployer, contracts.oracle]);

  // ── Verify QRDTGovernance ────────────────────────────────────
  console.log("Verifying QRDTGovernance...");
  await verify(contracts.governance, [
    deployment.deployer, contracts.token, contracts.oracle,
  ]);

  // ── Verify QRDTKeeper ────────────────────────────────────────
  console.log("Verifying QRDTKeeper...");
  await verify(contracts.keeper, [deployment.deployer, contracts.oracle, 900]);

  console.log("\n✓ All contracts verified on Etherscan.\n");
}

async function verify(address, constructorArgs) {
  try {
    await run("verify:verify", { address, constructorArguments: constructorArgs });
    console.log(`  ✓ ${address}`);
  } catch (e) {
    if (e.message.includes("Already Verified")) {
      console.log(`  ⚠ Already verified: ${address}`);
    } else {
      console.error(`  ✗ Failed: ${e.message}`);
    }
  }
}

main().catch((err) => { console.error(err); process.exit(1); });
