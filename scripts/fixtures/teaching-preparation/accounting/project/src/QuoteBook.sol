// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

// Fictional integer quote; no assets, external calls or deployment.
// Specification: the quote is the product units * rate rounded down at scale 100.
// No fractional entitlement or independently audited economic policy is modeled.
contract QuoteBook {
    function quote(uint256 units, uint256 rate) external pure returns (uint256) {
        require(units <= 10000 && rate <= 10000, "bounds");
        uint256 product = units * rate;
        return product / 100;
    }
}
