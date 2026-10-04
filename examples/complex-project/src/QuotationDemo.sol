// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

// An ordinary quotation calculator for source-navigation tests, not a protocol
// or vulnerability example. Units are abstract counters, never token balances.
contract QuotationDemo {
    uint256 public lastQuote;
    uint256 public quoteCount;

    function previewQuote(uint256 amount, bool expedited)
        external pure returns (uint256)
    {
        return _calculate(amount, expedited);
    }

    function recordQuote(uint256 amount, bool expedited)
        external returns (uint256 result)
    {
        result = _calculate(amount, expedited);
        _store(result);
    }

    function _calculate(uint256 amount, bool expedited)
        internal pure returns (uint256)
    {
        uint256 normalized = _normalize(amount);
        uint256 charge;
        if (expedited) {
            charge = _express(normalized);
        } else {
            charge = _standard(normalized);
        }
        return _finish(normalized, charge);
    }

    function _normalize(uint256 amount) internal pure returns (uint256) {
        return _bounded(amount);
    }

    function _bounded(uint256 amount) internal pure returns (uint256) {
        require(amount <= 1_000_000, "Demo quantity bound");
        return amount;
    }

    function _standard(uint256 amount) internal pure returns (uint256) {
        return _baseCharge(amount) + _volumeAdjustment(amount);
    }

    function _express(uint256 amount) internal pure returns (uint256) {
        return _baseCharge(amount) + _volumeAdjustment(amount) + _rushCharge();
    }

    function _baseCharge(uint256 amount) internal pure returns (uint256) {
        return amount / 100;
    }

    function _volumeAdjustment(uint256 amount) internal pure returns (uint256) {
        return amount >= 1_000 ? 2 : 1;
    }

    function _rushCharge() internal pure returns (uint256) {
        return 5;
    }

    function _finish(uint256 amount, uint256 charge)
        internal pure returns (uint256)
    {
        uint256 subtotal = _subtotal(amount, charge);
        return _roundTotal(subtotal + _tax(subtotal));
    }

    function _subtotal(uint256 amount, uint256 charge)
        internal pure returns (uint256)
    {
        return amount + charge;
    }

    function _tax(uint256 subtotal) internal pure returns (uint256) {
        return subtotal / 20;
    }

    function _roundTotal(uint256 total) internal pure returns (uint256) {
        return ((total + 9) / 10) * 10;
    }

    function _store(uint256 result) internal {
        lastQuote = result;
        _noteCount();
    }

    function _noteCount() internal {
        quoteCount += 1;
    }
}
