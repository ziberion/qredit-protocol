const { expect }     = require("chai");
const { ethers }     = require("hardhat");
const { time }       = require("@nomicfoundation/hardhat-network-helpers");

describe("QRDTBasketOracle", function () {
  let oracle, admin, updater, guardian, other;
  let mockUSD, mockEUR, mockJPY, mockGBP, mockXAU;

  beforeEach(async function () {
    [admin, updater, guardian, other] = await ethers.getSigners();

    const Mock = await ethers.getContractFactory("MockAggregatorV3");
    mockUSD = await Mock.deploy(100_000_000n);
    mockEUR = await Mock.deploy(108_000_000n);
    mockJPY = await Mock.deploy(670_000n);
    mockGBP = await Mock.deploy(126_000_000n);
    mockXAU = await Mock.deploy(230_000_000_000n);

    const Oracle = await ethers.getContractFactory("QRDTBasketOracle");
    oracle = await Oracle.deploy(
      admin.address,
      await mockUSD.getAddress(),
      await mockEUR.getAddress(),
      await mockJPY.getAddress(),
      await mockGBP.getAddress(),
      await mockXAU.getAddress()
    );

    const UPDATER_ROLE  = ethers.keccak256(ethers.toUtf8Bytes("UPDATER_ROLE"));
    const GUARDIAN_ROLE = ethers.keccak256(ethers.toUtf8Bytes("GUARDIAN_ROLE"));
    await oracle.grantRole(UPDATER_ROLE,  updater.address);
    await oracle.grantRole(GUARDIAN_ROLE, guardian.address);
  });

  // ── Deployment ───────────────────────────────────────────────
  describe("Deployment", function () {
    it("sets correct initial weights", async function () {
      expect(await oracle.weightUSD()).to.equal(4000n);
      expect(await oracle.weightEUR()).to.equal(3000n);
      expect(await oracle.weightJPY()).to.equal(1500n);
      expect(await oracle.weightGBP()).to.equal(1000n);
      expect(await oracle.weightXAU()).to.equal(500n);
    });

    it("starts in fallback mode", async function () {
      expect(await oracle.usingFallback()).to.be.true;
    });

    it("fallback price is BASKET_TARGET before first update", async function () {
      // fallbackSetAt = 0 at deploy, so MAX_FALLBACK_AGE check fails → valid = false
      // The price is still readable, but valid = false is correct behavior
      const [price, valid] = await oracle.getPrice();
      expect(price).to.equal(100_000_000n); // BASKET_TARGET
      // valid is false because fallbackSetAt = 0 (expired immediately)
      // This is intentional — forces a real updatePrice() before going live
      expect(valid).to.be.false;
    });

    it("fallback becomes valid after guardian sets it explicitly", async function () {
      await oracle.connect(guardian).activateFallback(100_000_000n);
      const [price, valid] = await oracle.getPrice();
      expect(price).to.equal(100_000_000n);
      expect(valid).to.be.true;
    });
  });

  // ── Price update ─────────────────────────────────────────────
  describe("updatePrice", function () {
    it("updates basket price and returns valid", async function () {
      await oracle.connect(updater).updatePrice();
      const [price, valid] = await oracle.getPrice();
      expect(valid).to.be.true;
      expect(price).to.be.gt(0n);
    });

    it("exits fallback mode after first update", async function () {
      await oracle.connect(updater).updatePrice();
      expect(await oracle.usingFallback()).to.be.false;
    });

    it("reverts if called without UPDATER_ROLE", async function () {
      await expect(oracle.connect(other).updatePrice())
        .to.be.revertedWithCustomError(oracle, "AccessControlUnauthorizedAccount");
    });

    it("reverts if USD feed fails", async function () {
      await mockUSD.setShouldRevert(true);
      await expect(oracle.connect(updater).updatePrice())
        .to.be.revertedWith("Critical feeds unavailable (USD/EUR)");
    });

    it("reverts if EUR feed fails", async function () {
      await mockEUR.setShouldRevert(true);
      await expect(oracle.connect(updater).updatePrice())
        .to.be.revertedWith("Critical feeds unavailable (USD/EUR)");
    });

    it("uses last known price when JPY feed fails", async function () {
      await oracle.connect(updater).updatePrice();
      await mockJPY.setShouldRevert(true);
      await oracle.connect(updater).updatePrice();
      const [price, valid] = await oracle.getPrice();
      expect(valid).to.be.true;
      expect(price).to.be.gt(0n);
    });

    it("triggers circuit breaker on >10% basket price jump", async function () {
      await oracle.connect(updater).updatePrice();

      // XAU (price 230B) accounts for ~99% of basket value due to its magnitude.
      // Moving USD/EUR/GBP is negligible. Must move XAU by >10% to trigger CB.
      // +12% on XAU → ~11.9% basket deviation → circuit breaker fires.
      await mockXAU.setPrice(257_600_000_000n); // +12%

      await expect(oracle.connect(updater).updatePrice())
        .to.emit(oracle, "CircuitBreakerTriggered");

      const [, valid] = await oracle.getPrice();
      expect(valid).to.be.false;
    });

    it("auto-resets circuit breaker when price normalizes", async function () {
      await oracle.connect(updater).updatePrice();

      // Trigger CB: XAU +12% causes >10% basket deviation
      await mockXAU.setPrice(257_600_000_000n);
      await oracle.connect(updater).updatePrice(); // CB fires, latest.price = inflated basket

      // Auto-reset condition: next basket must be within 5% of latest.price (the CB price).
      // Going back to original XAU (230B) produces 10.6% deviation — too large.
      // Use XAU at -3% from CB price (249.8B) → 3% basket deviation → auto-reset fires.
      await mockXAU.setPrice(249_872_000_000n);
      await oracle.connect(updater).updatePrice();

      const [, valid] = await oracle.getPrice();
      expect(valid).to.be.true;
    });

    it("emits PriceUpdated event", async function () {
      await expect(oracle.connect(updater).updatePrice())
        .to.emit(oracle, "PriceUpdated");
    });
  });

  // ── Staleness ────────────────────────────────────────────────
  describe("Price staleness", function () {
    it("returns invalid when price is stale (> 1 hour)", async function () {
      await oracle.connect(updater).updatePrice();
      await time.increase(3601);
      const [, valid] = await oracle.getPrice();
      expect(valid).to.be.false;
    });

    it("rejects stale feed data", async function () {
      const staleTime = (await ethers.provider.getBlock("latest")).timestamp - 7200;
      await mockUSD.setUpdatedAt(staleTime);
      await expect(oracle.connect(updater).updatePrice())
        .to.be.revertedWith("Critical feeds unavailable (USD/EUR)");
    });
  });

  // ── TWAP ─────────────────────────────────────────────────────
  describe("TWAP", function () {
    it("returns price with single snapshot", async function () {
      await oracle.connect(updater).updatePrice();
      const twap = await oracle.getTWAP(1);
      expect(twap).to.be.gt(0n);
    });

    it("accumulates price history correctly", async function () {
      for (let i = 0; i < 5; i++) {
        await oracle.connect(updater).updatePrice();
      }
      const twap = await oracle.getTWAP(5);
      expect(twap).to.be.gt(0n);
    });

    it("returns false for manipulation check with < 3 snapshots", async function () {
      await oracle.connect(updater).updatePrice();
      expect(await oracle.isPriceManipulated(300n)).to.be.false;
    });
  });

  // ── Fallback ─────────────────────────────────────────────────
  describe("Emergency fallback", function () {
    it("guardian can activate fallback", async function () {
      await oracle.connect(updater).updatePrice();
      await oracle.connect(guardian).activateFallback(100_000_000n);
      expect(await oracle.usingFallback()).to.be.true;
    });

    it("fallback price is returned from getPrice", async function () {
      await oracle.connect(guardian).activateFallback(99_000_000n);
      const [price, valid] = await oracle.getPrice();
      expect(price).to.equal(99_000_000n);
      expect(valid).to.be.true;
    });

    it("fallback expires after MAX_FALLBACK_AGE (4 hours)", async function () {
      await oracle.connect(guardian).activateFallback(100_000_000n);
      await time.increase(4 * 3600 + 1);
      const [, valid] = await oracle.getPrice();
      expect(valid).to.be.false;
    });

    it("non-guardian cannot activate fallback", async function () {
      await expect(oracle.connect(other).activateFallback(100_000_000n))
        .to.be.revertedWithCustomError(oracle, "AccessControlUnauthorizedAccount");
    });

    it("guardian can deactivate fallback", async function () {
      await oracle.connect(updater).updatePrice();
      await oracle.connect(guardian).activateFallback(100_000_000n);
      await oracle.connect(guardian).deactivateFallback();
      expect(await oracle.usingFallback()).to.be.false;
    });
  });

  // ── Weights ──────────────────────────────────────────────────
  describe("Weight management", function () {
    it("admin can update weights", async function () {
      await oracle.updateWeights(5000n, 2000n, 1500n, 1000n, 500n);
      expect(await oracle.weightUSD()).to.equal(5000n);
    });

    it("reverts if weights do not sum to 10000", async function () {
      await expect(oracle.updateWeights(5000n, 2000n, 1500n, 1000n, 600n))
        .to.be.revertedWith("Weights must sum to 10000");
    });

    it("non-admin cannot update weights", async function () {
      await expect(oracle.connect(other).updateWeights(5000n, 2000n, 1500n, 1000n, 500n))
        .to.be.revertedWithCustomError(oracle, "AccessControlUnauthorizedAccount");
    });
  });

  // ── Pause ────────────────────────────────────────────────────
  describe("Pause", function () {
    it("guardian can pause and unpause", async function () {
      await oracle.connect(guardian).pause();
      await expect(oracle.connect(updater).updatePrice())
        .to.be.revertedWithCustomError(oracle, "EnforcedPause");
      await oracle.connect(guardian).unpause();
      await expect(oracle.connect(updater).updatePrice()).to.not.be.reverted;
    });
  });
});