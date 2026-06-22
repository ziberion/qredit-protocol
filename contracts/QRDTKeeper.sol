// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

// ============================================================
//  QRDTKeeper v1.0
//  qredits.io · github.com/ziberion/qredit-protocol
//
//  Chainlink Automation keeper that triggers QRDTBasketOracle
//  price updates on a configurable interval (default: 15 min).
// ============================================================

import "@chainlink/contracts/src/v0.8/automation/AutomationCompatible.sol";
import "@openzeppelin/contracts/access/AccessControl.sol";

interface IQRDTOracle {
    function updatePrice() external;
    function getPrice() external view returns (uint256, bool, uint256);
}

/// @title  QRDTKeeper
/// @notice Chainlink Automation upkeep contract for the Qredit oracle
contract QRDTKeeper is AutomationCompatibleInterface, AccessControl {

    bytes32 public constant MANAGER_ROLE = keccak256("MANAGER_ROLE");

    // ── Configuration ─────────────────────────────────────────
    IQRDTOracle public oracle;
    uint256 public updateInterval; // seconds between updates
    uint256 public maxPriceAge;    // trigger immediately if price is this old
    bool    public paused;

    // ── State ─────────────────────────────────────────────────
    uint256 public lastUpkeepTime;
    uint256 public upkeepCount;
    uint256 public failCount;
    string  public lastFailReason;

    // ── Events ────────────────────────────────────────────────
    event UpkeepPerformed(uint256 timestamp, uint256 newPrice, uint256 count);
    event UpkeepFailed(uint256 timestamp, string reason, uint256 failCount);
    event OracleUpdated(address newOracle);
    event ConfigUpdated(uint256 interval, uint256 maxAge);

    // ── Constructor ───────────────────────────────────────────

    /// @param admin             Address that receives all roles
    /// @param _oracle           QRDTBasketOracle contract address
    /// @param _intervalSeconds  Update interval in seconds (min 60, recommended 900)
    constructor(address admin, address _oracle, uint256 _intervalSeconds) {
        require(admin   != address(0), "Admin cannot be zero address");
        require(_oracle != address(0), "Oracle cannot be zero address");
        require(_intervalSeconds >= 60, "Minimum interval is 60 seconds");

        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(MANAGER_ROLE,       admin);

        oracle         = IQRDTOracle(_oracle);
        updateInterval = _intervalSeconds;
        maxPriceAge    = _intervalSeconds * 3; // alert if price is 3× older than interval
        lastUpkeepTime = block.timestamp;
    }

    // ================================================================
    //  CHAINLINK AUTOMATION INTERFACE
    // ================================================================

    /// @notice Chainlink calls this every block to decide whether to act
    /// @dev    Must be cheap (view only). No state changes here.
    /// @return upkeepNeeded True if performUpkeep should be called
    /// @return performData  Unused — kept for interface compatibility
    function checkUpkeep(bytes calldata /* checkData */)
        external
        view
        override
        returns (bool upkeepNeeded, bytes memory performData)
    {
        if (paused) return (false, "");

        bool intervalPassed = block.timestamp >= lastUpkeepTime + updateInterval;

        // Emergency trigger: price is much older than expected
        (, , uint256 lastTs) = oracle.getPrice();
        bool priceStale = block.timestamp >= lastTs + maxPriceAge;

        upkeepNeeded = intervalPassed || priceStale;
        performData  = "";
    }

    /// @notice Chainlink calls this when checkUpkeep returns true
    /// @dev    Funded by LINK tokens registered with Chainlink Automation
    function performUpkeep(bytes calldata /* performData */) external override {
        // Re-check conditions to prevent race conditions
        bool intervalPassed = block.timestamp >= lastUpkeepTime + updateInterval;
        (, , uint256 lastTs) = oracle.getPrice();
        bool priceStale = block.timestamp >= lastTs + maxPriceAge;

        require(intervalPassed || priceStale, "Upkeep not needed yet");

        lastUpkeepTime = block.timestamp;

        try oracle.updatePrice() {
            upkeepCount++;
            (uint256 newPrice, , ) = oracle.getPrice();
            emit UpkeepPerformed(block.timestamp, newPrice, upkeepCount);
        } catch Error(string memory reason) {
            failCount++;
            lastFailReason = reason;
            emit UpkeepFailed(block.timestamp, reason, failCount);
        } catch {
            failCount++;
            lastFailReason = "Unknown error";
            emit UpkeepFailed(block.timestamp, "Unknown error", failCount);
        }
    }

    // ================================================================
    //  MANAGEMENT
    // ================================================================

    function setOracle(address _oracle) external onlyRole(MANAGER_ROLE) {
        require(_oracle != address(0), "Oracle cannot be zero address");
        oracle = IQRDTOracle(_oracle);
        emit OracleUpdated(_oracle);
    }

    function setConfig(uint256 _interval, uint256 _maxAge) external onlyRole(MANAGER_ROLE) {
        require(_interval >= 60,     "Minimum interval is 60 seconds");
        require(_maxAge > _interval, "maxAge must be greater than interval");
        updateInterval = _interval;
        maxPriceAge    = _maxAge;
        emit ConfigUpdated(_interval, _maxAge);
    }

    function setPaused(bool _paused) external onlyRole(MANAGER_ROLE) {
        paused = _paused;
    }

    // ── View ──────────────────────────────────────────────────
    function keeperStatus() external view returns (
        bool    active,
        uint256 nextUpkeep,
        uint256 count,
        uint256 fails,
        string  memory lastFail,
        uint256 interval
    ) {
        return (
            !paused,
            lastUpkeepTime + updateInterval,
            upkeepCount,
            failCount,
            lastFailReason,
            updateInterval
        );
    }
}
