// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title  MockAggregatorV3
/// @notice Simulates a Chainlink price feed for local testing.
///         Allows setting arbitrary prices and simulating staleness.
contract MockAggregatorV3 {
    int256  public price;
    uint256 public updatedAt;
    uint80  public roundId;
    bool    public shouldRevert;

    constructor(int256 _initialPrice) {
        price     = _initialPrice;
        updatedAt = block.timestamp;
        roundId   = 1;
    }

    function setPrice(int256 _price) external {
        price     = _price;
        updatedAt = block.timestamp;
        roundId++;
    }

    function setUpdatedAt(uint256 _updatedAt) external {
        updatedAt = _updatedAt;
    }

    function setShouldRevert(bool _shouldRevert) external {
        shouldRevert = _shouldRevert;
    }

    function latestRoundData() external view returns (
        uint80  _roundId,
        int256  _answer,
        uint256 _startedAt,
        uint256 _updatedAt,
        uint80  _answeredInRound
    ) {
        require(!shouldRevert, "MockAggregator: forced revert");
        return (roundId, price, block.timestamp, updatedAt, roundId);
    }

    function decimals() external pure returns (uint8) {
        return 8;
    }
}
