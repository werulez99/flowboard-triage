// Held-out fictional source-reading case. All values are bookkeeping units.
pragma solidity ^0.8.20;

contract TicketBook {
    mapping(uint256 => address) public keeper;
    mapping(uint256 => uint256) public queued;
    mapping(address => uint256) public unlocked;

    function register(uint256 ticket) external {
        require(keeper[ticket] == address(0), "exists");
        keeper[ticket] = msg.sender;
        queued[ticket] = 6;
    }

    function retire(uint256 ticket, bool fast) external {
        require(keeper[ticket] == msg.sender, "keeper only");
        if (fast) {
            _move(ticket);
            delete keeper[ticket];
        } else {
            require(queued[ticket] == 0, "units remain");
            delete keeper[ticket];
        }
    }

    function _move(uint256 ticket) internal {
        unlocked[keeper[ticket]] += queued[ticket];
        queued[ticket] = 0;
    }
}
