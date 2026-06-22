# Local Development

Setup guide for running the Qredit protocol locally, writing tests, and debugging contracts.

---

## Requirements

- Node.js 18+
- npm 9+
- Git

Optional but recommended:
- [Slither](https://github.com/crytic/slither) — static analysis
- [Mythril](https://github.com/Consensys/mythril) — symbolic execution

---

## Setup

```bash
git clone https://github.com/ziberion/qredit-protocol
cd qredit-protocol
npm install
cp .env.example .env
```

Edit `.env` — for local development only `PRIVATE_KEY` is needed (any valid key works):

```bash
PRIVATE_KEY=0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80
# ^ hardhat account #0 — safe for local use only, never use on mainnet
```

---

## Project Structure

```
qredit-protocol/
├── contracts/
│   ├── Qredit.sol
│   ├── QRDTBasketOracle.sol
│   ├── QRDTGovernance.sol
│   ├── QRDTKeeper.sol
│   └── mocks/
│       ├── MockAggregatorV3.sol   — simulates Chainlink feeds
│       └── MockERC20.sol          — mintable ERC20 for reserve assets
├── scripts/
│   ├── deploy.js                  — deploys all contracts in order
│   └── verify.js                  — verifies on Etherscan
├── test/
│   ├── QRDTBasketOracle.test.js
│   ├── Qredit.test.js
│   └── Governance.test.js         — covers QRDTGovernance + QRDTKeeper
├── docs/                          — developer documentation
├── deployments/                   — deployment JSON files (gitignored)
├── hardhat.config.js
└── .env.example
```

---

## Compiling

```bash
npm run compile
```

Artifacts are output to `artifacts/`. ABIs are at:
```
artifacts/contracts/Qredit.sol/Qredit.json
artifacts/contracts/QRDTBasketOracle.sol/QRDTBasketOracle.json
artifacts/contracts/QRDTGovernance.sol/QRDTGovernance.json
artifacts/contracts/QRDTKeeper.sol/QRDTKeeper.json
```

---

## Running Tests

```bash
# All tests
npm test

# Single file
npx hardhat test test/QRDTBasketOracle.test.js

# Specific test by name pattern
npx hardhat test --grep "circuit breaker"

# With gas report
npm run test:gas

# With coverage report
npm run test:coverage
# → opens coverage/index.html
```

### Test structure

Each test file follows the same pattern:

```javascript
describe("ContractName", function () {
  let contract, admin, user;

  beforeEach(async function () {
    [admin, user] = await ethers.getSigners();
    // Deploy fresh contracts for each test
    contract = await deploy(...);
  });

  describe("Feature group", function () {
    it("specific behavior", async function () {
      // arrange
      // act
      // assert
    });
  });
});
```

### ERC20Votes — important testing note

The governance tests require voters to self-delegate **and** mine at least one block before creating a proposal. Without this, `getPastVotes` returns 0 at the snapshot block.

```javascript
// Required in beforeEach for governance tests
for (const voter of [voter1, voter2, voter3]) {
  await token.connect(voter).delegate(voter.address);
}
await ethers.provider.send("evm_mine", []);  // ensure snapshot block exists
```

---

## Local Node

Run a local Hardhat node for manual testing with a persistent state:

```bash
# Terminal 1 — start the node
npm run node

# Terminal 2 — deploy to local node
npm run deploy:local
```

The local node exposes a JSON-RPC at `http://127.0.0.1:8545` with 20 funded accounts (10000 ETH each). Account #0 is used as the deployer.

---

## Time Manipulation in Tests

Use `@nomicfoundation/hardhat-network-helpers` for time-sensitive tests:

```javascript
const { time } = require("@nomicfoundation/hardhat-network-helpers");

// Advance by N seconds
await time.increase(3 * 24 * 3600); // 3 days

// Jump to an exact timestamp
await time.increaseTo(1800000000);

// Mine a specific number of blocks
await time.mine(10);
```

---

## Debugging

### Reading revert reasons

```javascript
try {
  await contract.someFunction();
} catch (e) {
  console.log(e.reason);      // "Insufficient reserves (minimum 150%)"
  console.log(e.errorName);   // for custom errors
  console.log(e.data);        // raw revert data
}
```

### Event inspection

```javascript
const tx      = await contract.someFunction();
const receipt = await tx.wait();

for (const log of receipt.logs) {
  try {
    const parsed = contract.interface.parseLog(log);
    console.log(parsed.name, parsed.args);
  } catch {} // ignore logs from other contracts
}
```

### Checking state after a transaction

```javascript
// systemStatus() is a single call for all key token state
const [supply, backed, algo, reserveUSD, price, valid, paused, ratio] =
  await token.systemStatus();

console.log({
  supply:      ethers.formatEther(supply),
  backed:      ethers.formatEther(backed),
  algo:        ethers.formatEther(algo),
  reserveUSD:  (Number(reserveUSD) / 1e8).toFixed(2),
  price:       (Number(price) / 1e8).toFixed(6),
  valid,
  paused,
  ratio:       (Number(ratio) / 1e6).toFixed(2) + "%",
});
```

---

## Static Analysis

### Slither

```bash
pip install slither-analyzer
slither . --exclude-dependencies
```

Common flags:
```bash
# Exclude specific detectors
slither . --exclude-dependencies --exclude reentrancy-benign

# Output to file
slither . --exclude-dependencies --json slither-report.json
```

### Mythril

```bash
pip install mythril
myth analyze contracts/Qredit.sol --solc-json mythril.config.json
```

---

## Deploying to Sepolia

1. Get Sepolia ETH from a faucet: https://sepoliafaucet.com

2. Get a free RPC endpoint from [Alchemy](https://alchemy.com) or [Infura](https://infura.io)

3. Configure `.env`:
```bash
PRIVATE_KEY=your_deployer_private_key
SEPOLIA_RPC=https://eth-sepolia.g.alchemy.com/v2/YOUR_KEY
ETHERSCAN_KEY=your_etherscan_api_key
```

4. Deploy:
```bash
npm run deploy:sepolia
```

5. Verify on Etherscan:
```bash
npm run verify
```

6. Register the Keeper with Chainlink Automation:
   - Go to https://automation.chain.link
   - Select Sepolia
   - Register new upkeep → Custom logic
   - Enter the `QRDTKeeper` contract address
   - Fund with test LINK (available from https://faucets.chain.link)

---

## Adding a New Proposal Type

1. Add the new type to the `ProposalType` enum in `QRDTGovernance.sol`
2. Add input validation in `propose()` if needed
3. Add an execution branch in `_executeProposal()`
4. Add the target function to the appropriate interface (`IQRDT` or `IOracle`)
5. Add tests covering the full lifecycle (propose → vote → finalize → execute)
6. Update `docs/governance-api.md` with the new type

---

## Contributing

1. Fork the repository
2. Create a feature branch: `git checkout -b feat/your-feature`
3. Write tests for any new behavior
4. Ensure all tests pass: `npm test`
5. Run the linter: `npm run lint`
6. Open a pull request with a clear description of the change

**Pull request checklist:**
- [ ] Tests added for new behavior
- [ ] All existing tests pass
- [ ] No new Slither high/medium findings
- [ ] NatSpec comments updated for changed functions
- [ ] Relevant docs updated
