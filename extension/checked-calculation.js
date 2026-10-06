'use strict';
// Narrow sanity check for a displayed literal uint256 state comparison.
// No eval, expression execution or inferred runtime state. Symbolic arguments
// still require their existing source/evidence and substantive event review.
function problem(change) {
  const literal = value => typeof value === 'string' && /^\d{1,78}$/.test(value);
  const operation = typeof change.operation === 'string' && /^([+*/%=-])\s*(\d{1,78})$/.exec(change.operation.trim());
  if (!literal(change.before) || !literal(change.after) || !operation) return null;
  const before = BigInt(change.before), operand = BigInt(operation[2]), after = BigInt(change.after), limit = 2n ** 256n;
  if ([before, operand, after].some(value => value >= limit)) return 'The literal unsigned calculation exceeds uint256.';
  if (['/', '%'].includes(operation[1]) && operand === 0n) return 'The displayed calculation divides by zero.';
  const result = ({ '+': () => before + operand, '-': () => before - operand, '*': () => before * operand,
    '/': () => before / operand, '%': () => before % operand, '=': () => operand })[operation[1]]();
  if (result < 0n || result >= limit) return 'The displayed calculation overflows or underflows; it cannot be a successful checked uint256 result.';
  return result === after ? null : 'The displayed result does not match the literal integer operation (division rounds down).';
}
module.exports = { problem };
