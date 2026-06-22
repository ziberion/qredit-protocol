# Architecture

## Overview

Qredit is composed of four smart contracts with well-defined responsibilities and interaction boundaries. No contract holds privileged access over another except through explicit role grants configured at deployment.

```
┌─────────────────────────────────────────────────────────────┐
│                        External                             │
│   Users · Wallets · Fintechs · Chainlink Automation        │
└───────────┬────────────────────────┬────────────────────────┘
            │                        │
            ▼                        ▼
┌───────────────────┐    ┌───────────────────────────┐
│   QRDTKeeper      │    │      QRDTGovernance        │
│                   │    │                            │
│  Chainlink        │    │  Snapshot voting           │
│  Automation       │    │  (ERC20Votes)              │
│  upkeep           │    │  Proposal execution        │
└────────┬──────────┘    └──────────┬─────────────────┘
         │ updatePrice()            │ updateWeights()
         │                         │ pause() / setOracle()
         ▼                         ▼
┌─────────────────────────────────────────────────────────────┐
│                   QRDTBasketOracle                          │
│                                                             │
│  Chainlink feeds: USD · EUR · JPY · GBP · XAU              │
│  Circuit breaker · TWAP · Emergency fallback               │
│  getPrice() → (price uint256, valid bool, timestamp uint256)│
└──────────────────────────┬──────────────────────────────────┘
                           │ getPrice()
                           ▼
┌─────────────────────────────────────────────────────────────┐
│                   Qredit (QRDT)                             │
│                                                             │
│  ERC20Votes · mintBacked · mintAlgorithmic                  │
│  Reserve management · Transfer fee · Stabilization         │
└─────────────────────────────────────────────────────────────┘
```

---

## Contracts

### Qredit.sol

The core ERC-20 token contract. Inherits from `ERC20Votes` (OpenZeppelin), enabling snapshot-based voting power for governance.

**Key responsibilities:**
- Token minting against verified collateral (`mintBacked`) or algorithmically (`mintAlgorithmic`, max 20% of supply)
- Reserve asset management: deposit, withdraw, price updates
- Oracle price consumption and staleness enforcement
- Transfer fee collection (max 1%, configurable, exempt list)
- Voting power checkpoints via `ERC20Votes`

**State variables of note:**

| Variable | Type | Description |
|---|---|---|
| `oracle` | `IBasketOracle` | Active price oracle |
| `lastOraclePrice` | `uint256` | Cached basket price (8 dec) |
| `lastOracleUpdate` | `uint256` | Timestamp of last valid price |
| `backedSupply` | `uint256` | Tokens backed by real reserve assets |
| `algorithmicSupply` | `uint256` | Algorithmically minted tokens |
| `totalReserveUSD8` | `uint256` | Total reserve value in USD (8 dec) |
| `transferFeeBps` | `uint256` | Current fee in basis points (0–100) |

**Roles:**

| Role | Capability |
|---|---|
| `DEFAULT_ADMIN_ROLE` | Add/deactivate reserve assets, set oracle, set fee, grant roles |
| `MINTER_ROLE` | Call `mintBacked` |
| `STABILIZER_ROLE` | Call `mintAlgorithmic`, `stabilize` |
| `RESERVE_ROLE` | Deposit/withdraw reserve, update reserve prices |
| `PAUSER_ROLE` | Pause/unpause the token |

---

### QRDTBasketOracle.sol

Aggregates five Chainlink price feeds into a single weighted basket price. Acts as the single source of truth for QRDT's value.

**Price calculation:**
```
basketPrice = (pUSD × 4000 + pEUR × 3000 + pJPY × 1500 + pGBP × 1000 + pXAU × 500) / 10000
```

All prices use 8 decimal precision (Chainlink standard). Result is also 8 decimals.

**Feed validation (per feed):**
1. `answer > 0` — non-negative price
2. `answeredInRound >= roundId` — complete round
3. `block.timestamp - updatedAt <= heartbeat + 30min` — freshness check
4. `MIN_PRICE <= answer <= MAX_PRICE` — sanity range

USD and EUR are critical feeds — the update reverts if either fails. JPY, GBP, XAU degrade gracefully to the last known price.

**Circuit breaker:** rejects any single update where the basket price moves more than 10% from the previous value. Auto-resets if the next update returns within 5%.

**Three-tier price delivery:**

| Tier | Source | Activated when |
|---|---|---|
| Primary | Chainlink feeds | Normal operation |
| Fallback | Guardian-set manual price | Oracle failure, valid 4 hours |
| Stale | Last known price, `valid=false` | Circuit breaker active or price > 1 hour old |

**Roles:**

