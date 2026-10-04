// Fictional accounting only; no assets or deployed system.
pragma solidity ^0.8.20;

contract AssignmentBook {
    mapping(uint256 => address) public owner;
    mapping(uint256 => uint256) public points;
    mapping(address => uint256) public recorded;

    function open(uint256 key) external {
        require(owner[key] == address(0), "exists");
        owner[key] = msg.sender;
        points[key] = 4;
    }

    function close(uint256 key) external {
        require(owner[key] == msg.sender, "owner only");
        _record(key);
        delete owner[key];
    }

    function close(address recipient, uint256 key) external {
        require(owner[key] == msg.sender, "owner only");
        owner[key] = recipient;
    }

    function _record(uint256 key) internal {
        recorded[owner[key]] += points[key];
        points[key] = 0;
    }
}

contract Archive {
    uint256 public lastKey;
    function close(uint256 key) external {
        lastKey = key;
    }
}
