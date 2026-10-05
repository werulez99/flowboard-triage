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
    function requireAccepted(bool accepted) external pure { require(accepted, "rejected"); }
    function assertAccepted(bool accepted) external pure { assert(accepted); }
    function unchanged(bool accepted) external pure returns (bool) { return accepted; }
    function reassigned(bool accepted) external pure returns (bool) { accepted = false; return accepted; }
}

contract CatchControl {
    BooleanGuard immutable guard = new BooleanGuard();
    bool public completed;
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
