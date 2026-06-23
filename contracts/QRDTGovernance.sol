// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

// ============================================================
//  QRDTGovernance v1.0
//  qredits.io · github.com/ziberion/qredit-protocol
//
//  On-chain DAO for the Qredit protocol.
//  · Snapshot-based voting power via ERC20Votes (FIX PRE-01)
//  · 8 proposal types with on-chain execution (FIX PRE-02)
//  · 3-day voting period · 10% quorum · 24-hour timelock
//  · Guardian veto for emergency cancellation
// ============================================================

import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";
import "@openzeppelin/contracts/access/AccessControl.sol";

/// @notice Interface for QRDT token — includes ERC20Votes snapshot reads
interface IQRDT {
    function totalSupply()                              external view returns (uint256);
    function balanceOf(address)                         external view returns (uint256);
    function getPastVotes(address, uint256)             external view returns (uint256);
    function getPastTotalSupply(uint256)                external view returns (uint256);
    function delegate(address)                          external;
    function pause()                                    external;
    function unpause()                                  external;
    function setTransferFee(uint256, address)           external;
    function setOracle(address)                         external;
}

/// @notice Interface for oracle governance
interface IOracle {
    function updateWeights(uint256,uint256,uint256,uint256,uint256) external;
    function setFeedActive(string calldata, bool)                   external;
    function activateFallback(uint256)                              external;
    function deactivateFallback()                                   external;
}

