// Held-out fictional case. The recorder is intentionally unavailable.
pragma solidity ^0.8.20;

interface IExternalCounter {
    function account(address person, uint256 units) external;
}

contract RemoteCounter {
    IExternalCounter public immutable recorder;
    mapping(address => uint256) public pending;

    constructor(IExternalCounter configured) {
        recorder = configured;
    }

    function enroll() external {
        pending[msg.sender] += 9;
    }

    function complete() external {
        recorder.account(msg.sender, pending[msg.sender]);
        pending[msg.sender] = 0;
    }
}
