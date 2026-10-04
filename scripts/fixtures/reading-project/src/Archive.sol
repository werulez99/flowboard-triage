pragma solidity ^0.8.20;

contract Archive {
    uint256 public lastKey;
    function finishReservation(uint256 key) external {
        lastKey = key;
    }
}
