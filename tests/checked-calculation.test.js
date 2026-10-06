'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), { problem } = require('../extension/checked-calculation');
test('bounded literal uint256 comparisons reject wrong rounding, zero denominator and overflow without executing strings', () => {
  assert.equal(problem({ before: '135', operation: '/ 100', after: '1' }), null);
  assert.match(problem({ before: '135', operation: '/ 100', after: '2' }), /rounds down/);
  assert.match(problem({ before: '1', operation: '/ 0', after: '0' }), /zero/);
  assert.match(problem({ before: '0', operation: '- 1', after: '0' }), /underflows/);
  assert.match(problem({ before: String(2n ** 256n - 1n), operation: '+ 1', after: '0' }), /overflows/);
  assert.equal(problem({ before: 'S', operation: '= suppliedSnapshot', after: 'S' }), null, 'Symbolic semantics still need substantive source review.');
  assert.equal(problem({ before: '1', operation: 'process.exit()', after: '0' }), null, 'No arbitrary string is evaluated or treated as a checked calculation.');
});
