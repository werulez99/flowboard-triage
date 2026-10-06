// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

// Fictional snapshot bookkeeping; no assets, external calls or deployment.
// Specification: an inactive update preserves the last snapshot and checkpoint.
// Specification: an active update replaces the snapshot and advances checkpoint.
contract CheckpointBook {
    uint256 public snapshot = 7;
    uint256 public checkpoint;

    function update(uint256 suppliedSnapshot, bool active) external {
        if (!active) {
            return;
        }
        snapshot = suppliedSnapshot;
        checkpoint += 1;
    }

    function readSnapshot() external view returns (uint256) {
        return snapshot;
    }
}
