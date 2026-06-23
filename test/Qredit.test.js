// ============================================================
//  Qredit (QRDT) Token — Test Suite
// ============================================================

const { expect }       = require("chai");
const { ethers }       = require("hardhat");
const { time }         = require("@nomicfoundation/hardhat-network-helpers");

const PRECISION         = 100_000_000n;
const TARGET_PRICE      = 100_000_000n;
const MIN_RESERVE_RATIO = 150_000_000n;  // 150% in 1e8
const MINT_AMOUNT       = ethers.parseEther("1000");
const RESERVE_USD8      = 2_000_000_00n; // $200 reserve (8 dec)

describe("Qredit (QRDT)", function () {
  let token, oracle, admin, minter, stabilizer, reserve, pauser, user, other;
  let mockUSD, mockEUR, mockJPY, mockGBP, mockXAU;

  // Roles
  let MINTER_ROLE, STABILIZER_ROLE, RESERVE_ROLE, PAUSER_ROLE, UPDATER_ROLE;

  async function deployOracle() {
    const Mock = await ethers.getContractFactory("MockAggregatorV3");
    mockUSD = await Mock.deploy(100_000_000n);
    mockEUR = await Mock.deploy(108_000_000n);
    mockJPY = await Mock.deploy(670_000n);
    mockGBP = await Mock.deploy(126_000_000n);
    mockXAU = await Mock.deploy(230_000_000_000n);

    const Oracle = await ethers.getContractFactory("QRDTBasketOracle");
    const orc = await Oracle.deploy(
      admin.address,
      await mockUSD.getAddress(),
      await mockEUR.getAddress(),
      await mockJPY.getAddress(),
      await mockGBP.getAddress(),
      await mockXAU.getAddress()
    );
    UPDATER_ROLE = ethers.keccak256(ethers.toUtf8Bytes("UPDATER_ROLE"));
    await orc.grantRole(UPDATER_ROLE, admin.address);
    await orc.connect(admin).updatePrice();
    return orc;
  }

  async function addReserveAndMint(tk, orc, to, amount) {
    // Deploy a mock ERC20 as reserve asset
    const ERC20 = await ethers.getContractFactory("MockERC20");
    const asset  = await ERC20.deploy("USD Coin", "USDC", 18);
    await asset.mint(reserve.address, ethers.parseEther("1000000"));
    await tk.connect(admin).addReserveAsset(
      await asset.getAddress(), "USDC", 100_000_000n, true
    );
    // Approve and deposit
    await asset.connect(reserve).approve(await tk.getAddress(), ethers.parseEther("1000000"));
    await tk.connect(reserve).depositReserve(await asset.getAddress(), ethers.parseEther("1000000"));
    // Mint
    await tk.connect(minter).mintBacked(to, amount);
    return asset;
  }

  beforeEach(async function () {
    [admin, minter, stabilizer, reserve, pauser, user, other] = await ethers.getSigners();

    oracle = await deployOracle();

    const Token = await ethers.getContractFactory("Qredit");
    token = await Token.deploy(admin.address, await oracle.getAddress());

    MINTER_ROLE     = ethers.keccak256(ethers.toUtf8Bytes("MINTER_ROLE"));
    STABILIZER_ROLE = ethers.keccak256(ethers.toUtf8Bytes("STABILIZER_ROLE"));
    RESERVE_ROLE    = ethers.keccak256(ethers.toUtf8Bytes("RESERVE_ROLE"));
    PAUSER_ROLE     = ethers.keccak256(ethers.toUtf8Bytes("PAUSER_ROLE"));

    await token.grantRole(MINTER_ROLE,     minter.address);
    await token.grantRole(STABILIZER_ROLE, stabilizer.address);
    await token.grantRole(RESERVE_ROLE,    reserve.address);
    await token.grantRole(PAUSER_ROLE,     pauser.address);
  });

  // ── Deployment ───────────────────────────────────────────────
  describe("Deployment", function () {
    it("has correct name and symbol", async function () {
      expect(await token.name()).to.equal("Qredit");
      expect(await token.symbol()).to.equal("QRDT");
    });

    it("has correct version", async function () {
      expect(await token.VERSION()).to.equal("2.0.0");
    });

    it("starts with zero supply", async function () {
      expect(await token.totalSupply()).to.equal(0n);
    });

    it("fee is zero by default", async function () {
      expect(await token.transferFeeBps()).to.equal(0n);
    });
  });

  // ── Reserve management ───────────────────────────────────────
  describe("Reserve management", function () {
    let asset;

    beforeEach(async function () {
      const ERC20 = await ethers.getContractFactory("MockERC20");
      asset = await ERC20.deploy("USD Coin", "USDC", 18);
      await asset.mint(reserve.address, ethers.parseEther("1000000"));
    });

    it("admin can add reserve asset", async function () {
      await expect(
        token.connect(admin).addReserveAsset(await asset.getAddress(), "USDC", 100_000_000n, true)
      ).to.emit(token, "ReserveAssetAdded");
    });

    it("reverts adding same asset twice", async function () {
      await token.connect(admin).addReserveAsset(await asset.getAddress(), "USDC", 100_000_000n, true);
      await expect(
        token.connect(admin).addReserveAsset(await asset.getAddress(), "USDC", 100_000_000n, true)
      ).to.be.revertedWith("Asset already registered");
    });

    it("reserve role can deposit", async function () {
      await token.connect(admin).addReserveAsset(await asset.getAddress(), "USDC", 100_000_000n, true);
      await asset.connect(reserve).approve(await token.getAddress(), ethers.parseEther("1000"));
      await expect(
        token.connect(reserve).depositReserve(await asset.getAddress(), ethers.parseEther("1000"))
      ).to.emit(token, "ReserveDeposited");
    });

    it("non-reserve-role cannot deposit", async function () {
      await token.connect(admin).addReserveAsset(await asset.getAddress(), "USDC", 100_000_000n, true);
      await asset.connect(other).approve(await token.getAddress(), ethers.parseEther("1000"));
      await expect(
        token.connect(other).depositReserve(await asset.getAddress(), ethers.parseEther("1000"))
      ).to.be.revertedWithCustomError(token, "AccessControlUnauthorizedAccount");
    });

    it("withdrawal maintains minimum reserve ratio", async function () {
      await token.connect(admin).addReserveAsset(await asset.getAddress(), "USDC", 100_000_000n, true);
      await asset.connect(reserve).approve(await token.getAddress(), ethers.parseEther("1000000"));
      await token.connect(reserve).depositReserve(await asset.getAddress(), ethers.parseEther("1000000"));

      // Mint 100 QRDT
      await token.connect(minter).mintBacked(user.address, ethers.parseEther("100"));

      // Try to withdraw too much
      await expect(
        token.connect(reserve).withdrawReserve(await asset.getAddress(), ethers.parseEther("999999"))
      ).to.be.revertedWith("Withdrawal would break minimum reserve ratio");
    });
  });

  // ── Minting ──────────────────────────────────────────────────
  describe("Minting — backed", function () {
    it("minter can mint backed QRDT with sufficient reserve", async function () {
      await addReserveAndMint(token, oracle, user.address, MINT_AMOUNT);
      expect(await token.balanceOf(user.address)).to.equal(MINT_AMOUNT);
    });

    it("emits MintBacked event", async function () {
      const ERC20 = await ethers.getContractFactory("MockERC20");
      const asset  = await ERC20.deploy("USD Coin", "USDC", 18);
      await asset.mint(reserve.address, ethers.parseEther("1000000"));
      await token.connect(admin).addReserveAsset(await asset.getAddress(), "USDC", 100_000_000n, true);
      await asset.connect(reserve).approve(await token.getAddress(), ethers.parseEther("1000000"));
      await token.connect(reserve).depositReserve(await asset.getAddress(), ethers.parseEther("1000000"));

      await expect(token.connect(minter).mintBacked(user.address, MINT_AMOUNT))
        .to.emit(token, "MintBacked");
    });

    it("reverts without MINTER_ROLE", async function () {
      await expect(token.connect(other).mintBacked(user.address, MINT_AMOUNT))
        .to.be.revertedWithCustomError(token, "AccessControlUnauthorizedAccount");
    });

    it("reverts if reserve ratio would fall below 150%", async function () {
      // No reserve deposited
      await expect(token.connect(minter).mintBacked(user.address, MINT_AMOUNT))
        .to.be.revertedWith("Insufficient reserves (minimum 150%)");
    });

    it("reverts if minting zero", async function () {
      await expect(token.connect(minter).mintBacked(user.address, 0n))
        .to.be.revertedWith("Amount must be positive");
    });

    it("reverts above MAX_MINT_PER_TX", async function () {
      const overLimit = ethers.parseEther("1000001");
      await expect(token.connect(minter).mintBacked(user.address, overLimit))
        .to.be.revertedWith("Exceeds per-transaction mint limit");
    });
  });

  describe("Minting — algorithmic", function () {
    it("stabilizer can mint algorithmically up to 20%", async function () {
      await addReserveAndMint(token, oracle, user.address, ethers.parseEther("800"));
      // 20% of 1000 total = 200 QRDT algorithmic
      await expect(
        token.connect(stabilizer).mintAlgorithmic(user.address, ethers.parseEther("200"))
      ).to.emit(token, "MintAlgorithmic");
    });

    it("reverts if algorithmic ratio would exceed 20%", async function () {
      await addReserveAndMint(token, oracle, user.address, ethers.parseEther("800"));
      await expect(
        token.connect(stabilizer).mintAlgorithmic(user.address, ethers.parseEther("201"))
      ).to.be.revertedWith("Exceeds algorithmic supply limit (20%)");
    });
  });

  // ── Burning ──────────────────────────────────────────────────
  describe("Burning", function () {
    beforeEach(async function () {
      await addReserveAndMint(token, oracle, user.address, MINT_AMOUNT);
    });

    it("user can burn their own tokens", async function () {
      await expect(token.connect(user).burn(MINT_AMOUNT))
        .to.emit(token, "Burned");
      expect(await token.balanceOf(user.address)).to.equal(0n);
    });

    it("burnFrom requires allowance", async function () {
      await token.connect(user).approve(other.address, MINT_AMOUNT);
      await expect(token.connect(other).burnFrom(user.address, MINT_AMOUNT))
        .to.emit(token, "Burned");
    });

    it("burnFrom reverts without allowance", async function () {
      await expect(token.connect(other).burnFrom(user.address, MINT_AMOUNT))
        .to.be.reverted;
    });
  });

  // ── Transfer fee ─────────────────────────────────────────────
  describe("Transfer fee", function () {
    beforeEach(async function () {
      await addReserveAndMint(token, oracle, user.address, MINT_AMOUNT);
    });

    it("admin can set transfer fee up to 1%", async function () {
      await token.connect(admin).setTransferFee(50n, admin.address); // 0.5%
      expect(await token.transferFeeBps()).to.equal(50n);
    });

    it("reverts if fee exceeds 1% (100 bps)", async function () {
      await expect(token.connect(admin).setTransferFee(101n, admin.address))
        .to.be.revertedWith("Fee exceeds maximum (1%)");
    });

    it("fee is deducted on transfer", async function () {
      await token.connect(admin).setTransferFee(100n, admin.address); // 1%
      const sendAmount = ethers.parseEther("100");
      const expectedFee = sendAmount / 100n;
      const expectedReceived = sendAmount - expectedFee;

      await token.connect(user).transfer(other.address, sendAmount);
      expect(await token.balanceOf(other.address)).to.equal(expectedReceived);
    });

    it("fee-exempt addresses skip fee", async function () {
      await token.connect(admin).setTransferFee(100n, admin.address);
      await token.connect(admin).setFeeExempt(user.address, true);

      const sendAmount = ethers.parseEther("100");
      await token.connect(user).transfer(other.address, sendAmount);
      expect(await token.balanceOf(other.address)).to.equal(sendAmount);
    });
  });

  // ── Pause ────────────────────────────────────────────────────
  describe("Pause", function () {
    it("pauser can pause and unpause", async function () {
      await token.connect(pauser).pause();
      expect(await token.paused()).to.be.true;

      await token.connect(pauser).unpause();
      expect(await token.paused()).to.be.false;
    });

    it("minting is blocked when paused", async function () {
      await token.connect(pauser).pause();
      await expect(
        token.connect(minter).mintBacked(user.address, MINT_AMOUNT)
      ).to.be.revertedWithCustomError(token, "EnforcedPause");
    });
  });

  // ── System status ────────────────────────────────────────────
  describe("systemStatus", function () {
    it("returns correct state before minting", async function () {
      const [supply, backed, algo, reserveUSD, , , paused] = await token.systemStatus();
      expect(supply).to.equal(0n);
      expect(backed).to.equal(0n);
      expect(algo).to.equal(0n);
      expect(paused).to.be.false;
    });

    it("reflects minted supply", async function () {
      await addReserveAndMint(token, oracle, user.address, MINT_AMOUNT);
      const [supply, backed] = await token.systemStatus();
      expect(supply).to.equal(MINT_AMOUNT);
      expect(backed).to.equal(MINT_AMOUNT);
    });
  });

  // ── Oracle staleness ─────────────────────────────────────────
  describe("Oracle integration", function () {
    it("mintBacked reverts with stale oracle", async function () {
      const ERC20 = await ethers.getContractFactory("MockERC20");
      const asset  = await ERC20.deploy("USD Coin", "USDC", 18);
      await asset.mint(reserve.address, ethers.parseEther("1000000"));
      await token.connect(admin).addReserveAsset(await asset.getAddress(), "USDC", 100_000_000n, true);
      await asset.connect(reserve).approve(await token.getAddress(), ethers.parseEther("1000000"));
      await token.connect(reserve).depositReserve(await asset.getAddress(), ethers.parseEther("1000000"));

      // Advance time past ORACLE_TIMEOUT (2 hours).
      // The oracle modifier checks lastOracleUpdate on the token, which was set
      // at deploy time. After 2h it exceeds ORACLE_TIMEOUT and reverts.
      // Note: the oracle.getPrice() may also return valid=false (stale feed),
      // which triggers "Oracle: price not valid" first. We accept either revert.
      await time.increase(7201);

      await expect(token.connect(minter).mintBacked(user.address, MINT_AMOUNT))
        .to.be.reverted;
    });
  });
});