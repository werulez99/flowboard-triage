// Fictional documentation counter. No tokens, money, or external calls.
pragma solidity ^0.8.20;

contract PageCounter {
    mapping(address => uint256) public pages;

    function recordPage() external {
        _increase(msg.sender);
    }

    function _increase(address reader) internal {
        pages[reader] += 2;
    }
}
