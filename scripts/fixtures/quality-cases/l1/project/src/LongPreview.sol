// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

// Fictional reading-layout fixture. No assets, accounts or external calls.
contract LongPreview {
    function previewCompletedStepsWithAReadableLongSignature(uint256 requestedThreshold)
        external pure returns (uint256 completedSteps)
    {
        // Every branch below contributes exactly one unit when its threshold is reached.
        if (requestedThreshold >= 1) {
            completedSteps += 1;
        }

        if (requestedThreshold >= 2) {
            completedSteps += 1;
        }

        if (requestedThreshold >= 3) {
            completedSteps += 1;
        }

        if (requestedThreshold >= 4) {
            completedSteps += 1;
        }

        if (requestedThreshold >= 5) {
            completedSteps += 1;
        }

        if (requestedThreshold >= 6) {
            completedSteps += 1;
        }

        if (requestedThreshold >= 7) {
            completedSteps += 1;
        }

        if (requestedThreshold >= 8) {
            completedSteps += 1;
        }

        if (requestedThreshold >= 9) {
            completedSteps += 1;
        }

        if (requestedThreshold >= 10) {
            completedSteps += 1;
        }

        if (requestedThreshold >= 11) {
            completedSteps += 1;
        }

        if (requestedThreshold >= 12) {
            completedSteps += 1;
        }

        if (requestedThreshold >= 13) {
            completedSteps += 1;
        }

        if (requestedThreshold >= 14) {
            completedSteps += 1;
        }

        if (requestedThreshold >= 15) {
            completedSteps += 1;
        }

        if (requestedThreshold >= 16) {
            completedSteps += 1;
        }

        if (requestedThreshold >= 17) {
            completedSteps += 1;
        }

        if (requestedThreshold >= 18) {
            completedSteps += 1;
        }

        if (requestedThreshold >= 19) {
            completedSteps += 1;
        }

        if (requestedThreshold >= 20) {
            completedSteps += 1;
        }

        if (requestedThreshold >= 21) {
            completedSteps += 1;
        }

        if (requestedThreshold >= 22) {
            completedSteps += 1;
        }

        if (requestedThreshold >= 23) {
            completedSteps += 1;
        }

        if (requestedThreshold >= 24) {
            completedSteps += 1;
        }

        // An input below the first threshold leaves the named return value at zero.
        return completedSteps;
    }
}
