pragma solidity ^0.8.20;

// Fictional source-only reader control. No deployment or executed trace.
contract ScenarioBook {
    uint256 public stored;
    function withdraw(bool approved, uint256 units) external pure returns (uint256) {
        require(approved, "approval required");
        return units;
    }
    function rebalance(bool paused, uint256 target) external {
        require(!paused, "paused");
        stored = target;
    }
}
