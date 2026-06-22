# Governance API

Complete reference for interacting with `QRDTGovernance` — creating proposals, voting, executing, and reading state.

---

## Prerequisites

### 1. Activate voting power

Before you can vote or create proposals, you must activate your voting power checkpoints by delegating. **This must be done before a proposal is created** — voting power is fixed at the snapshot block.

```javascript
const token = new ethers.Contract(tokenAddress, TOKEN_ABI, signer);

// Delegate to yourself to vote with your own tokens
await token.delegate(signer.address);

// Or delegate to someone else
await token.delegate(delegateAddress);
```

Delegation is a one-time action per wallet. If you acquire more tokens later, they are automatically included in future snapshots without re-delegating.

### 2. Check current voting power

```javascript
// Live balance (for proposal threshold check)
const balance = await token.balanceOf(address);

// Past votes at a specific block (for vote weight)
const pastVotes = await token.getPastVotes(address, blockNumber);
```

---

## Creating a Proposal

The `propose()` function accepts a generic parameter set. Which parameters are used depends on the proposal type.

```solidity
function propose(
    ProposalType pType,
    string calldata title,        // max 100 chars
    string calldata description,
    uint256 p1,   // USD weight / feeBps / fallback price
    uint256 p2,   // EUR weight
    uint256 p3,   // JPY weight
    uint256 p4,   // GBP weight
    uint256 p5,   // XAU weight
    address pAddr, // oracle address / fee recipient
    bool    pBool  // true = activate fallback, false = deactivate
) external returns (uint256 proposalId)
```

**Requirement:** caller must hold more than `proposalThreshold` (default: 100 QRDT).

### Examples

**GENERAL — text-only proposal:**
```javascript
const tx = await governance.propose(
  7,                          // ProposalType.GENERAL
  "Increase bug bounty cap",
  "Proposal to raise the maximum bug bounty reward from $500k to $1M...",
  0n, 0n, 0n, 0n, 0n,
  ethers.ZeroAddress,
  false
);
const receipt = await tx.wait();
const proposalId = receipt.logs
  .find(l => l.fragment?.name === "ProposalCreated")
  ?.args.id;
```

**UPDATE_BASKET_WEIGHTS:**
```javascript
// New weights must sum to 10000
await governance.propose(
  0,                          // ProposalType.UPDATE_BASKET_WEIGHTS
  "Rebalance: increase USD weight",
  "Rationale: recent EUR volatility warrants reducing EUR exposure...",
  5000n,  // USD 50%
  2500n,  // EUR 25%
  1000n,  // JPY 10%
  1000n,  // GBP 10%
  500n,   // XAU 5%
  ethers.ZeroAddress,
  false
);
```

**SET_TRANSFER_FEE:**
```javascript
await governance.propose(
  4,                          // ProposalType.SET_TRANSFER_FEE
  "Set 0.5% transfer fee",
  "Enable protocol revenue to fund future development...",
  50n,    // p1 = feeBps (50 = 0.5%, max 100 = 1%)
  0n, 0n, 0n, 0n,
  feeRecipientAddress,        // pAddr = fee recipient
  false
);
```

**PAUSE_TOKEN (emergency):**
```javascript
await governance.propose(
  2,                          // ProposalType.PAUSE_TOKEN
  "Emergency pause",
  "Pausing due to suspected oracle manipulation...",
  0n, 0n, 0n, 0n, 0n,
  ethers.ZeroAddress,
  false
);
```

**ORACLE_FALLBACK:**
```javascript
// Activate fallback at $1.00
await governance.propose(
  6,                          // ProposalType.ORACLE_FALLBACK
  "Activate oracle fallback",
  "USD/EUR feeds showing anomalous data — setting manual fallback price...",
  100_000_000n,               // p1 = fallback price (8 dec, 1e8 = $1.00)
  0n, 0n, 0n, 0n,
  ethers.ZeroAddress,
  true                        // pBool = true → activate
);

// Deactivate fallback
await governance.propose(
  6,
  "Deactivate oracle fallback",
  "Chainlink feeds restored to normal operation...",
  0n, 0n, 0n, 0n, 0n,
  ethers.ZeroAddress,
  false                       // pBool = false → deactivate
);
```

---

## Voting

```javascript
const governance = new ethers.Contract(govAddress, GOV_ABI, signer);

// support: 1 = For, 2 = Against, 3 = Abstain
await governance.castVote(proposalId, 1, "This change improves protocol stability");
await governance.castVote(proposalId, 2, "");
await governance.castVote(proposalId, 3, "Neutral — abstaining pending more discussion");
```

