// SPDX-License-Identifier: MIT
pragma solidity >=0.8.13 <0.9.0;

// Benign language-semantics controls. No protocol, funds, attack or deployment
// is involved. These independently establish the host gate fixture outcomes.
interface IIdentity { function identity() external pure returns (uint256); }
contract IdentityOne { function identity() external pure returns (uint256) { return 1; } }
contract IdentityTwo { function identity() external pure returns (uint256) { return 2; } }

contract ShadowedInitializer {
    IIdentity immutable target = IIdentity(address(new IdentityTwo()));
    constructor(IIdentity target) { target = IIdentity(address(new IdentityOne())); }
    function identity() external view returns (uint256) { return target.identity(); }
}

contract BooleanGuard {
    error Rejected();
    function conditionalCustom(bool accepted) external pure { if (accepted) { revert Rejected(); } }
    function unconditionalCustom(bool) external pure { revert Rejected(); }
    function stringReason(bool accepted) external pure { string memory reason = "rejected"; require(accepted, reason); }
    function requireAccepted(bool accepted) external pure { require(accepted, "rejected"); }
    function assertAccepted(bool accepted) external pure { assert(accepted); }
    function unchanged(bool accepted) external pure returns (bool) { return accepted; }
    function reassigned(bool accepted) external pure returns (bool) { accepted = false; return accepted; }
    function helperFirst(bool accepted) external pure { reject(); require(accepted, "rejected"); }
    function reject() internal pure { assert(false); }
    function emptyRequire() external pure { rejectEmptyRequire(); }
    function emptyRevert() external pure { rejectEmptyRevert(); }
    function rejectEmptyRequire() internal pure { require(false); }
    function rejectEmptyRevert() internal pure { revert(); }
}

contract CatchControl {
    BooleanGuard immutable guard = new BooleanGuard();
    bool public completed;
    function typedEmpty(bool useRequire) external {
        if (useRequire) {
            try guard.emptyRequire() {} catch Error(string memory) {}
        } else {
            try guard.emptyRevert() {} catch Error(string memory) {}
        }
        completed = true;
    }
    function generalEmpty() external {
        try guard.emptyRequire() {} catch {}
        try guard.emptyRevert() {} catch {}
        completed = true;
    }
    function earlyReturn(bool flag) external returns (bool) {
        if (!flag) return false;
        try guard.requireAccepted(false) {} catch Error(string memory) {}
        completed = true;
        return true;
    }
    function helperFirst() external {
        try guard.helperFirst(false) {} catch Error(string memory) {}
        completed = true;
    }
    function changedEntry(bool flag) external returns (bool) {
        flag = true;
        try guard.requireAccepted(flag) {} catch Error(string memory) { return false; }
        completed = true;
        return true;
    }
    function returningCatch() external returns (bool) {
        try guard.requireAccepted(false) {} catch Error(string memory) { return false; }
        completed = true;
        return true;
    }
    function namedReason() external {
        try guard.stringReason(false) {} catch Error(string memory) { completed = true; }
    }
    function panicOnly() external {
        try guard.requireAccepted(false) {} catch Panic(uint256) {}
        completed = true;
    }
    function matchingError() external {
        try guard.requireAccepted(false) {} catch Error(string memory) {}
        completed = true;
    }
    function rethrowError() external {
        try guard.requireAccepted(false) {} catch Error(string memory) { revert("again"); }
        completed = true;
    }
    function fallbackCatch() external {
        try guard.requireAccepted(false) {} catch Panic(uint256) {} catch {}
        completed = true;
    }
    function matchingPanic() external {
        try guard.assertAccepted(false) {} catch Panic(uint256) {}
        completed = true;
    }
}

