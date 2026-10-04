// Fictional current revision. A report citation describes a different layout.
pragma solidity ^0.8.20;

contract QueueBook {
    mapping(uint256 => address) public owner;
    mapping(uint256 => uint256) public due;
    uint256 public label;

    function setLabel(uint256 value) external {
        label = value;
    }

    function open(uint256 key) external {
        require(owner[key] == address(0), "exists");
        owner[key] = msg.sender;
        due[key] = 2;
    }

    function finish(uint256 key) external {
        require(owner[key] == msg.sender, "owner only");
        require(due[key] == 0, "points remain");
        delete owner[key];
    }

    function acknowledge(uint256 key) external {
        require(owner[key] == msg.sender, "owner only");
        due[key] = 0;
    }
}
