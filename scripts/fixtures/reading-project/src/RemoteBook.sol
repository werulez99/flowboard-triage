pragma solidity ^0.8.20;

interface IBookkeeper {
    function settle(uint256 key, address recipient) external;
}

contract RemoteBook {
    IBookkeeper public keeper;
    mapping(uint256 => address) public holder;

    function finishReservation(uint256 key) external {
        require(holder[key] == msg.sender, "holder only");
        keeper.settle(key, msg.sender);
        delete holder[key];
    }
}