| Role | Capability |
|---|---|
| `DEFAULT_ADMIN_ROLE` | Update weights, enable/disable feeds |
| `UPDATER_ROLE` | Call `updatePrice` (granted to QRDTKeeper) |
| `GUARDIAN_ROLE` | Activate/deactivate fallback, reset circuit breaker, pause |

---

### QRDTGovernance.sol

On-chain DAO with snapshot-based voting power. All protocol parameter changes go through this contract.

**Voting power model:**

Uses `ERC20Votes.getPastVotes(account, snapshotBlock)`. The snapshot block is `block.number - 1` at proposal creation. Voting power is immutable after proposal creation — transfers, mints, or burns after the snapshot do not affect vote weight.

> **Important:** Addresses must call `token.delegate(address)` to activate checkpoints before a proposal is created. Without prior delegation, `getPastVotes` returns 0.

**Proposal lifecycle:**

```
propose()
    │
    ▼ [Active — votingPeriod (default 3 days)]
castVote()  ←── snapshot-based power
    │
    ▼ finalize() — checks quorum + majority
    │
    ├── Defeated (quorum not reached, or majority Against)
    │
    ▼ [Queued — timelockPeriod (default 24h)]
    │
    └── execute() ←── anyone can call after timelock
```

**Cancellation rules:**

| Actor | Function | Condition |
|---|---|---|
| Proposer | `cancelByProposer()` | Before any vote is cast |
| Guardian | `cancel()` | Any Active or Queued proposal |

**Execution targets by proposal type:**

| Type | Target | Function called |
|---|---|---|
| `UPDATE_BASKET_WEIGHTS` | Oracle | `updateWeights(p1,p2,p3,p4,p5)` |
| `UPDATE_ORACLE_WEIGHTS` | Oracle | `updateWeights(p1,p2,p3,p4,p5)` |
| `PAUSE_TOKEN` | Token | `pause()` |
| `UNPAUSE_TOKEN` | Token | `unpause()` |
| `SET_TRANSFER_FEE` | Token | `setTransferFee(p1, pAddr)` |
| `SET_ORACLE` | Token | `setOracle(pAddr)` |
| `ORACLE_FALLBACK` | Oracle | `activateFallback(p1)` or `deactivateFallback()` |
| `GENERAL` | — | Text-only, no on-chain action |

---

### QRDTKeeper.sol

Chainlink Automation-compatible upkeep contract. Calls `oracle.updatePrice()` every 15 minutes (configurable), or immediately if the price becomes stale.

**Upkeep trigger conditions (either):**
- `block.timestamp >= lastUpkeepTime + updateInterval`
- `block.timestamp >= lastOracleTimestamp + maxPriceAge` (emergency trigger)

Failures are caught and recorded — a failed oracle update does not revert the keeper transaction. The failure count and last reason are readable via `keeperStatus()`.

---

## Precision Model

| Value type | Decimals | Example |
|---|---|---|
| Token amounts (QRDT) | 18 | `1e18` = 1 QRDT |
| Oracle prices | 8 | `1e8` = $1.00 |
| Reserve USD values | 8 | `150_000_000` = $1.50 |
| Weights (basis points) | 0 | `4000` = 40% |
| Fees (basis points) | 0 | `100` = 1% |
| Reserve ratio | 8 | `150_000_000` = 150% |

**Reserve ratio formula:**
```
reserveRatio = totalReserveUSD8 × PRECISION / (totalSupply × lastOraclePrice / 1e18)
```

Where `PRECISION = 1e8`. A result of `150_000_000` means 150%.

---

## Deployment Order

Contracts must be deployed in this order due to constructor dependencies:

```
1. MockAggregatorV3 × 5  (testnet only)
2. QRDTBasketOracle      (requires: 5 feed addresses)
3. Qredit                (requires: oracle address)
4. QRDTGovernance        (requires: token address, oracle address)
5. QRDTKeeper            (requires: oracle address)
```

**Post-deployment role grants (required):**

```
oracle.grantRole(UPDATER_ROLE,  keeper.address)
oracle.grantRole(GUARDIAN_ROLE, governance.address)
token.grantRole(STABILIZER_ROLE, governance.address)
oracle.updatePrice()  ← initial price update to exit fallback mode
```

---

## Security Model

**No upgrade mechanism.** Contracts are non-upgradeable. A new deployment is required for breaking changes.

**No team multisig.** `DEFAULT_ADMIN_ROLE` is granted to the deployer at construction. For mainnet, this role should be transferred to the governance contract after initial setup, making all further changes subject to community vote.

**Reentrancy protection.** All state-changing external functions use `nonReentrant`. The checks-effects-interactions pattern is applied throughout.

**Oracle dependency.** The system has a hard dependency on Chainlink feed availability for USD and EUR. If both feeds fail simultaneously, minting is halted until the guardian activates the fallback price.
