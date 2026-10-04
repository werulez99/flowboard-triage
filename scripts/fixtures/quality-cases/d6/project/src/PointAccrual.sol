// Fictional accounting; no assets. Deliberately not a compiler/test fixture.
pragma solidity ^0.8.20;

contract PointAccrual {
    mapping(uint256 => address) public owner;
    mapping(uint256 => uint256) public pending;
    mapping(address => uint256) public recorded;

    function open(uint256 key) external {
        require(owner[key] == address(0), "exists");
        owner[key] = msg.sender;
        pending[key] = 7;
    }

    function finish(uint256 key, bool terminal) external {
        require(owner[key] == msg.sender, "owner only");
        if (terminal) {
            delete owner[key];
            _checkpoint(key);
        } else {
            _checkpoint(key);
        }
    }

    function _checkpoint(uint256 key) internal {
        _apply(key);
    }

    function _apply(uint256 key) internal {
        recorded[owner[key]] += pending[key];
        pending[key] = 0;
    }
}
