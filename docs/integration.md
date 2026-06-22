# Integration Guide

This document is for developers building applications, wallets, or services that interact with the Qredit protocol — reading prices, transferring QRDT, or minting/redeeming tokens.

---

## Contract Addresses

Addresses are saved to `deployments/` after each deploy run. Load the most recent file for the target network.

```javascript
const fs   = require("fs");
const path = require("path");

function loadDeployment(network) {
  const dir   = path.join(__dirname, "../deployments");
  const files = fs.readdirSync(dir)
    .filter(f => f.startsWith(`${network}-`))
    .sort().reverse();
  if (!files.length) throw new Error(`No deployment found for ${network}`);
  return JSON.parse(fs.readFileSync(path.join(dir, files[0])));
}

const { contracts } = loadDeployment("sepolia");
// contracts.token, contracts.oracle, contracts.governance, contracts.keeper
```

---

## Reading the Basket Price

The oracle exposes a single view function. No gas cost — call it off-chain or from a `view` function.

```solidity
// Solidity
interface IQRDTOracle {
    function getPrice() external view returns (
        uint256 price,      // basket value in USD, 8 decimals (1e8 = $1.00)
        bool    valid,      // false if circuit breaker active or price stale
        uint256 timestamp   // unix timestamp of last update
    );
}

IQRDTOracle oracle = IQRDTOracle(ORACLE_ADDRESS);
(uint256 price, bool valid, uint256 ts) = oracle.getPrice();
require(valid, "Oracle price not valid");
```

```javascript
// ethers.js
const oracle = new ethers.Contract(addresses.oracle, ORACLE_ABI, provider);
const [price, valid, timestamp] = await oracle.getPrice();

if (!valid) {
  console.warn("Oracle price invalid — circuit breaker or staleness");
}

const priceUSD = Number(price) / 1e8; // e.g. 1.003421
```

**When `valid` is false:**
- Circuit breaker triggered (price moved >10% in one round)
- Price not updated within the last hour
- Fallback mode active and the fallback has expired (>4 hours old)

Your integration should handle `valid = false` gracefully — display a warning rather than blocking all UI.

---

## Token Transfers

QRDT is a standard ERC-20 with an optional transfer fee (0–1%, default 0). Always read the current fee before displaying expected amounts.

```javascript
const token = new ethers.Contract(addresses.token, TOKEN_ABI, signer);

// Read current fee
const feeBps = await token.transferFeeBps(); // e.g. 50n = 0.5%

// Calculate net received
function netAmount(gross, feeBps) {
  return gross - (gross * feeBps / 10000n);
}

// Transfer
const amount = ethers.parseEther("100");
const tx = await token.transfer(recipientAddress, amount);
await tx.wait();

// Recipient receives: amount - fee
// Fee recipient receives: fee (set by governance)
```

**Fee-exempt addresses** (protocol contracts) do not pay fees. Check `feeExempt(address)` if you need to verify.

---

## Minting QRDT

Minting requires `MINTER_ROLE`. This is typically held by a dedicated minting contract or the deployer during early protocol stages.

```solidity
// Solidity — from an authorized minter contract
interface IQredit {
    function mintBacked(address to, uint256 amount) external;
    function reserveRatio() external view returns (uint256);
    function systemStatus() external view returns (
        uint256 supply,
        uint256 backed,
        uint256 algo,
        uint256 reserveUSD8,
        uint256 oraclePrice,
        bool    oracleValid,
        bool    paused,
        uint256 reserveRatio
    );
}

// Check reserve ratio before minting
(,,,,,,, uint256 ratio) = token.systemStatus();
require(ratio >= 150_000_000, "Insufficient reserve"); // 150% in 1e8

token.mintBacked(userAddress, mintAmount);
```

**Reserve must be pre-funded** before `mintBacked` succeeds. The reserve ratio after the proposed mint must remain ≥ 150%.

---

## Reading System State

`systemStatus()` is a gas-efficient single call for frontends:

```javascript
const [
  supply,       // total QRDT in circulation (18 dec)
  backed,       // backed portion (18 dec)
  algo,         // algorithmic portion (18 dec)
  reserveUSD8,  // total reserve value in USD (8 dec)
  oraclePrice,  // current basket price (8 dec)
  oracleValid,  // whether oracle is healthy
  paused,       // whether token is paused
  reserveRatio  // current ratio (8 dec, 150_000_000 = 150%)
] = await token.systemStatus();

// Format for display
const totalSupply   = ethers.formatEther(supply);
const reserveUSD    = Number(reserveUSD8) / 1e8;
const basketPrice   = Number(oraclePrice) / 1e8;
const ratioPercent  = Number(reserveRatio) / 1e6; // → 150.0
```

