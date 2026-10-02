'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { parse } = require('../extension/webview/report-view');
test('reader recognizes prose, fields, lists, fenced code and tables without flattening the whole report', () => {
  const blocks = parse('**Severity**: Info\n\n**Summary/Description**\nReadable **claim** and `src/Demo.sol:8`.\n\n1. First observation\n2. Second observation\n\n```solidity\nfunction sample() {}\n```\n\n| Source | Meaning |\n| --- | --- |\n| Demo | Fixture |');
  assert.deepEqual(blocks.map(block => block.type), ['heading', 'paragraph', 'heading', 'paragraph', 'list', 'code', 'table']);
  assert.equal(blocks[4].items.length, 2); assert.equal(blocks[5].text, 'function sample() {}');
});
test('raw HTML and hostile link text remain data, not parsed executable blocks', () => {
  const blocks = parse('<script>window.injected=true</script>\n\n[Unsafe](javascript:alert(1))');
  assert.ok(blocks.every(block => block.type === 'paragraph'));
  assert.match(blocks[0].text, /<script>/);
});
test('bounded reading view clearly marks oversized text rather than hanging', () => {
  const blocks = parse('x'.repeat(200100));
  assert.equal(blocks[0].text.length, 200000); assert.match(blocks.at(-1).text, /truncated/);
});
