// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;
interface IRemoteGuard {
    function finish(bool accepted) external;
}
contract GuardBook {
    function finish(bool accepted) external pure {
        require(accepted, "rejected");
    }
    function checkCount(uint256 count) external pure {
        require(count != 0, "zero");
    }
    function remoteFinish(IRemoteGuard remote, bool accepted) external {
        remote.finish(accepted);
    }
}
