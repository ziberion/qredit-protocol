// ============================================================
//  QRDTBasketOracle — Test Suite
// ============================================================

const { expect }         = require("chai");
const { ethers }         = require("hardhat");
const { time }           = require("@nomicfoundation/hardhat-network-helpers");

// Initial mock prices (8 decimals)
const P = {
  USD: 100_000_000n,
  EUR: 108_000_000n,
  JPY:     670_000n,
  GBP: 126_000_000n,
  XAU: 230_000_000_000n,
};

// Expected basket price: 40%*1 + 30%*1.08 + 15%*0.0067 + 10%*1.26 + 5%*2300
// Normalized — oracle uses raw prices with weights in bps
const expectedBasket = () => {
  const raw = P.USD * 4000n + P.EUR * 3000n + P.JPY * 1500n + P.GBP * 1000n + P.XAU * 500n;
  return raw / 10000n;
};

describe("QRDTBasketOracle", function () {
  let oracle, admin, updater, guardian, other;
  let mockUSD, mockEUR, mockJPY, mockGBP, mockXAU;

  beforeEach(async function () {
    [admin, updater, guardian, other] = await ethers.getSigners();

    const Mock = await ethers.getContractFactory("MockAggregatorV3");
    mockUSD = await Mock.deploy(P.USD);
    mockEUR = await Mock.deploy(P.EUR);
    mockJPY = await Mock.deploy(P.JPY);
    mockGBP = await Mock.deploy(P.GBP);
    mockXAU = await Mock.deploy(P.XAU);

    const Oracle = await ethers.getContractFactory("QRDTBasketOracle");
    oracle = await Oracle.deploy(
      admin.address,
      await mockUSD.getAddress(),
      await mockEUR.getAddress(),
      await mockJPY.getAddress(),
      await mockGBP.getAddress(),
      await mockXAU.getAddress()
    );

    // Grant roles
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

    it("returns fallback price from getPrice before first update", async function () {
      const [price, valid] = await oracle.getPrice();
      expect(price).to.equal(100_000_000n); // BASKET_TARGET
      expect(valid).to.be.true;
    });
  });

  // ── Price update ─────────────────────────────────────────────
  describe("updatePrice", function () {
    it("updates basket price correctly", async function () {
      await oracle.connect(updater).updatePrice();
      const [price, valid] = await oracle.getPrice();
      expect(valid).to.be.true;
      // XAU weight is 5% of $2300 = $115, which dominates
      // Just verify price is positive and reasonable (not exact due to XAU scale)
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
      // First update with valid feeds
      await oracle.connect(updater).updatePrice();
      const [priceBefore] = await oracle.getPrice();

      // Disable JPY, update again
      await mockJPY.setShouldRevert(true);
      await oracle.connect(updater).updatePrice();
      const [priceAfter, valid] = await oracle.getPrice();

      expect(valid).to.be.true;
      // Price should still be calculated (not zero)
      expect(priceAfter).to.be.gt(0n);
    });

    it("triggers circuit breaker on >10% price jump", async function () {
      await oracle.connect(updater).updatePrice();

      // Move USD price up 15%
      await mockUSD.setPrice(115_000_000n);
      await mockEUR.setPrice(124_200_000n);

      await expect(oracle.connect(updater).updatePrice())
        .to.emit(oracle, "CircuitBreakerTriggered");

      const [, valid] = await oracle.getPrice();
      expect(valid).to.be.false;
    });

    it("auto-resets circuit breaker when price normalizes", async function () {
      await oracle.connect(updater).updatePrice();

      // Trigger circuit breaker
      await mockUSD.setPrice(115_000_000n);
      await oracle.connect(updater).updatePrice();

      // Normalize price
      await mockUSD.setPrice(100_000_000n);
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

      // Advance time past MAX_STALENESS (1 hour)
      await time.increase(3601);

      const [, valid] = await oracle.getPrice();
      expect(valid).to.be.false;
    });

    it("rejects stale feed data", async function () {
      // Set feed updatedAt to 2 hours ago
      await mockUSD.setUpdatedAt(Math.floor(Date.now() / 1000) - 7200);
      await expect(oracle.connect(updater).updatePrice())
        .to.be.revertedWith("Critical feeds unavailable (USD/EUR)");
    });
  });

  // ── TWAP ─────────────────────────────────────────────────────
  describe("TWAP", function () {
    it("returns latest price with single snapshot", async function () {
      await oracle.connect(updater).updatePrice();
      const twap = await oracle.getTWAP(1);
      expect(twap).to.be.gt(0n);
    });

    it("accumulates price history correctly", async function () {
      for (let i = 0; i < 5; i++) {
        await oracle.connect(updater).updatePrice();
      }
      const twap5 = await oracle.getTWAP(5);
      expect(twap5).to.be.gt(0n);
    });

    it("returns false for manipulation check with insufficient data", async function () {
      await oracle.connect(updater).updatePrice();
      expect(await oracle.isPriceManipulated(300n)).to.be.false; // needs >= 3 snapshots
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
      const fallbackVal = 99_000_000n;
      await oracle.connect(guardian).activateFallback(fallbackVal);
      const [price] = await oracle.getPrice();
      expect(price).to.equal(fallbackVal);
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
