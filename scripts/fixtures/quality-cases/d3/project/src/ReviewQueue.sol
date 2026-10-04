// Fictional source-reading evaluation; no financial effects.
pragma solidity ^0.8.20;

contract ReviewQueue {
    address public immutable reviewer;
    mapping(uint256 => bool) public finished;

    constructor() {
        reviewer = msg.sender;
    }

    modifier onlyReviewer() {
        require(msg.sender == reviewer, "reviewer only");
        _;
    }

    function finalize(uint256 key, bool accepted) external onlyReviewer {
        finished[key] = true;
        require(accepted, "not accepted");
    }
}
