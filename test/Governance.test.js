const { expect }    = require("chai");
const { ethers }    = require("hardhat");
const { time }      = require("@nomicfoundation/hardhat-network-helpers");
const { anyValue }  = require("@nomicfoundation/hardhat-chai-matchers");

const VOTING_PERIOD = 3 * 24 * 3600;
const TIMELOCK      = 1 * 24 * 3600;

describe("QRDTGovernance", function () {
  let token, oracle, gov;
  let admin, guardian, voter1, voter2, voter3, other;

  const ProposalType = {
    UPDATE_BASKET_WEIGHTS: 0,
    UPDATE_ORACLE_WEIGHTS: 1,
    PAUSE_TOKEN:           2,
    UNPAUSE_TOKEN:         3,
    SET_TRANSFER_FEE:      4,
    SET_ORACLE:            5,
    ORACLE_FALLBACK:       6,
    GENERAL:               7,
  };

  const ProposalState = {
    Active:    0,
    Defeated:  1,
    Succeeded: 2,
    Queued:    3,
    Executed:  4,
    Cancelled: 5,
    Expired:   6,
  };

  async function deployAll() {
    const Mock = await ethers.getContractFactory("MockAggregatorV3");
    const mUSD = await Mock.deploy(100_000_000n);
    const mEUR = await Mock.deploy(108_000_000n);
    const mJPY = await Mock.deploy(670_000n);
    const mGBP = await Mock.deploy(126_000_000n);
    const mXAU = await Mock.deploy(230_000_000_000n);

    const Oracle = await ethers.getContractFactory("QRDTBasketOracle");
    const orc = await Oracle.deploy(
      admin.address,
      await mUSD.getAddress(), await mEUR.getAddress(),
      await mJPY.getAddress(), await mGBP.getAddress(), await mXAU.getAddress()
    );
    const UPDATER = ethers.keccak256(ethers.toUtf8Bytes("UPDATER_ROLE"));
    await orc.grantRole(UPDATER, admin.address);
    await orc.connect(admin).updatePrice();

    const Token = await ethers.getContractFactory("Qredit");
    const tk = await Token.deploy(admin.address, await orc.getAddress());

    const Gov = await ethers.getContractFactory("QRDTGovernance");
    const gv = await Gov.deploy(admin.address, await tk.getAddress(), await orc.getAddress());

    // Reserve asset setup
    const ERC20  = await ethers.getContractFactory("MockERC20");
    const asset  = await ERC20.deploy("USDC", "USDC", 18);
    await asset.mint(admin.address, ethers.parseEther("10000000"));

    const MINTER  = ethers.keccak256(ethers.toUtf8Bytes("MINTER_ROLE"));
    const RESERVE = ethers.keccak256(ethers.toUtf8Bytes("RESERVE_ROLE"));
    const PAUSER  = ethers.keccak256(ethers.toUtf8Bytes("PAUSER_ROLE"));
    const STAB    = ethers.keccak256(ethers.toUtf8Bytes("STABILIZER_ROLE"));
    const GUARD   = ethers.keccak256(ethers.toUtf8Bytes("GUARDIAN_ROLE"));
    const ADMIN   = ethers.ZeroHash; // DEFAULT_ADMIN_ROLE

    await tk.grantRole(MINTER,  admin.address);
    await tk.grantRole(RESERVE, admin.address);

    // Grant governance the roles it needs to execute proposals
    await tk.grantRole(PAUSER,  await gv.getAddress());  // for PAUSE_TOKEN
    await tk.grantRole(STAB,    await gv.getAddress());  // for stabilization
    await tk.grantRole(ADMIN,   await gv.getAddress());  // for SET_TRANSFER_FEE, SET_ORACLE
    await orc.grantRole(GUARD,  await gv.getAddress());  // for ORACLE_FALLBACK
    await orc.grantRole(ADMIN,  await gv.getAddress());  // for UPDATE_BASKET_WEIGHTS

    await tk.connect(admin).addReserveAsset(await asset.getAddress(), "USDC", 100_000_000n, true);
    await asset.connect(admin).approve(await tk.getAddress(), ethers.parseEther("10000000"));
    await tk.connect(admin).depositReserve(await asset.getAddress(), ethers.parseEther("10000000"));

    for (const v of [voter1, voter2, voter3]) {
      await tk.connect(admin).mintBacked(v.address, ethers.parseEther("10000"));
    }

    // Self-delegate to activate ERC20Votes checkpoints
    for (const v of [voter1, voter2, voter3]) {
      await tk.connect(v).delegate(v.address);
    }

    // Mine one block so snapshot block (block.number - 1) exists
    await ethers.provider.send("evm_mine", []);

    return { orc, tk, gv };
  }

  async function createGeneralProposal(gv, proposer) {
    return gv.connect(proposer).propose(
      ProposalType.GENERAL,
      "Test proposal",
      "A test governance proposal",
      0n, 0n, 0n, 0n, 0n,
      ethers.ZeroAddress,
      false
    );
  }

  async function passAndQueue(gv, proposalId) {
    await gv.connect(voter1).castVote(proposalId, 1, "");
    await gv.connect(voter2).castVote(proposalId, 1, "");
    await gv.connect(voter3).castVote(proposalId, 1, "");
    await time.increase(VOTING_PERIOD + 1);
    await gv.finalize(proposalId);
  }

  beforeEach(async function () {
    [admin, guardian, voter1, voter2, voter3, other] = await ethers.getSigners();
    const deployed = await deployAll();
    oracle = deployed.orc;
    token  = deployed.tk;
    gov    = deployed.gv;
  });

  // ── Deployment ───────────────────────────────────────────────
  describe("Deployment", function () {
    it("sets correct initial parameters", async function () {
      expect(await gov.votingPeriod()).to.equal(BigInt(VOTING_PERIOD));
      expect(await gov.timelockPeriod()).to.equal(BigInt(TIMELOCK));
      expect(await gov.quorumPct()).to.equal(10n);
    });

    it("stores governed contract addresses", async function () {
      expect(await gov.qrdtToken()).to.equal(await token.getAddress());
      expect(await gov.oracleContract()).to.equal(await oracle.getAddress());
    });
  });

  // ── ERC20Votes delegation ────────────────────────────────────
  describe("ERC20Votes delegation", function () {
    it("voter has voting power after self-delegating", async function () {
      const balance = await token.balanceOf(voter1.address);
      await ethers.provider.send("evm_mine", []);
      const block = await ethers.provider.getBlockNumber();
      const past  = await token.getPastVotes(voter1.address, block - 1);
      expect(past).to.equal(balance);
    });

    it("undelegated address has zero past votes", async function () {
      await ethers.provider.send("evm_mine", []);
      const block = await ethers.provider.getBlockNumber();
      const past  = await token.getPastVotes(other.address, block - 1);
      expect(past).to.equal(0n);
    });

    it("delegating to another transfers voting power", async function () {
      await token.connect(voter1).delegate(voter2.address);
      await ethers.provider.send("evm_mine", []);
      const block = await ethers.provider.getBlockNumber();
      const power = await token.getPastVotes(voter2.address, block - 1);
      expect(power).to.be.gt(await token.balanceOf(voter2.address));
    });
  });

  // ── Proposal creation ────────────────────────────────────────
  describe("Proposal creation", function () {
    it("creates a GENERAL proposal and emits event", async function () {
      // ProposalCreated: verify emission and key args without anyValue for uint256
      const tx      = await createGeneralProposal(gov, voter1);
      const receipt = await tx.wait();
      const log     = receipt.logs.find(l => {
        try { return gov.interface.parseLog(l)?.name === "ProposalCreated"; }
        catch { return false; }
      });
      expect(log).to.not.be.undefined;
      const parsed = gov.interface.parseLog(log);
      expect(parsed.args.id).to.equal(1n);
      expect(parsed.args.proposer).to.equal(voter1.address);
      expect(parsed.args.pType).to.equal(BigInt(ProposalType.GENERAL));
      expect(parsed.args.title).to.equal("Test proposal");
    });

    it("records snapshotBlock", async function () {
      await createGeneralProposal(gov, voter1);
      const [,,,,,,,snapshot] = await gov.getProposal(1n);
      expect(snapshot).to.be.gt(0n);
    });

    it("increments proposalCount", async function () {
      await createGeneralProposal(gov, voter1);
      expect(await gov.proposalCount()).to.equal(1n);
    });

    it("reverts with empty title", async function () {
      await expect(
        gov.connect(voter1).propose(
          ProposalType.GENERAL, "", "description",
          0n, 0n, 0n, 0n, 0n, ethers.ZeroAddress, false
        )
      ).to.be.revertedWith("Title is required");
    });

    it("reverts with title over 100 chars", async function () {
      await expect(
        gov.connect(voter1).propose(
          ProposalType.GENERAL, "A".repeat(101), "description",
          0n, 0n, 0n, 0n, 0n, ethers.ZeroAddress, false
        )
      ).to.be.revertedWith("Title exceeds 100 characters");
    });

    it("reverts if caller has no tokens", async function () {
      await expect(createGeneralProposal(gov, other))
        .to.be.revertedWith("Insufficient voting power");
    });

    it("validates weight proposals must sum to 10000", async function () {
      await expect(
        gov.connect(voter1).propose(
          ProposalType.UPDATE_ORACLE_WEIGHTS, "Bad weights", "desc",
          4000n, 3000n, 1500n, 1000n, 600n,
          ethers.ZeroAddress, false
        )
      ).to.be.revertedWith("Weights must sum to 10000");
    });
  });

  // ── Voting ───────────────────────────────────────────────────
  describe("Voting", function () {
    let proposalId;

    beforeEach(async function () {
      await createGeneralProposal(gov, voter1);
      proposalId = 1n;
    });

    it("voter can vote FOR", async function () {
      await expect(gov.connect(voter1).castVote(proposalId, 1, ""))
        .to.emit(gov, "VoteCast");
    });

    it("voter can vote AGAINST", async function () {
      await expect(gov.connect(voter2).castVote(proposalId, 2, ""))
        .to.emit(gov, "VoteCast");
    });

    it("voter can ABSTAIN", async function () {
      await expect(gov.connect(voter3).castVote(proposalId, 3, ""))
        .to.emit(gov, "VoteCast");
    });

    it("cannot vote twice", async function () {
      await gov.connect(voter1).castVote(proposalId, 1, "");
      await expect(gov.connect(voter1).castVote(proposalId, 1, ""))
        .to.be.revertedWith("Already voted");
    });

    it("cannot vote after period ends", async function () {
      await time.increase(VOTING_PERIOD + 1);
      await expect(gov.connect(voter1).castVote(proposalId, 1, ""))
        .to.be.revertedWith("Voting period has ended");
    });

    it("reverts with invalid support value", async function () {
      await expect(gov.connect(voter1).castVote(proposalId, 4, ""))
        .to.be.revertedWith("Support must be 1 (for), 2 (against), or 3 (abstain)");
    });

    it("undelegated address cannot vote", async function () {
      await expect(gov.connect(other).castVote(proposalId, 1, ""))
        .to.be.revertedWith("No voting power at snapshot");
    });

    it("voting power fixed at snapshot — transfer after proposal does not affect vote", async function () {
      const balance = await token.balanceOf(voter1.address);
      await token.connect(voter1).transfer(other.address, balance);
      const [,,,,,,,snapshot] = await gov.getProposal(proposalId);
      const pastVotes = await token.getPastVotes(voter1.address, snapshot);
      expect(pastVotes).to.equal(balance);
      await expect(gov.connect(voter1).castVote(proposalId, 1, ""))
        .to.emit(gov, "VoteCast");
    });
  });

  // ── Finalization ─────────────────────────────────────────────
  describe("Finalization", function () {
    let proposalId;

    beforeEach(async function () {
      await createGeneralProposal(gov, voter1);
      proposalId = 1n;
    });

    it("queues when quorum and majority met", async function () {
      await passAndQueue(gov, proposalId);
      const [,,,,,,,, state] = await gov.getProposal(proposalId);
      expect(state).to.equal(ProposalState.Queued);
    });

    it("defeated when no votes cast", async function () {
      await time.increase(VOTING_PERIOD + 1);
      await gov.finalize(proposalId);
      const [,,,,,,,, state] = await gov.getProposal(proposalId);
      expect(state).to.equal(ProposalState.Defeated);
    });

    it("defeated when majority voted against", async function () {
      await gov.connect(voter1).castVote(proposalId, 2, "");
      await gov.connect(voter2).castVote(proposalId, 1, "");
      await gov.connect(voter3).castVote(proposalId, 2, "");
      await time.increase(VOTING_PERIOD + 1);
      await gov.finalize(proposalId);
      const [,,,,,,,, state] = await gov.getProposal(proposalId);
      expect(state).to.equal(ProposalState.Defeated);
    });

    it("cannot finalize before voting period ends", async function () {
      await expect(gov.finalize(proposalId))
        .to.be.revertedWith("Voting period is still active");
    });
  });

  // ── Execution ────────────────────────────────────────────────
  describe("Execution", function () {
    let proposalId;

    beforeEach(async function () {
      await createGeneralProposal(gov, voter1);
      proposalId = 1n;
      await passAndQueue(gov, proposalId);
    });

    it("executes GENERAL proposal after timelock", async function () {
      await time.increase(TIMELOCK + 1);
      await expect(gov.execute(proposalId)).to.emit(gov, "ProposalExecuted");
      const [,,,,,,,, state] = await gov.getProposal(proposalId);
      expect(state).to.equal(ProposalState.Executed);
    });

    it("reverts if executed before timelock", async function () {
      await expect(gov.execute(proposalId))
        .to.be.revertedWith("Timelock is still active");
    });

    it("reverts if executed after deadline", async function () {
      await time.increase(TIMELOCK + 7 * 24 * 3600 + 1);
      await expect(gov.execute(proposalId))
        .to.be.revertedWith("Proposal has expired");
    });

    it("executes PAUSE_TOKEN proposal", async function () {
      await gov.connect(voter1).propose(
        ProposalType.PAUSE_TOKEN, "Pause token", "Emergency pause",
        0n, 0n, 0n, 0n, 0n, ethers.ZeroAddress, false
      );
      const pid = await gov.proposalCount();
      await passAndQueue(gov, pid);
      await time.increase(TIMELOCK + 1);
      await gov.execute(pid);
      expect(await token.paused()).to.be.true;
    });

    it("executes SET_TRANSFER_FEE proposal", async function () {
      await gov.connect(voter1).propose(
        ProposalType.SET_TRANSFER_FEE, "Set fee", "Set 0.5% fee",
        50n, 0n, 0n, 0n, 0n, admin.address, false
      );
      const pid = await gov.proposalCount();
      await passAndQueue(gov, pid);
      await time.increase(TIMELOCK + 1);
      await gov.execute(pid);
      expect(await token.transferFeeBps()).to.equal(50n);
    });

    it("executes UPDATE_BASKET_WEIGHTS proposal (FIX PRE-02)", async function () {
      await gov.connect(voter1).propose(
        ProposalType.UPDATE_BASKET_WEIGHTS, "Rebalance basket", "Increase USD weight",
        5000n, 2500n, 1000n, 1000n, 500n,
        ethers.ZeroAddress, false
      );
      const pid = await gov.proposalCount();
      await passAndQueue(gov, pid);
      await time.increase(TIMELOCK + 1);
      await expect(gov.execute(pid)).to.emit(gov, "ProposalExecuted");
      expect(await oracle.weightUSD()).to.equal(5000n);
    });
  });

  // ── Cancellation ─────────────────────────────────────────────
  describe("Cancellation", function () {
    let proposalId;

    beforeEach(async function () {
      await createGeneralProposal(gov, voter1);
      proposalId = 1n;
    });

    it("proposer can cancel before any vote is cast", async function () {
      await gov.connect(voter1).cancelByProposer(proposalId, "Made an error");
      const [,,,,,,,, state] = await gov.getProposal(proposalId);
      expect(state).to.equal(ProposalState.Cancelled);
    });

    it("proposer cannot cancel after a vote is cast", async function () {
      await gov.connect(voter2).castVote(proposalId, 1, "");
      await expect(gov.connect(voter1).cancelByProposer(proposalId, "Too late"))
        .to.be.revertedWith("Cannot cancel after voting has started");
    });

    it("non-proposer cannot use cancelByProposer", async function () {
      await expect(gov.connect(voter2).cancelByProposer(proposalId, "not mine"))
        .to.be.revertedWith("Only proposer can cancel");
    });

    it("guardian can cancel active proposal regardless of votes", async function () {
      await gov.connect(voter1).castVote(proposalId, 1, "");
      await gov.connect(admin).cancel(proposalId, "Emergency");
      const [,,,,,,,, state] = await gov.getProposal(proposalId);
      expect(state).to.equal(ProposalState.Cancelled);
    });

    it("guardian can cancel queued proposal", async function () {
      await passAndQueue(gov, proposalId);
      await gov.connect(admin).cancel(proposalId, "Emergency");
      const [,,,,,,,, state] = await gov.getProposal(proposalId);
      expect(state).to.equal(ProposalState.Cancelled);
    });

    it("non-guardian cannot call cancel()", async function () {
      await expect(gov.connect(other).cancel(proposalId, "hack"))
        .to.be.revertedWithCustomError(gov, "AccessControlUnauthorizedAccount");
    });

    it("emits ProposalCancelled with proposer address", async function () {
      await expect(gov.connect(voter1).cancelByProposer(proposalId, "oops"))
        .to.emit(gov, "ProposalCancelled")
        .withArgs(proposalId, voter1.address, "oops");
    });
  });

  // ── Governance params ────────────────────────────────────────
  describe("Governance parameter updates", function () {
    it("queues parameter update with 48h delay", async function () {
      await expect(gov.updateGovernanceParams(5 * 24 * 3600, 2 * 24 * 3600, 15))
        .to.emit(gov, "GovernanceParamsQueued");
    });

    it("applies new params after 48h on next proposal creation", async function () {
      await gov.updateGovernanceParams(5 * 24 * 3600, 2 * 24 * 3600, 15);
      await time.increase(48 * 3600 + 1);
      await createGeneralProposal(gov, voter1);
      expect(await gov.votingPeriod()).to.equal(BigInt(5 * 24 * 3600));
      expect(await gov.quorumPct()).to.equal(15n);
    });

    it("reverts with out-of-range voting period", async function () {
      await expect(gov.updateGovernanceParams(30 * 24 * 3600, 1 * 24 * 3600, 10))
        .to.be.revertedWith("Voting period must be 1-14 days");
    });

    it("reverts with out-of-range quorum", async function () {
      await expect(gov.updateGovernanceParams(3 * 24 * 3600, 1 * 24 * 3600, 51))
        .to.be.revertedWith("Quorum must be 1-50%");
    });
  });
});

