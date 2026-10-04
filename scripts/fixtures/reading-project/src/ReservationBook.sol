// Fictional source-reading fixture. No assets or deployed system.
pragma solidity ^0.8.20;

contract ReservationBook {
    mapping(uint256 => address) public holder;
    mapping(uint256 => uint256) public credit;
    mapping(address => uint256) public collected;

    modifier onlyHolder(uint256 key) {
        require(holder[key] == msg.sender, "holder only");
        _;
    }

    function finishReservation(uint256 key) external onlyHolder(key) {
        _settleCredit(key);
        delete holder[key];
    }

    // A different overload records a recipient; it does not close anything.
    function finishReservation(address recipient, uint256 key) external onlyHolder(key) {
        holder[key] = recipient;
    }

    function _settleCredit(uint256 key) internal {
        uint256 due = credit[key];
        credit[key] = 0;
        collected[holder[key]] += due;
    }

    function collectCredit(uint256 key) external onlyHolder(key) {
        _settleCredit(key);
    }

    function inspectCredit(uint256 key) external view returns (uint256) {
        return credit[key];
    }
}