**Before voting, verify:**
```javascript
// 1. Proposal is still active
const [,,,,,, endTime,, state] = await governance.getProposal(proposalId);
const isActive = state === 0n && BigInt(Math.floor(Date.now() / 1000)) <= endTime;

// 2. You haven't voted yet
const existingVote = await governance.getVote(proposalId, signer.address);
const hasVoted = existingVote !== 0n;

// 3. You have voting power at the snapshot
const [,,,,,,,snapshotBlock] = await governance.getProposal(proposalId);
const power = await token.getPastVotes(signer.address, snapshotBlock);
const canVote = power > 0n;
```

---

## Reading Proposal State

```javascript
const [
  proposer,
  title,
  description,
  votesFor,
  votesAgainst,
  votesAbstain,
  endTime,
  snapshotBlock,
  state,         // 0=Active 1=Defeated 2=Succeeded 3=Queued 4=Executed 5=Cancelled 6=Expired
  pType          // 0=UPDATE_BASKET_WEIGHTS ... 7=GENERAL
] = await governance.getProposal(proposalId);

const STATE_LABELS = [
  "Active", "Defeated", "Succeeded",
  "Queued", "Executed", "Cancelled", "Expired"
];
console.log(`Proposal #${proposalId}: ${title} — ${STATE_LABELS[state]}`);

// Quorum progress
const quorumNeeded = await governance.quorumRequired();
const totalVotes   = votesFor + votesAgainst + votesAbstain;
const quorumPct    = Number(totalVotes * 100n / quorumNeeded);
console.log(`Quorum: ${quorumPct.toFixed(1)}% of required`);
```

---

## Finalizing a Proposal

Anyone can call `finalize()` after the voting period ends. This transitions the proposal to `Queued` or `Defeated`.

```javascript
const now    = BigInt(Math.floor(Date.now() / 1000));
const [,,,,,,endTime,, state] = await governance.getProposal(proposalId);

if (state === 0n && now > endTime) {
  await governance.finalize(proposalId);
}
```

---

## Executing a Proposal

Anyone can call `execute()` after the timelock period elapses.

```javascript
// Read queued proposal
const proposal = await governance.proposals(proposalId);
const timelockPeriod = await governance.timelockPeriod();
const now = BigInt(Math.floor(Date.now() / 1000));

if (
  proposal.state === 3n &&                               // Queued
  now >= proposal.queuedAt + timelockPeriod &&           // Timelock passed
  now <= proposal.executionDeadline                      // Not expired
) {
  await governance.execute(proposalId);
}
```

---

## Cancelling a Proposal

**As proposer** — only before any vote is cast:
```javascript
await governance.cancelByProposer(proposalId, "Error in parameters — resubmitting");
```

**As guardian:**
```javascript
// Guardian can cancel Active or Queued proposals regardless of votes
await governance.connect(guardian).cancel(proposalId, "Critical security issue detected");
```

---

## Listing Proposals

There is no on-chain enumeration of all proposals. Use events for indexing.

```javascript
// All proposals ever created
const filter  = governance.filters.ProposalCreated();
const events  = await governance.queryFilter(filter, deployBlock);
const proposals = events.map(e => ({
  id:        e.args.id,
  proposer:  e.args.proposer,
  type:      e.args.pType,
  title:     e.args.title,
  endTime:   e.args.endTime,
  snapshot:  e.args.snapshotBlock,
}));

// Proposals by a specific address
const ids = await governance.getProposalsByProposer(address);
```

---

## Governance Parameters

```javascript
const votingPeriod   = await governance.votingPeriod();   // seconds
const timelockPeriod = await governance.timelockPeriod(); // seconds
const quorumPct      = await governance.quorumPct();      // percent (10 = 10%)
const threshold      = await governance.proposalThreshold(); // QRDT (18 dec)

// Human-readable
console.log(`Voting: ${Number(votingPeriod) / 86400} days`);
console.log(`Timelock: ${Number(timelockPeriod) / 3600} hours`);
console.log(`Quorum: ${quorumPct}%`);
console.log(`Threshold: ${ethers.formatEther(threshold)} QRDT`);
```

---

## ProposalType Enum Reference

| Value | Name | On-chain action |
|---|---|---|
| 0 | `UPDATE_BASKET_WEIGHTS` | `oracle.updateWeights(p1,p2,p3,p4,p5)` |
| 1 | `UPDATE_ORACLE_WEIGHTS` | `oracle.updateWeights(p1,p2,p3,p4,p5)` |
| 2 | `PAUSE_TOKEN` | `token.pause()` |
| 3 | `UNPAUSE_TOKEN` | `token.unpause()` |
| 4 | `SET_TRANSFER_FEE` | `token.setTransferFee(p1, pAddr)` |
| 5 | `SET_ORACLE` | `token.setOracle(pAddr)` |
| 6 | `ORACLE_FALLBACK` | `oracle.activateFallback(p1)` or `oracle.deactivateFallback()` |
| 7 | `GENERAL` | *(no on-chain execution)* |
