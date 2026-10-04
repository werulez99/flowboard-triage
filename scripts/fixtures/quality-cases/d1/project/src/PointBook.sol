// Fictional points, not assets. Source-reading evaluation only.
pragma solidity ^0.8.20;

contract PointBook {
    mapping(uint256 => address) public owner;
    mapping(uint256 => uint256) public pending;
    mapping(address => uint256) public earned;
    mapping(address => uint256) public used;

    function create(uint256 key) external {
        require(owner[key] == address(0), "exists");
        owner[key] = msg.sender;
        pending[key] = 3;
    }

    // Archive a record only after moving its pending points to the owner.
    function archiveRecord(uint256 key) external {
        require(owner[key] == msg.sender, "owner only");
        _checkpoint(key);
        delete owner[key];
    }

    function _checkpoint(uint256 key) internal {
        _writeCredit(key);
    }

    function _writeCredit(uint256 key) internal {
        _retain(owner[key], pending[key]);
        pending[key] = 0;
    }

    function _retain(address person, uint256 count) internal {
        earned[person] += count;
    }

    function consume(uint256 count) external {
        require(earned[msg.sender] >= count, "not enough points");
        earned[msg.sender] -= count;
        used[msg.sender] += count;
    }
}
