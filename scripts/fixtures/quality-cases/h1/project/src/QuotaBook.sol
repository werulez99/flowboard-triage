// Held-out fictional source-reading case. No assets or deployed system.
pragma solidity ^0.8.20;

contract QuotaBook {
    mapping(address => uint256) public limit;
    mapping(address => uint256) public consumed;

    function enroll() external {
        require(limit[msg.sender] == 0, "already enrolled");
        limit[msg.sender] = 8;
    }

    function applyQuota(uint256 quantity) external {
        _validate(msg.sender, quantity);
        _note(msg.sender, quantity);
    }

    function _validate(address person, uint256 quantity) internal view {
        _checkRemaining(person, quantity);
    }

    function _checkRemaining(address person, uint256 quantity) internal view {
        require(consumed[person] + quantity <= limit[person], "limit exceeded");
    }

    function _note(address person, uint256 quantity) internal {
        consumed[person] += quantity;
    }
}
