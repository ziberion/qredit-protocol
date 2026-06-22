// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

// ============================================================
//  MockChainlinkFeed
//  FOR TESTING AND SEPOLIA ONLY — never deploy to mainnet
// ============================================================

/// @notice Simulates a Chainlink AggregatorV3Interface price feed
contract MockChainlinkFeed {
    string  public description;
    uint8   public decimals = 8;

    int256  private _price;
    uint80  private _roundId;
    uint256 private _updatedAt;

    constructor(string memory _description, int256 initialPrice) {
        description = _description;
        _price      = initialPrice;
        _roundId    = 1;
        _updatedAt  = block.timestamp;
    }

    function latestRoundData() external view returns (
        uint80  roundId,
        int256  answer,
        uint256 startedAt,
        uint256 updatedAt,
        uint80  answeredInRound
    ) {
        return (_roundId, _price, _updatedAt, _updatedAt, _roundId);
    }

    /// @notice Update the mock price (callable by anyone in tests)
    function updatePrice(int256 newPrice) external {
        _price     = newPrice;
        _roundId++;
        _updatedAt = block.timestamp;
    }

    /// @notice Simulate a stale feed by backdating the timestamp
    function setTimestamp(uint256 ts) external {
        _updatedAt = ts;
    }
}
