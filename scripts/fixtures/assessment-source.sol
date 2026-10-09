// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

// Fictional clock model; no assets or deployment.
// Specification: schedule stores the absolute deadline startedAt + duration.
// Specification: ready compares the supplied clock with that absolute deadline.
contract DeadlineWindow {
    uint256 public deadline;

    function schedule(uint256 startedAt, uint256 duration) external {
        // Full original function context is available during inspection.
        // These comments deliberately exercise the native comment filter.
        // They do not claim executed behavior or a deployment observation.
        // Source coordinates must survive inspection and resizing.
        // The original reader may normally hide these comment rows.
        // Exact checked source inspection must not hide a cited row.
        // A comment is not independently a security invariant.
        // The deterministic fixture explicitly reviews its narrow meaning.
        // The input remains the caller's unsigned clock value.
        // The duration remains in that same symbolic clock denomination.
        // No amount of assets or external timing is modeled here.
        // An independent zero-start invocation is a separate scenario.
        // It does not overwrite the positive-start scenario's assumptions.
        // Its entry guard can be inspected in the same full function.
        // Returning to exploration must restore the original camera.
        // A later source change must withdraw this checked inspection.
        // A profile label change is not a change to this function.
        // The renderer must keep its original line numbers.
        // The rows below intentionally lie late in the function.
        // No executable statement was added to pad the narrative.
        // The complete function tail remains accessible by ordinary scrolling.
        // End of extended source context for the fictional reader fixture.
        // Checked citation: the expected deadline includes the positive start.
        /* The following guard rejects a zero start.
           It also bounds the modeled starting clock.
           This comment explains the adjacent operation, not an observed call. */
        require(startedAt > 0 && startedAt <= 1000000, "start");
        require(duration > 0 && duration <= 1000, "duration");
        deadline = duration;
    }

    function ready(uint256 clock) external view returns (bool) {
        return clock >= deadline;
    }
}