// ════════════════════════════════════════════════════════════════
//  QRDTKeeper
// ════════════════════════════════════════════════════════════════

describe("QRDTKeeper", function () {
  let keeper, oracle, admin, manager, other;

  beforeEach(async function () {
    [admin, manager, other] = await ethers.getSigners();

    const Mock = await ethers.getContractFactory("MockAggregatorV3");
    const mUSD = await Mock.deploy(100_000_000n);
    const mEUR = await Mock.deploy(108_000_000n);
    const mJPY = await Mock.deploy(670_000n);
    const mGBP = await Mock.deploy(126_000_000n);
    const mXAU = await Mock.deploy(230_000_000_000n);

    const Oracle = await ethers.getContractFactory("QRDTBasketOracle");
    oracle = await Oracle.deploy(
      admin.address,
      await mUSD.getAddress(), await mEUR.getAddress(),
      await mJPY.getAddress(), await mGBP.getAddress(), await mXAU.getAddress()
    );

    const Keeper = await ethers.getContractFactory("QRDTKeeper");
    keeper = await Keeper.deploy(admin.address, await oracle.getAddress(), 900);

    const UPDATER = ethers.keccak256(ethers.toUtf8Bytes("UPDATER_ROLE"));
    await oracle.grantRole(UPDATER, await keeper.getAddress());

    const MANAGER = ethers.keccak256(ethers.toUtf8Bytes("MANAGER_ROLE"));
    await keeper.grantRole(MANAGER, manager.address);

    // Do an initial oracle updatePrice so getPrice() returns a real timestamp.
    // Without this, fallbackSetAt=0 makes priceStale=true immediately,
    // causing checkUpkeep to return true even before the interval passes.
    await oracle.grantRole(UPDATER, admin.address);
    await oracle.connect(admin).updatePrice();
  });

  describe("Deployment", function () {
    it("sets correct update interval", async function () {
      expect(await keeper.updateInterval()).to.equal(900n);
    });

    it("sets maxPriceAge to 3x interval", async function () {
      expect(await keeper.maxPriceAge()).to.equal(2700n);
    });
  });

  describe("checkUpkeep", function () {
    it("returns false before interval passes", async function () {
      // Oracle has a valid recent price, interval=900s, no time passed
      const [needed] = await keeper.checkUpkeep("0x");
      expect(needed).to.be.false;
    });

    it("returns true after interval passes", async function () {
      await time.increase(901);
      const [needed] = await keeper.checkUpkeep("0x");
      expect(needed).to.be.true;
    });

    it("returns false when paused", async function () {
      await keeper.connect(manager).setPaused(true);
      await time.increase(901);
      const [needed] = await keeper.checkUpkeep("0x");
      expect(needed).to.be.false;
    });
  });

  describe("performUpkeep", function () {
    it("performs upkeep and increments counter", async function () {
      await time.increase(901);
      await keeper.performUpkeep("0x");
      expect(await keeper.upkeepCount()).to.equal(1n);
    });

    it("emits UpkeepPerformed event", async function () {
      await time.increase(901);
      await expect(keeper.performUpkeep("0x"))
        .to.emit(keeper, "UpkeepPerformed");
    });

    it("reverts if upkeep not needed", async function () {
      // No time has passed since deploy
      await expect(keeper.performUpkeep("0x"))
        .to.be.revertedWith("Upkeep not needed yet");
    });

    it("tracks failures gracefully when oracle is paused", async function () {
      const GUARDIAN = ethers.keccak256(ethers.toUtf8Bytes("GUARDIAN_ROLE"));
      await oracle.grantRole(GUARDIAN, admin.address);
      await oracle.connect(admin).pause();
      await time.increase(901);
      await keeper.performUpkeep("0x");
      expect(await keeper.failCount()).to.equal(1n);
    });
  });

  describe("Configuration", function () {
    it("manager can update config", async function () {
      await expect(keeper.connect(manager).setConfig(1800, 5400))
        .to.emit(keeper, "ConfigUpdated");
      expect(await keeper.updateInterval()).to.equal(1800n);
    });

    it("reverts if interval below minimum", async function () {
      await expect(keeper.connect(manager).setConfig(30, 100))
        .to.be.revertedWith("Minimum interval is 60 seconds");
    });

    it("reverts if maxAge not greater than interval", async function () {
      await expect(keeper.connect(manager).setConfig(900, 900))
        .to.be.revertedWith("maxAge must be greater than interval");
    });

    it("non-manager cannot update config", async function () {
      await expect(keeper.connect(other).setConfig(1800, 5400))
        .to.be.revertedWithCustomError(keeper, "AccessControlUnauthorizedAccount");
    });

    it("manager can update oracle address", async function () {
      await expect(keeper.connect(manager).setOracle(await oracle.getAddress()))
        .to.emit(keeper, "OracleUpdated");
    });
  });

  describe("keeperStatus view", function () {
    it("returns correct status fields", async function () {
      const [active, , count, fails, , interval] = await keeper.keeperStatus();
      expect(active).to.be.true;
      expect(count).to.equal(0n);
      expect(fails).to.equal(0n);
      expect(interval).to.equal(900n);
    });
  });
});