contract CallSemanticsTest {
    function testEmptyHelperFailurePropagatesPastTypedCatch() external {
        CatchControl control = new CatchControl();
        for (uint256 i; i < 2; i++) {
            bool failed;
            try control.typedEmpty(i == 0) {} catch (bytes memory data) {
                require(data.length == 0, "no Error(string) payload"); failed = true;
            }
            require(failed && !control.completed(), "typed catch cannot commit later write");
        }
    }
    function testGeneralCatchHandlesEmptyHelperFailure() external {
        CatchControl control = new CatchControl();
        control.generalEmpty();
        require(control.completed(), "general catch continues after empty data");
    }
    function testEarlierReturnSkipsCallAndWrite() external {
        CatchControl control = new CatchControl();
        require(!control.earlyReturn(false) && !control.completed(), "false returns before the call");
        require(control.earlyReturn(true) && control.completed(), "true reaches the handled Error and write");
    }
    function testEarlierHelperPanicIsNotALaterError() external {
        CatchControl control = new CatchControl();
        try control.helperFirst() { revert("must reject"); }
        catch Panic(uint256 code) { require(code == 1, "assertion Panic propagates"); }
        require(!control.completed(), "the nonmatching Error catch cannot commit");
    }
    function testFalseCustomBranchDoesNotRevert() external {
        BooleanGuard guard = new BooleanGuard();
        guard.conditionalCustom(false);
    }
    function testTrueCustomBranchAndUnconditionalCustomRevert() external {
        BooleanGuard guard = new BooleanGuard();
        bool rejected;
        try guard.conditionalCustom(true) {} catch { rejected = true; }
        require(rejected, "chosen custom branch fails");
        rejected = false;
        try guard.unconditionalCustom(false) {} catch { rejected = true; }
        require(rejected, "unconditional custom failure");
    }
    function testEarlierAssignmentOverridesEntryAtCall() external {
        CatchControl control = new CatchControl();
        require(control.changedEntry(false) && control.completed(), "call receives reassigned true");
    }
    function testHandledReturnSkipsLaterWrite() external {
        CatchControl control = new CatchControl();
        require(!control.returningCatch() && !control.completed(), "catch returns without later write");
    }
    function testNamedStringReasonMatchesErrorCatch() external {
        CatchControl control = new CatchControl();
        control.namedReason();
        require(control.completed(), "string-typed reason uses Error(string)");
    }
    function testTupleAssignmentChangesReceiver() external {
        IIdentity target = IIdentity(address(new IdentityOne()));
        (target,) = (IIdentity(address(new IdentityTwo())), 1);
        require(target.identity() == 2, "tuple assignment keeps the new receiver");
    }
    function testDeleteClearsReceiver() external {
        IIdentity target = IIdentity(address(new IdentityOne()));
        delete target;
        require(address(target) == address(0), "delete resets the local reference");
    }
    function testConstructorParameterDoesNotWriteImmutable() external {
        ShadowedInitializer target = new ShadowedInitializer(IIdentity(address(0)));
        require(target.identity() == 2, "parameter assignment does not initialize state");
    }
    function testPanicCatchDoesNotHandleErrorString() external {
        CatchControl control = new CatchControl();
        try control.panicOnly() { revert("must reject"); }
        catch Error(string memory reason) { require(keccak256(bytes(reason)) == keccak256("rejected"), "original Error propagated"); }
        require(!control.completed(), "unmatched catch cannot commit continuation");
    }
    function testMatchingErrorCatchContinues() external {
        CatchControl control = new CatchControl();
        control.matchingError();
        require(control.completed(), "matching empty catch continues");
    }
    function testRethrowDoesNotCommitContinuation() external {
        CatchControl control = new CatchControl();
        try control.rethrowError() { revert("must reject"); }
        catch Error(string memory reason) { require(keccak256(bytes(reason)) == keccak256("again"), "catch rethrew"); }
        require(!control.completed(), "rethrow prevents continuation");
    }
    function testGenericCatchHandlesOtherErrorClass() external {
        CatchControl control = new CatchControl();
        control.fallbackCatch();
        require(control.completed(), "generic catch handles Error");
    }
    function testPanicCatchHandlesAssertFailure() external {
        CatchControl control = new CatchControl();
        control.matchingPanic();
        require(control.completed(), "matching Panic continues");
    }
    function testRepeatedInvocationsDoNotShareInput() external {
        BooleanGuard guard = new BooleanGuard();
        require(guard.unchanged(true) && !guard.unchanged(false), "separate invocation values");
    }
    function testSourceAssignmentChangesParameter() external {
        BooleanGuard guard = new BooleanGuard();
        require(!guard.reassigned(true), "the explicit assignment changes this invocation");
    }
}
