// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

// ============================================================
//  MockBasketOracle
//  FOR TESTING AND SEPOLIA ONLY — never deploy to mainnet
// ============================================================

/// @notice Simulates QRDTBasketOracle for unit tests
contract MockBasketOracle {
    uint256 private _price;
    bool    private _valid;
    uint256 private _timestamp;

    constructor(uint256 initialPrice) {
        _price     = initialPrice;
        _valid     = true;
        _timestamp = block.timestamp;
    }

    function getPrice() external view returns (uint256, bool, uint256) {
        return (_price, _valid, _timestamp);
    }

    function setPrice(uint256 price) external {
        _price     = price;
        _timestamp = block.timestamp;
    }

    function setValid(bool valid) external { _valid = valid; }

    function setTimestamp(uint256 ts) external { _timestamp = ts; }
}
