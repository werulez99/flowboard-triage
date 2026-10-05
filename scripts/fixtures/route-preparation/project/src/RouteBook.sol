// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

// Fictional counter bookkeeping. No tokens, external calls or deployments.
contract RouteBook {
    uint256 public attempts;
    uint256 public counter;

    function commit(uint256 requestedThreshold, bool approved) external {
        attempts += 1;
        _checkAmount(requestedThreshold);
        uint256 delta = _preview(requestedThreshold);
        _increment(delta);
        _increment(1);
        _requireApproval(approved);
    }

    function _checkAmount(uint256 requestedThreshold) internal pure {
        require(requestedThreshold >= 1 && requestedThreshold <= 24, "threshold");
    }

    function _preview(uint256 requestedThreshold) internal pure returns (uint256 completed) {
        // Each reached threshold contributes exactly one counter unit.
        if (requestedThreshold >= 1) {
            completed += 1;
        }

        if (requestedThreshold >= 2) {
            completed += 1;
        }

        if (requestedThreshold >= 3) {
            completed += 1;
        }

        if (requestedThreshold >= 4) {
            completed += 1;
        }

        if (requestedThreshold >= 5) {
            completed += 1;
        }

        if (requestedThreshold >= 6) {
            completed += 1;
        }

        if (requestedThreshold >= 7) {
            completed += 1;
        }

        if (requestedThreshold >= 8) {
            completed += 1;
        }

        if (requestedThreshold >= 9) {
            completed += 1;
        }

        if (requestedThreshold >= 10) {
            completed += 1;
        }

        if (requestedThreshold >= 11) {
            completed += 1;
        }

        if (requestedThreshold >= 12) {
            completed += 1;
        }

        if (requestedThreshold >= 13) {
            completed += 1;
        }

        if (requestedThreshold >= 14) {
            completed += 1;
        }

        if (requestedThreshold >= 15) {
            completed += 1;
        }

        if (requestedThreshold >= 16) {
            completed += 1;
        }

        if (requestedThreshold >= 17) {
            completed += 1;
        }

        if (requestedThreshold >= 18) {
            completed += 1;
        }

        if (requestedThreshold >= 19) {
            completed += 1;
        }

        if (requestedThreshold >= 20) {
            completed += 1;
        }

        if (requestedThreshold >= 21) {
            completed += 1;
        }

        if (requestedThreshold >= 22) {
            completed += 1;
        }

        if (requestedThreshold >= 23) {
            completed += 1;
        }

        if (requestedThreshold >= 24) {
            completed += 1;
        }

        // The caller uses the total only after all of these branches.
        return completed;
    }

    function _increment(uint256 amount) internal {
        counter += amount;
        return;
    }

    function _requireApproval(bool approved) internal pure {
        require(approved, "approval rejected");
    }
}
