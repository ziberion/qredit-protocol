# Qredit Protocol

**QRDT — The Global Exchange Currency**

A decentralized protocol for a global exchange currency backed by a diversified basket of the world's leading reserve currencies. Applying the same principle the IMF has validated for over 50 years with its Special Drawing Rights (SDR) — democratized and accessible to anyone with a digital wallet.

> qredits.io

---

## Overview

Qredit (QRDT) is not a stablecoin. It is a global exchange currency designed for international payments, remittances, and value transfer across borders, with:

- **No registration required** — a digital wallet is sufficient
- **No geographic restrictions** — works wherever wallets are supported
- **Max 1% transfer fee** — no hidden conversion spread
- **150% minimum collateralization** — real assets backing every token
- **On-chain governance** — users vote on protocol changes

### Basket Composition

| Currency | Weight | Rationale |
|---|---|---|
| US Dollar (USD) | 40% | Dominant global reserve currency |
| Euro (EUR) | 30% | Second-largest reserve currency |
| Japanese Yen (JPY) | 15% | Traditional safe-haven asset |
| Pound Sterling (GBP) | 10% | Historic financial center |
| Tokenized Gold (XAU) | 5% | Sovereign-independent inflation hedge |

### Stability (2010–2026 simulations)

| Metric | QRDT | Reference |
|---|---|---|
| Annual volatility | 3.87% | vs. 8–15% for individual currencies |
| Max drawdown | 13.1% | vs. 49.8% JPY, 39.9% GBP |
| COVID-19 deviation | ±1.55% | Stable |
| Brexit deviation | ±2.10% | Stable |
| Worst case (EUR crisis) | ±9.5% | Stressed |

---

## Contracts

| Contract | Description |
|---|---|
| `Qredit.sol` | ERC-20 token with ERC20Votes, minting, burning, stabilization, and transfer fee |
| `QRDTBasketOracle.sol` | Multi-feed Chainlink aggregator with circuit breaker and TWAP |
| `QRDTGovernance.sol` | On-chain DAO with snapshot voting, proposals, timelock, and execution |
| `QRDTKeeper.sol` | Chainlink Automation upkeep for 15-minute oracle updates |

---

## Getting Started

### Prerequisites

- Node.js 18+
- npm or yarn

### Install

```bash
git clone https://github.com/ziberion/qredit-protocol
cd qredit-protocol
npm install
```

### Configure

```bash
cp .env.example .env
# Edit .env with your PRIVATE_KEY, SEPOLIA_RPC, and ETHERSCAN_KEY
```

### Compile

```bash
npm run compile
```

### Test

```bash
# Run all tests
npm test

# With gas report
npm run test:gas

# With coverage
npm run test:coverage
```

### Deploy

```bash
# Local node (start node first: npm run node)
npm run deploy:local

# Sepolia testnet
npm run deploy:sepolia
```

### Verify on Etherscan

```bash
npm run verify
```

---

## Network Configuration

### Chainlink Price Feeds

**Ethereum Mainnet** (do not use for testnet deployment):

| Feed | Address |
|---|---|
| USDC/USD | `0x8fFfFfd4AfB6115b954Bd326cbe7B4BA576818f6` |
| EUR/USD | `0xb49f677943BC038e9857d61E7d053CaA2C1734C` |
| JPY/USD | `0xBcE206caE7f0ec07b545EddE332A47C2F75bbeb` |
| GBP/USD | `0x5c0Ab2d9b5a7ed9f470386e82BB36A3613cDd4b` |
| XAU/USD | `0x214eD9Da11D2fbe465a6fc601a91E62EbEc1a0D6` |

