'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { parseReport } = require('../extension/report'), { content, reportQuery } = require('../extension/report-content');
test('explicit Issue/Finding severity identifiers retain legacy identity and ignore fenced pseudo findings', () => {
  const report = '# Issue H-1: First\nDescription\n\n```md\n# Issue M-7: Not a finding\n```\n\n# Finding M-2: Second\nOther description';
  assert.deepEqual(parseReport(report).map(item => item.id), ['H-1', 'M-2']);
  assert.equal(parseReport('## [H-1] First\nDescription')[0].id, 'H-1');
  assert.equal(parseReport('## Issue 1: First\nDescription')[0].id, 'F-1');
});
test('nested proposed fixes cannot enter current baseline query; contrary discussion stays attributed', () => {
  const body = '## Description\nCurrent brokenRule() allegation.\n\n## Recommended Mitigation Steps\n### Code change\n```solidity\nfixedRule();\n```\n### Discussion\nProposed explanation.\n\n## Discussion\nThe reviewer disputes brokenRule() because the guard rejects it.\n\n## Proof of Concept\nReported output, not a host observation.';
  const parsed = content(body), query = reportQuery({ body });
  assert.equal(parsed.sections.find(item => item.field === 'codechange').role, 'proposed-change');
  assert.equal(parsed.sections.filter(item => item.field === 'discussion')[0].proposed, true);
  assert.equal(parsed.sections.filter(item => item.field === 'discussion')[1].role, 'discussion');
  assert.match(query, /reviewer disputes/); assert.doesNotMatch(query, /fixedRule|Proposed explanation/);
  assert.equal(parsed.sections.at(-1).role, 'reported-poc-output');
  assert.ok(parseReport('# Issue H-1: Report\n' + body)[0].body.includes('fixedRule();'), 'Complete original body stays intact.');
  const nested = content('## Description\nOld behavior.\n## Suggested Fix\n### Description\nNew behavior.\n### Expected Behavior\nNew promise.');
  assert.equal(nested.fields.description, 'Old behavior.'); assert.equal(nested.fields.expectedbehavior, undefined);
});