---

## Indexing Events

Key events to index for a complete protocol dashboard:

**Token events:**

```solidity
event MintBacked(address indexed to, uint256 amount, uint256 reserveRatio);
event MintAlgorithmic(address indexed to, uint256 amount, uint256 algoRatio);
event Burned(address indexed from, uint256 amount);
event ReserveDeposited(address indexed token, uint256 amount, uint256 usdValue8);
event ReserveWithdrawn(address indexed token, uint256 amount);
event TotalReserveUpdated(uint256 totalUSD8);
event Stabilized(string action, uint256 amount, uint256 price);
event FeeUpdated(uint256 feeBps, address recipient);
```

**Oracle events:**

```solidity
event PriceUpdated(uint256 price, uint256 timestamp);
event CircuitBreakerTriggered(uint256 newPrice, uint256 lastPrice, uint256 deviation);
event FeedFailed(string symbol, string reason);
event FallbackActivated(uint256 price, address by);
```

**Governance events:**

```solidity
event ProposalCreated(uint256 indexed id, address indexed proposer,
    ProposalType pType, string title, uint256 endTime, uint256 snapshotBlock);
event VoteCast(uint256 indexed proposalId, address indexed voter,
    uint8 support, uint256 votes, string reason);
event ProposalExecuted(uint256 indexed id);
event ProposalDefeated(uint256 indexed id, string reason);
event ProposalCancelled(uint256 indexed id, address by, string reason);
```

**Listening in ethers.js:**

```javascript
// Real-time
token.on("MintBacked", (to, amount, ratio, event) => {
  console.log(`Minted ${ethers.formatEther(amount)} QRDT to ${to}`);
});

// Historical
const filter = token.filters.MintBacked();
const events = await token.queryFilter(filter, fromBlock, toBlock);
```

---

## Reading Voting Power

For governance UIs, always read past votes at the relevant snapshot block — not the current balance.

```javascript
const governance = new ethers.Contract(addresses.governance, GOV_ABI, provider);
const token      = new ethers.Contract(addresses.token, TOKEN_ABI, provider);

// Get snapshot block for a proposal
const [,,,,,,, snapshotBlock] = await governance.getProposal(proposalId);

// Read voting power at snapshot
const votingPower = await token.getPastVotes(userAddress, snapshotBlock);
console.log(`Voting power: ${ethers.formatEther(votingPower)} QRDT`);

// Check if user has voted
const vote = await governance.getVote(proposalId, userAddress);
// 0 = not voted, 1 = for, 2 = against, 3 = abstain
```

---

## Calling from a Smart Contract

Minimal interfaces for on-chain integrations:

```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

interface IQredit {
    function balanceOf(address account) external view returns (uint256);
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function approve(address spender, uint256 amount) external returns (bool);
    function totalSupply() external view returns (uint256);
    function transferFeeBps() external view returns (uint256);
    function feeExempt(address account) external view returns (bool);
    function systemStatus() external view returns (
        uint256, uint256, uint256, uint256, uint256, bool, bool, uint256
    );
}

interface IQRDTOracle {
    function getPrice() external view returns (uint256 price, bool valid, uint256 timestamp);
    function getTWAP(uint8 periods) external view returns (uint256);
    function isPriceManipulated(uint256 threshold) external view returns (bool);
}
```

---

## Error Reference

Common revert reasons and their meaning:

| Message | Contract | Cause |
|---|---|---|
| `Oracle: price not valid` | Qredit | Oracle returned `valid = false` |
| `Oracle: price too old` | Qredit | Last update older than `ORACLE_TIMEOUT` (2h) |
| `Insufficient reserves (minimum 150%)` | Qredit | Reserve ratio would fall below 150% after mint |
| `Exceeds per-transaction mint limit` | Qredit | Attempted to mint more than 1,000,000 QRDT in one tx |
| `Exceeds algorithmic supply limit (20%)` | Qredit | Algo supply would exceed 20% of total |
| `Withdrawal would break minimum reserve ratio` | Qredit | Reserve withdrawal would push ratio below 150% |
| `Critical feeds unavailable (USD/EUR)` | Oracle | USD or EUR Chainlink feed failed validation |
| `Upkeep not needed yet` | Keeper | `performUpkeep` called before interval or staleness threshold |
| `Timelock is still active` | Governance | `execute` called before timelock period elapsed |
| `No voting power at snapshot` | Governance | Address had not delegated before proposal was created |
| `Cannot cancel after voting has started` | Governance | Proposer tried to cancel after at least one vote |
