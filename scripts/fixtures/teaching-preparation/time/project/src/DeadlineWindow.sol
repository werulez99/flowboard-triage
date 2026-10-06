// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

// Fictional clock model; no real timestamps, assets, external calls or deployment.
// Specification: schedule stores the absolute deadline startedAt + duration.
// Specification: ready compares the supplied clock with that absolute deadline.
contract DeadlineWindow {
    uint256 public deadline;

    function schedule(uint256 startedAt, uint256 duration) external {
        require(startedAt > 0 && startedAt <= 1000000, "start");
        require(duration > 0 && duration <= 1000, "duration");
        deadline = duration;
    }

    function ready(uint256 clock) external view returns (bool) {
        return clock >= deadline;
    }
}
