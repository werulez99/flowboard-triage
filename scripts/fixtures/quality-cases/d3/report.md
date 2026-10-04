### [I-01] Anyone can leave a rejected review marked finished

**Location**: src/ReviewQueue.sol:17
**Description**
ReviewQueue::finalize(uint256,bool) is external, so any caller can mark a review finished. It writes finished[key] before rejecting accepted=false. The written flag therefore remains true even after that rejection.
**Expected behavior**
Only the designated reviewer can finalize a review. Rejection must leave the old flag unchanged.
**Conditions**
An ordinary caller different from the designated reviewer, or a reviewer passing accepted=false.
