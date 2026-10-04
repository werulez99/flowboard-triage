// Two fictional routes. The external recorder implementation is not supplied.
pragma solidity ^0.8.20;

interface IRecorder {
    function record(address person, uint256 points) external;
}

contract LocalRoute {
    mapping(uint256 => address) public owner;
    mapping(uint256 => uint256) public pending;
    mapping(address => uint256) public saved;

    function open(uint256 key) external {
        require(owner[key] == address(0), "exists");
        owner[key] = msg.sender;
        pending[key] = 5;
    }

    function finish(uint256 key) external {
        require(owner[key] == msg.sender, "owner only");
        _record(key);
        delete owner[key];
    }

    function _record(uint256 key) internal {
        saved[owner[key]] += pending[key];
        pending[key] = 0;
    }
}

contract RemoteRoute {
    IRecorder public immutable recorder;
    mapping(uint256 => address) public owner;
    mapping(uint256 => uint256) public pending;

    constructor(IRecorder selected) {
        recorder = selected;
    }

    function open(uint256 key) external {
        require(owner[key] == address(0), "exists");
        owner[key] = msg.sender;
        pending[key] = 5;
    }

    function finish(uint256 key) external {
        require(owner[key] == msg.sender, "owner only");
        recorder.record(owner[key], pending[key]);
        pending[key] = 0;
        delete owner[key];
    }
}