/// @title  QRDTGovernance
/// @notice Decentralized governance for the Qredit protocol
contract QRDTGovernance is AccessControl, ReentrancyGuard, Pausable {

    // ── Roles ─────────────────────────────────────────────────
    bytes32 public constant GUARDIAN_ROLE = keccak256("GUARDIAN_ROLE");

    // ── Governance parameters ─────────────────────────────────
    uint256 public votingPeriod       = 3 days;
    uint256 public timelockPeriod     = 1 days;
    uint256 public quorumPct          = 10;
    uint256 public proposalThreshold  = 100 * 1e18;

    // ── Pending parameter queue (48h delay) ───────────────────
    uint256 public pendingVotingPeriod;
    uint256 public pendingTimelockPeriod;
    uint256 public pendingQuorumPct;
    uint256 public pendingParamsActiveFrom;

    // ── Governed contracts ────────────────────────────────────
    address public qrdtToken;
    address public oracleContract;

    // ── Proposal types ────────────────────────────────────────
    enum ProposalType {
        UPDATE_BASKET_WEIGHTS,  // 0 — FIX PRE-02: now has execution branch
        UPDATE_ORACLE_WEIGHTS,  // 1
        PAUSE_TOKEN,            // 2
        UNPAUSE_TOKEN,          // 3
        SET_TRANSFER_FEE,       // 4
        SET_ORACLE,             // 5
        ORACLE_FALLBACK,        // 6
        GENERAL                 // 7 — text-only, no on-chain execution
    }

    enum ProposalState {
        Active,     // 0
        Defeated,   // 1
        Succeeded,  // 2
        Queued,     // 3
        Executed,   // 4
        Cancelled,  // 5
        Expired     // 6
    }

    struct Proposal {
        uint256       id;
        address       proposer;
        ProposalType  pType;
        string        title;
        string        description;
        uint256       votesFor;
        uint256       votesAgainst;
        uint256       votesAbstain;
        uint256       startTime;
        uint256       endTime;
        uint256       snapshotBlock;  // FIX PRE-01: block at proposal creation
        uint256       queuedAt;
        uint256       executionDeadline;
        ProposalState state;
        uint256       param1;
        uint256       param2;
        uint256       param3;
        uint256       param4;
        uint256       param5;
        address       paramAddr;
        bool          paramBool;
    }

    // ── Storage ───────────────────────────────────────────────
    mapping(uint256 => Proposal)                  public proposals;
    mapping(uint256 => mapping(address => uint8)) public votes;
    mapping(address => uint256[])                 public proposalsByProposer;

    uint256 public proposalCount;
    uint256 public totalExecuted;
    uint256 public totalDefeated;

    // ── Events ────────────────────────────────────────────────
    event ProposalCreated(
        uint256 indexed id,
        address indexed proposer,
        ProposalType    pType,
        string          title,
        uint256         endTime,
        uint256         snapshotBlock
    );
    event VoteCast(
        uint256 indexed proposalId,
        address indexed voter,
        uint8           support,
        uint256         votes,
        string          reason
    );
    event ProposalQueued(uint256 indexed id, uint256 executionTime);
    event ProposalExecuted(uint256 indexed id);
    event ProposalDefeated(uint256 indexed id, string reason);
    event ProposalCancelled(uint256 indexed id, address by, string reason);
    event GovernanceParamsQueued(
        uint256 votingPeriod,
        uint256 timelockPeriod,
        uint256 quorumPct,
        uint256 activeFrom
    );

    // ── Constructor ───────────────────────────────────────────
    constructor(address admin, address _qrdtToken, address _oracle) {
        require(admin      != address(0), "Admin cannot be zero address");
        require(_qrdtToken != address(0), "Token cannot be zero address");
        require(_oracle    != address(0), "Oracle cannot be zero address");

        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(GUARDIAN_ROLE,      admin);

        qrdtToken      = _qrdtToken;
        oracleContract = _oracle;
    }

    // ================================================================
    //  VOTING POWER  (FIX PRE-01: snapshot-based, not live balance)
    // ================================================================

    /// @notice Voting power of account at a past block (snapshot)
    /// @dev    Uses ERC20Votes.getPastVotes — immune to flash loans
    function votingPowerAt(address account, uint256 blockNumber)
        public view returns (uint256)
    {
        return IQRDT(qrdtToken).getPastVotes(account, blockNumber);
    }

    /// @notice Current voting power (for proposal threshold check only)
    /// @dev    Uses live balance intentionally — threshold is checked at
    ///         proposal creation time, not at vote time
    function currentVotingPower(address account) public view returns (uint256) {
        return IQRDT(qrdtToken).balanceOf(account);
    }

    // ================================================================
    //  CREATE PROPOSAL
    // ================================================================

    function propose(
        ProposalType pType,
        string calldata title,
        string calldata description,
        uint256 p1, uint256 p2, uint256 p3, uint256 p4, uint256 p5,
        address pAddr,
        bool    pBool
    ) external whenNotPaused nonReentrant returns (uint256) {
        _applyPendingParams();

        require(bytes(title).length > 0,       "Title is required");
        require(bytes(title).length <= 100,    "Title exceeds 100 characters");
        require(bytes(description).length > 0, "Description is required");

        // Threshold checked against current balance (proposal creation moment)
        require(
            currentVotingPower(msg.sender) > proposalThreshold,
            "Insufficient voting power"
        );

        // Type-specific validations
        if (pType == ProposalType.UPDATE_BASKET_WEIGHTS ||
            pType == ProposalType.UPDATE_ORACLE_WEIGHTS) {
            require(p1 + p2 + p3 + p4 + p5 == 10_000, "Weights must sum to 10000");
        }
        if (pType == ProposalType.SET_TRANSFER_FEE) {
            require(p1 <= 100,           "Fee exceeds maximum (1%)");
            require(pAddr != address(0), "Fee recipient cannot be zero address");
        }
        if (pType == ProposalType.SET_ORACLE) {
            require(pAddr != address(0), "Oracle cannot be zero address");
        }

        // FIX PRE-01: snapshot is the block BEFORE proposal creation.
        // This prevents the proposer from self-delegating in the same tx.
        uint256 snapshot = block.number - 1;

        uint256 id = ++proposalCount;
        proposals[id] = Proposal({
            id:                id,
            proposer:          msg.sender,
            pType:             pType,
            title:             title,
            description:       description,
            votesFor:          0,
            votesAgainst:      0,
            votesAbstain:      0,
            startTime:         block.timestamp,
            endTime:           block.timestamp + votingPeriod,
            snapshotBlock:     snapshot,
            queuedAt:          0,
            executionDeadline: 0,
            state:             ProposalState.Active,
            param1:            p1,
            param2:            p2,
            param3:            p3,
            param4:            p4,
            param5:            p5,
            paramAddr:         pAddr,
            paramBool:         pBool
        });

        proposalsByProposer[msg.sender].push(id);

        emit ProposalCreated(id, msg.sender, pType, title, block.timestamp + votingPeriod, snapshot);
        return id;
    }

    // ================================================================
    //  VOTING  (FIX PRE-01: power read from snapshot, not live balance)
    // ================================================================

    function castVote(
        uint256 proposalId,
        uint8   support,
        string calldata reason
    ) external nonReentrant {
        require(support >= 1 && support <= 3, "Support must be 1 (for), 2 (against), or 3 (abstain)");

        Proposal storage p = proposals[proposalId];
        require(p.id != 0,                          "Proposal does not exist");
        require(p.state == ProposalState.Active,    "Proposal is not active");
        require(block.timestamp <= p.endTime,       "Voting period has ended");
        require(votes[proposalId][msg.sender] == 0, "Already voted");

        // FIX PRE-01: use snapshot block, not current block
        uint256 power = votingPowerAt(msg.sender, p.snapshotBlock);
        require(power > 0, "No voting power at snapshot");

        votes[proposalId][msg.sender] = support;

        if      (support == 1) p.votesFor     += power;
        else if (support == 2) p.votesAgainst += power;
        else                   p.votesAbstain  += power;

        emit VoteCast(proposalId, msg.sender, support, power, reason);
    }

    // ================================================================
    //  FINALIZATION
    // ================================================================

    function finalize(uint256 proposalId) external nonReentrant {
        Proposal storage p = proposals[proposalId];
        require(p.id != 0,                       "Proposal does not exist");
        require(p.state == ProposalState.Active, "Proposal is not active");
        require(block.timestamp > p.endTime,     "Voting period is still active");

        uint256 totalVotes   = p.votesFor + p.votesAgainst + p.votesAbstain;

        // FIX PRE-01: quorum against past total supply at snapshot
        uint256 quorumNeeded = IQRDT(qrdtToken).getPastTotalSupply(p.snapshotBlock)
            * quorumPct / 100;

        if (totalVotes < quorumNeeded) {
            p.state = ProposalState.Defeated;
            totalDefeated++;
            emit ProposalDefeated(proposalId, "Quorum not reached");
            return;
        }

        if (p.votesFor <= p.votesAgainst) {
            p.state = ProposalState.Defeated;
            totalDefeated++;
            emit ProposalDefeated(proposalId, "Majority voted against");
            return;
        }

        p.state             = ProposalState.Queued;
        p.queuedAt          = block.timestamp;
        p.executionDeadline = block.timestamp + timelockPeriod + 7 days;

        emit ProposalQueued(proposalId, block.timestamp + timelockPeriod);
    }

    // ================================================================
    //  EXECUTION
    // ================================================================

    function execute(uint256 proposalId) external nonReentrant whenNotPaused {
        Proposal storage p = proposals[proposalId];
        require(p.id != 0,                       "Proposal does not exist");
        require(p.state == ProposalState.Queued, "Proposal is not queued");
        require(block.timestamp >= p.queuedAt + timelockPeriod, "Timelock is still active");
        require(block.timestamp <= p.executionDeadline,         "Proposal has expired");

        _executeProposal(p);

        p.state = ProposalState.Executed;
        totalExecuted++;
        emit ProposalExecuted(proposalId);
    }

    /// @dev FIX PRE-02: UPDATE_BASKET_WEIGHTS branch added.
    ///      All 8 proposal types now have explicit handling.
    ///      Unrecognised type reverts — no silent no-ops.
    function _executeProposal(Proposal storage p) internal {
        if (p.pType == ProposalType.GENERAL) {
            return;

        } else if (p.pType == ProposalType.UPDATE_BASKET_WEIGHTS) {
            // FIX PRE-02: was missing — basket weight change on oracle contract
            IOracle(oracleContract).updateWeights(
                p.param1, p.param2, p.param3, p.param4, p.param5
            );

        } else if (p.pType == ProposalType.UPDATE_ORACLE_WEIGHTS) {
            IOracle(oracleContract).updateWeights(
                p.param1, p.param2, p.param3, p.param4, p.param5
            );

        } else if (p.pType == ProposalType.PAUSE_TOKEN) {
            IQRDT(qrdtToken).pause();

        } else if (p.pType == ProposalType.UNPAUSE_TOKEN) {
            IQRDT(qrdtToken).unpause();

        } else if (p.pType == ProposalType.SET_TRANSFER_FEE) {
            IQRDT(qrdtToken).setTransferFee(p.param1, p.paramAddr);

        } else if (p.pType == ProposalType.SET_ORACLE) {
            IQRDT(qrdtToken).setOracle(p.paramAddr);

        } else if (p.pType == ProposalType.ORACLE_FALLBACK) {
            if (p.paramBool) {
                IOracle(oracleContract).activateFallback(p.param1);
            } else {
                IOracle(oracleContract).deactivateFallback();
            }

        } else {
            revert("Unknown proposal type");
        }
    }

    // ================================================================
    //  CANCELLATION
    // ================================================================

    /// @notice Proposer can cancel their own proposal before any vote is cast
    /// @dev    Once voting starts (votesFor + votesAgainst + votesAbstain > 0),
    ///         only the guardian can cancel. This prevents a proposer from
    ///         retracting a losing vote mid-flight.
    function cancelByProposer(uint256 proposalId, string calldata reason)
        external
        nonReentrant
    {
        Proposal storage p = proposals[proposalId];
        require(p.id != 0,                       "Proposal does not exist");
        require(p.state == ProposalState.Active, "Proposal is not active");
        require(p.proposer == msg.sender,        "Only proposer can cancel");
        require(block.timestamp <= p.endTime,    "Voting period has ended");
        require(
            p.votesFor + p.votesAgainst + p.votesAbstain == 0,
            "Cannot cancel after voting has started"
        );

        p.state = ProposalState.Cancelled;
        emit ProposalCancelled(proposalId, msg.sender, reason);
    }

    /// @notice Guardian can cancel any active or queued proposal (emergency)
    function cancel(uint256 proposalId, string calldata reason)
        external
        onlyRole(GUARDIAN_ROLE)
    {
        Proposal storage p = proposals[proposalId];
        require(
            p.state == ProposalState.Active || p.state == ProposalState.Queued,
            "Proposal cannot be cancelled in current state"
        );
        p.state = ProposalState.Cancelled;
        emit ProposalCancelled(proposalId, msg.sender, reason);
    }

    // ================================================================
    //  GOVERNANCE PARAMETERS
    // ================================================================

    function updateGovernanceParams(
        uint256 _votingPeriod,
        uint256 _timelockPeriod,
        uint256 _quorumPct
    ) external onlyRole(DEFAULT_ADMIN_ROLE) {
        require(_votingPeriod   >= 1 days  && _votingPeriod   <= 14 days, "Voting period must be 1-14 days");
        require(_timelockPeriod >= 6 hours && _timelockPeriod <= 7 days,  "Timelock must be 6h-7 days");
        require(_quorumPct      >= 1       && _quorumPct      <= 50,      "Quorum must be 1-50%");

        pendingVotingPeriod     = _votingPeriod;
        pendingTimelockPeriod   = _timelockPeriod;
        pendingQuorumPct        = _quorumPct;
        pendingParamsActiveFrom = block.timestamp + 48 hours;

        emit GovernanceParamsQueued(
            _votingPeriod, _timelockPeriod, _quorumPct,
            pendingParamsActiveFrom
        );
    }

    function _applyPendingParams() internal {
        if (pendingParamsActiveFrom > 0 && block.timestamp >= pendingParamsActiveFrom) {
            votingPeriod            = pendingVotingPeriod;
            timelockPeriod          = pendingTimelockPeriod;
            quorumPct               = pendingQuorumPct;
            pendingParamsActiveFrom = 0;
        }
    }

    function setContracts(address _token, address _oracle)
        external
        onlyRole(DEFAULT_ADMIN_ROLE)
    {
        if (_token  != address(0)) qrdtToken      = _token;
        if (_oracle != address(0)) oracleContract = _oracle;
    }

    function pause()   external onlyRole(GUARDIAN_ROLE) { _pause();   }
    function unpause() external onlyRole(GUARDIAN_ROLE) { _unpause(); }

    // ================================================================
    //  VIEWS
    // ================================================================

    function getProposal(uint256 id) external view returns (
        address       proposer,
        string memory title,
        string memory description,
        uint256       votesFor,
        uint256       votesAgainst,
        uint256       votesAbstain,
        uint256       endTime,
        uint256       snapshotBlock,
        ProposalState state,
        ProposalType  pType
    ) {
        Proposal storage p = proposals[id];
        return (
            p.proposer, p.title, p.description,
            p.votesFor, p.votesAgainst, p.votesAbstain,
            p.endTime, p.snapshotBlock, p.state, p.pType
        );
    }

    function getVote(uint256 proposalId, address voter) external view returns (uint8) {
        return votes[proposalId][voter];
    }

    function getProposalsByProposer(address proposer) external view returns (uint256[] memory) {
        return proposalsByProposer[proposer];
    }

    function quorumRequired() external view returns (uint256) {
        return IQRDT(qrdtToken).totalSupply() * quorumPct / 100;
    }
}