**Sepolia Testnet**: The deploy script automatically deploys `MockAggregatorV3` contracts on localhost and Sepolia. For production Sepolia feeds, see [Chainlink Docs](https://docs.chain.link/data-feeds/price-feeds/addresses?network=ethereum#sepolia-testnet).

> ⚠️ Never use mainnet feed addresses on testnet deployments.

---

## Documentation

| Document | Description |
|---|---|
| [docs/architecture.md](./docs/architecture.md) | Contract overview, roles, precision model, deployment order |
| [docs/integration.md](./docs/integration.md) | Reading prices, transfers, minting, events, error reference |
| [docs/governance-api.md](./docs/governance-api.md) | Creating proposals, voting, executing, full code examples |
| [docs/local-development.md](./docs/local-development.md) | Setup, testing, debugging, deploying to Sepolia |

---

## Architecture

```
QRDTKeeper (Chainlink Automation)
    │
    ▼ updatePrice() every 15 min
QRDTBasketOracle
    │  ├── Chainlink USD/EUR/JPY/GBP/XAU feeds
    │  ├── Circuit breaker (>10% single-round jump)
    │  ├── TWAP sliding window (10 snapshots)
    │  └── Emergency fallback (guardian, 4h validity)
    │
    ▼ getPrice()
Qredit (QRDT Token — ERC20Votes)
    │  ├── mintBacked (MINTER_ROLE, requires 150% reserve ratio)
    │  ├── mintAlgorithmic (STABILIZER_ROLE, max 20% of supply)
    │  ├── burn / burnFrom
    │  ├── Reserve management (RESERVE_ROLE)
    │  ├── Transfer fee (max 1%, configurable)
    │  └── Voting checkpoints (automatic on every transfer)
    │
    ▼ propose / vote / execute
QRDTGovernance (DAO)
       ├── Snapshot-based voting power (ERC20Votes)
       ├── 3-day voting period
       ├── 10% quorum
       ├── 24-hour timelock
       ├── Proposer self-cancellation (before any vote)
       └── Guardian veto
```

---

## Governance

### Activating Your Voting Power

Qredit uses snapshot-based voting via [ERC20Votes](https://docs.openzeppelin.com/contracts/5.x/api/token/erc20#ERC20Votes). Voting power is calculated at the block before a proposal is created — not at the time you vote. This makes voting immune to flash loan manipulation.

**Before you can vote, you must activate your voting power by delegating.**

To vote with your own tokens, delegate to yourself:

```solidity
// Solidity
IQRDT(qrdtToken).delegate(yourAddress);
```

```javascript
// ethers.js / wagmi
await token.delegate(account.address);
```

This only needs to be done once. If you acquire more tokens later they are automatically included in future snapshots without re-delegating.

To delegate your voting power to another address:

```javascript
await token.delegate(delegateAddress);
```

> ⚠️ If you have not delegated before a proposal is created, your voting power at that snapshot will be 0 and you will not be able to vote on that proposal — even if you hold QRDT.

---

### Proposal Lifecycle

```
propose() → [Active: 3 days] → finalize() → [Queued: 24h timelock] → execute()
                │                                     │
                └── cancelByProposer()                └── cancel()
                    (no votes cast only)                  (guardian only)
```

| Step | Who | Condition |
|---|---|---|
| `propose()` | Any address with > 100 QRDT | — |
| `castVote()` | Any address with past votes at snapshot | Within voting period |
| `finalize()` | Anyone | After voting period ends |
| `execute()` | Anyone | After timelock (24h), before deadline (+7 days) |
| `cancelByProposer()` | Proposer only | Before any vote is cast |
| `cancel()` | Guardian only | Any Active or Queued proposal |

### Cancelling a Proposal

**As a proposer**, you can cancel your own proposal before any vote is cast — for example if you made an error in the parameters:

```javascript
await governance.cancelByProposer(proposalId, "Parameter error — resubmitting");
```

This is only possible while:
- The proposal is `Active` and within the voting period
- No votes have been cast yet

Once a single vote is cast the proposer loses the ability to cancel. This prevents retracting a proposal that is losing mid-vote.

**The guardian** can cancel any `Active` or `Queued` proposal at any time, regardless of vote count, for emergency situations.

---

## Known Limitations & Roadmap

### Before Mainnet

- [x] Snapshot-based voting power via `ERC20Votes` (flash loan protection)
- [x] `UPDATE_BASKET_WEIGHTS` execution branch in governance
- [x] Proposer self-cancellation before votes are cast
- [ ] External security audit
- [ ] Slither / Mythril CI integration

### Roadmap

| Phase | Timeline | Milestones |
|---|---|---|
| Testnet | Q3 2026 | Sepolia deployment, public repo, bug bounty |
| Audit | Q4 2026 | External audit, Chainlink mainnet integration |
| Mainnet | Q1 2027 | Launch, initial liquidity, DEX integration |
| Growth | 2027 | B2B API, SDK, multi-chain (Polygon, Arbitrum, Base) |

---

## Security

### Internal Review Results

Two High severity and five Medium severity issues were identified and resolved before testnet deployment. See [SECURITY.md](./SECURITY.md) for details.

### Bug Bounty

A bug bounty program will be launched concurrent with testnet deployment, with rewards up to $500,000 for critical vulnerabilities.

### Responsible Disclosure

To report a vulnerability, please email security@qredits.io before opening a public issue.

---

## License

MIT — see [LICENSE](./LICENSE)

---

## Disclaimer

This software is provided for informational and experimental purposes. It has not been audited by an external security firm. Do not use with funds you cannot afford to lose. This is not financial advice.
