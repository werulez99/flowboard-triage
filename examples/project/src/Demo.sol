// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

// A deliberately ordinary call-flow fixture, not an exploit or bug example.
contract Demo {
    uint256 public counter;

    function increment(uint256 amount) external {
        _add(amount);
    }

    function _add(uint256 amount) internal {
        counter += amount;
    }
}
