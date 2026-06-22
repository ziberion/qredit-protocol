// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

// ============================================================
//  QRDTBasketOracle v1.0
//  qredits.io · github.com/ziberion/qredit-protocol
//
//  Computes the QRDT basket price from five Chainlink feeds.
//
//  Chainlink Price Feeds (Ethereum Mainnet):
//  USDC/USD → 0x8fFfFfd4AfB6115b954Bd326cbe7B4BA576818f6
//  EUR/USD  → 0xb49f677943BC038e9857d61E7d053CaA2C1734C
//  JPY/USD  → 0xBcE206caE7f0ec07b545EddE332A47C2F75bbeb
//  GBP/USD  → 0x5c0Ab2d9b5a7ed9f470386e82BB36A3613cDd4b
//  XAU/USD  → 0x214eD9Da11D2fbe465a6fc601a91E62EbEc1a0D6
//
//  Basket weights: 40% USD · 30% EUR · 15% JPY · 10% GBP · 5% XAU
// ============================================================

import "@chainlink/contracts/src/v0.8/shared/interfaces/AggregatorV3Interface.sol";
import "@openzeppelin/contracts/access/AccessControl.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @title  QRDTBasketOracle
/// @notice Calculates the QRDT basket price with multi-layer feed validation,
///         circuit breaker, TWAP anti-manipulation, and emergency fallback.
contract QRDTBasketOracle is AccessControl, Pausable, ReentrancyGuard {

    // ── Roles ─────────────────────────────────────────────────
    bytes32 public constant UPDATER_ROLE  = keccak256("UPDATER_ROLE");
    bytes32 public constant GUARDIAN_ROLE = keccak256("GUARDIAN_ROLE");

    // ── Precision ─────────────────────────────────────────────
    uint256 public constant PRECISION     = 1e8;
    uint256 public constant BASKET_TARGET = 1e8; // $1.00

    // ── Basket weights (basis points, total = 10000) ──────────
    uint256 public weightUSD = 4000; // 40%
    uint256 public weightEUR = 3000; // 30%
    uint256 public weightJPY = 1500; // 15%
    uint256 public weightGBP = 1000; // 10%
    uint256 public weightXAU =  500; //  5%

    // ── Feed validation parameters ────────────────────────────
    uint256 public constant MAX_STALENESS    = 1 hours;
    uint256 public constant MIN_PRICE        = 1e4;     // $0.0001
    uint256 public constant MAX_PRICE        = 1e14;    // $1,000,000
    uint256 public constant CIRCUIT_BREAKER  = 1000;    // 10% single-round jump
    uint256 public constant MAX_FALLBACK_AGE = 4 hours;

    // ── Chainlink feed descriptor ─────────────────────────────
    struct Feed {
        AggregatorV3Interface aggregator;
        string   symbol;
        uint256  heartbeat; // expected update frequency
        bool     active;
    }

    Feed public feedUSD;
    Feed public feedEUR;
    Feed public feedJPY;
    Feed public feedGBP;
    Feed public feedXAU;

    // ── Price snapshot ────────────────────────────────────────
    struct PriceSnapshot {
        uint256 price;
        uint256 priceUSD;
        uint256 priceEUR;
        uint256 priceJPY;
        uint256 priceGBP;
        uint256 priceXAU;
        uint256 timestamp;
        bool    circuitBroken;
    }

    PriceSnapshot public latest;

    // ── TWAP history (sliding window of 10 snapshots) ─────────
    uint256[10] public priceHistory;
    uint8  public historyIndex;
    uint8  public historyCount;

    // ── Emergency fallback ────────────────────────────────────
    uint256 public fallbackPrice;
    bool    public usingFallback;
    uint256 public fallbackSetAt;

    // ── Consumer registry ─────────────────────────────────────
    mapping(address => bool) public authorizedConsumers;

    // ── Events ────────────────────────────────────────────────
    event PriceUpdated(uint256 price, uint256 timestamp);
    event FeedFailed(string symbol, string reason);
    event CircuitBreakerTriggered(uint256 newPrice, uint256 lastPrice, uint256 deviation);
    event CircuitBreakerReset(address by);
    event FallbackActivated(uint256 price, address by);
    event FallbackDeactivated(address by);
    event WeightsUpdated(uint256 usd, uint256 eur, uint256 jpy, uint256 gbp, uint256 xau);
    event ConsumerAuthorized(address consumer, bool authorized);

    // ── Constructor ───────────────────────────────────────────

    /// @param admin       Address that receives all initial roles
    /// @param _feedUSD    Chainlink USDC/USD aggregator address
    /// @param _feedEUR    Chainlink EUR/USD aggregator address
    /// @param _feedJPY    Chainlink JPY/USD aggregator address
    /// @param _feedGBP    Chainlink GBP/USD aggregator address
    /// @param _feedXAU    Chainlink XAU/USD aggregator address
    constructor(
        address admin,
        address _feedUSD,
        address _feedEUR,
        address _feedJPY,
        address _feedGBP,
        address _feedXAU
    ) {
        require(admin != address(0), "Admin cannot be zero address");

        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(UPDATER_ROLE,  admin);
        _grantRole(GUARDIAN_ROLE, admin);

        feedUSD = Feed(AggregatorV3Interface(_feedUSD), "USD",  1 hours, true);
        feedEUR = Feed(AggregatorV3Interface(_feedEUR), "EUR",  1 hours, true);
        feedJPY = Feed(AggregatorV3Interface(_feedJPY), "JPY",  1 hours, true);
        feedGBP = Feed(AggregatorV3Interface(_feedGBP), "GBP",  1 hours, true);
        feedXAU = Feed(AggregatorV3Interface(_feedXAU), "XAU", 24 hours, true);

        fallbackPrice    = BASKET_TARGET;
        latest.price     = BASKET_TARGET;
        latest.timestamp = block.timestamp;
        usingFallback    = true; // start in fallback until first real update
    }

    // ================================================================
    //  PRIMARY PRICE READ
    // ================================================================

    /// @notice Returns the current QRDT basket price
    /// @return price     USD value of one QRDT (8 decimals, 1e8 = $1.00)
    /// @return valid     False if circuit breaker is active or price is stale
    /// @return timestamp When this price was last updated
    function getPrice() external view returns (
        uint256 price,
        bool    valid,
        uint256 timestamp
    ) {
        if (usingFallback) {
            bool ok = block.timestamp - fallbackSetAt <= MAX_FALLBACK_AGE;
            return (fallbackPrice, ok, fallbackSetAt);
        }
        if (latest.circuitBroken) {
            return (latest.price, false, latest.timestamp);
        }
        bool fresh = block.timestamp - latest.timestamp <= MAX_STALENESS;
        return (latest.price, fresh, latest.timestamp);
    }

    // ================================================================
    //  PRICE UPDATE
    // ================================================================

    /// @notice Recalculate the basket price from all Chainlink feeds
    /// @dev    Called automatically by QRDTKeeper every ~15 minutes
    function updatePrice()
        external
        onlyRole(UPDATER_ROLE)
        whenNotPaused
        nonReentrant
    {
        (uint256 pUSD, bool okUSD) = _readFeed(feedUSD);
        (uint256 pEUR, bool okEUR) = _readFeed(feedEUR);
        (uint256 pJPY, bool okJPY) = _readFeed(feedJPY);
        (uint256 pGBP, bool okGBP) = _readFeed(feedGBP);
        (uint256 pXAU, bool okXAU) = _readFeed(feedXAU);

        // USD and EUR are critical — reject update if either fails
        require(okUSD && okEUR, "Critical feeds unavailable (USD/EUR)");

        // Secondary feeds degrade gracefully to last known price
        if (!okJPY) pJPY = latest.priceJPY > 0 ? latest.priceJPY : PRECISION;
        if (!okGBP) pGBP = latest.priceGBP > 0 ? latest.priceGBP : PRECISION;
        if (!okXAU) pXAU = latest.priceXAU > 0 ? latest.priceXAU : PRECISION;

        // Weighted basket price
        uint256 newPrice =
            pUSD * weightUSD +
            pEUR * weightEUR +
            pJPY * weightJPY +
            pGBP * weightGBP +
            pXAU * weightXAU;
        newPrice /= 10_000;

        // Circuit breaker: reject if price jumps >10% in one round
        bool broken = false;
        if (latest.price > 0 && !usingFallback) {
            uint256 dev = _deviation(newPrice, latest.price);
            if (dev > CIRCUIT_BREAKER) {
                broken = true;
                emit CircuitBreakerTriggered(newPrice, latest.price, dev);
            }
        }

        // FIX MEDIO-03: auto-reset if next round returns to normal range
        if (latest.circuitBroken) {
            uint256 devFromLast = _deviation(newPrice, latest.price);
            if (devFromLast <= CIRCUIT_BREAKER / 2) {
                broken = false;
            }
        }

        latest = PriceSnapshot({
            price:        newPrice,
            priceUSD:     pUSD,
            priceEUR:     pEUR,
            priceJPY:     pJPY,
            priceGBP:     pGBP,
            priceXAU:     pXAU,
            timestamp:    block.timestamp,
            circuitBroken: broken
        });

        // Update TWAP sliding window
        priceHistory[historyIndex % 10] = newPrice;
        historyIndex++;
        if (historyCount < 10) historyCount++;

        if (usingFallback) usingFallback = false;

        emit PriceUpdated(newPrice, block.timestamp);
    }

    // ================================================================
    //  TWAP & MANIPULATION DETECTION
    // ================================================================

    /// @notice Time-weighted average price over the last N snapshots
    /// @param  periods Number of snapshots to average (1–10)
    function getTWAP(uint8 periods) external view returns (uint256) {
        require(periods >= 1 && periods <= 10, "Periods must be between 1 and 10");
        uint256 sum   = 0;
        uint8   count = 0;
        uint8   avail = historyCount < 10 ? historyCount : 10;
        uint8   use   = periods < avail ? periods : avail;

        for (uint8 i = 0; i < use; i++) {
            uint8 idx = (historyIndex + 10 - 1 - i) % 10;
            if (priceHistory[idx] > 0) { sum += priceHistory[idx]; count++; }
        }
        return count > 0 ? sum / count : latest.price;
    }

    /// @notice Returns true if current price deviates more than threshold from TWAP
    /// @param  threshold Maximum allowed deviation in basis points (e.g. 300 = 3%)
    function isPriceManipulated(uint256 threshold) external view returns (bool) {
        if (historyCount < 3) return false;
        uint256 sum = 0; uint8 count = 0;
        for (uint8 i = 0; i < 10; i++) {
            if (priceHistory[i] > 0) { sum += priceHistory[i]; count++; }
        }
        uint256 twap = sum / count;
        return _deviation(latest.price, twap) > threshold;
    }

    // ================================================================
    //  EMERGENCY FALLBACK
    // ================================================================

    /// @notice Guardian sets a manual price valid for up to 4 hours
    function activateFallback(uint256 price) external onlyRole(GUARDIAN_ROLE) {
        require(price > MIN_PRICE && price < MAX_PRICE, "Fallback price out of range");
        fallbackPrice  = price;
        usingFallback  = true;
        fallbackSetAt  = block.timestamp;
        emit FallbackActivated(price, msg.sender);
    }

    /// @notice Guardian deactivates fallback, resuming Chainlink data
    function deactivateFallback() external onlyRole(GUARDIAN_ROLE) {
        usingFallback = false;
        emit FallbackDeactivated(msg.sender);
    }

    /// @notice Guardian manually resets the circuit breaker
    function resetCircuitBreaker() external onlyRole(GUARDIAN_ROLE) {
        latest.circuitBroken = false;
        emit CircuitBreakerReset(msg.sender);
    }

    // ================================================================
    //  GOVERNANCE
    // ================================================================

    /// @notice Update basket composition weights (must sum to 10000)
    function updateWeights(
        uint256 usd,
        uint256 eur,
        uint256 jpy,
        uint256 gbp,
        uint256 xau
    ) external onlyRole(DEFAULT_ADMIN_ROLE) {
        require(usd + eur + jpy + gbp + xau == 10_000, "Weights must sum to 10000");
        weightUSD = usd;
        weightEUR = eur;
        weightJPY = jpy;
        weightGBP = gbp;
        weightXAU = xau;
        emit WeightsUpdated(usd, eur, jpy, gbp, xau);
    }

    /// @notice Enable or disable a specific feed
    function setFeedActive(string calldata symbol, bool active)
        external
        onlyRole(DEFAULT_ADMIN_ROLE)
    {
        bytes32 s = keccak256(bytes(symbol));
        if      (s == keccak256("USD")) feedUSD.active = active;
        else if (s == keccak256("EUR")) feedEUR.active = active;
        else if (s == keccak256("JPY")) feedJPY.active = active;
        else if (s == keccak256("GBP")) feedGBP.active = active;
        else if (s == keccak256("XAU")) feedXAU.active = active;
        else revert("Unknown feed symbol");
    }

    /// @notice Register authorized price consumers (informational)
    function authorizeConsumer(address consumer, bool authorized)
        external
        onlyRole(DEFAULT_ADMIN_ROLE)
    {
        authorizedConsumers[consumer] = authorized;
        emit ConsumerAuthorized(consumer, authorized);
    }

    function pause()   external onlyRole(GUARDIAN_ROLE) { _pause();   }
    function unpause() external onlyRole(GUARDIAN_ROLE) { _unpause(); }

    // ================================================================
    //  INTERNAL
    // ================================================================

    function _readFeed(Feed storage f) internal returns (uint256 price, bool valid) {
        if (!f.active) return (0, false);

        try f.aggregator.latestRoundData() returns (
            uint80  roundId,
            int256  answer,
            uint256 /* startedAt */,
            uint256 updatedAt,
            uint80  answeredInRound
        ) {
            if (answer <= 0) {
                emit FeedFailed(f.symbol, "Non-positive price");
                return (0, false);
            }
            if (answeredInRound < roundId) {
                emit FeedFailed(f.symbol, "Incomplete round");
                return (0, false);
            }
            if (block.timestamp - updatedAt > f.heartbeat + 30 minutes) {
                emit FeedFailed(f.symbol, "Stale data");
                return (0, false);
            }
            uint256 p = uint256(answer);
            if (p < MIN_PRICE || p > MAX_PRICE) {
                emit FeedFailed(f.symbol, "Price out of range");
                return (0, false);
            }
            return (p, true);

        } catch {
            emit FeedFailed(f.symbol, "Feed call reverted");
            return (0, false);
        }
    }

    function _deviation(uint256 a, uint256 b) internal pure returns (uint256) {
        if (b == 0) return type(uint256).max;
        uint256 diff = a > b ? a - b : b - a;
        return diff * 10_000 / b;
    }
}
