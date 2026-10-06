'use strict';
// Keep the complete report, but never mistake a proposed edit for current code.
const normalize = text => text.toLowerCase().replace(/[^a-z]/g, '');
const fieldNames = new Set(['severity', 'location', 'locations', 'references', 'summary', 'summarydescription', 'description', 'rootcause', 'conditions', 'preconditions', 'impact', 'mitigation', 'recommendation', 'recommendations', 'attackpath', 'expectedbehavior', 'actualbehavior']);
const proposed = new Set(['mitigation', 'recommendation', 'recommendations', 'recommendedmitigationsteps', 'recommendedmitigation', 'suggestedfix', 'proposedfix']);
const discussion = new Set(['discussion', 'adjudication', 'counterarguments', 'sponsorresponse', 'judgeresponse']);
for (const name of [...proposed, ...discussion, 'proofofconcept', 'poc', 'output', 'code', 'vulnerablecode', 'currentcode']) fieldNames.add(name);
function content(body = '') {
  const sections = [], fields = {}; let active = '', lines = [], fence = null, role = 'reporter-allegation';
  const headings = [];
  const flush = () => {
    const text = lines.join('\n').trim();
    if (text) { sections.push({ field: active, text, proposed: role === 'proposed-change', role });
      // A nested "Description" under a proposed edit is not the finding's
      // current baseline/expected behavior field. Raw sections remain intact.
      if (active && (role !== 'proposed-change' || proposed.has(active))) fields[active] = [fields[active], text].filter(Boolean).join('\n\n'); }
  };
  for (const line of body.split(/\r?\n/)) {
    const delimiter = line.match(/^\s*(`{3,}|~{3,})/);
    if (delimiter) { if (!fence) fence = delimiter[1]; else if (delimiter[1][0] === fence[0] && delimiter[1].length >= fence.length) fence = null; lines.push(line); continue; }
    const marker = !fence && (line.match(/^\s*\*\*([^*]+)\*\*\s*:?\s*(.*)$/) || line.match(/^#{2,6}\s+(.+)$/) || line.match(/^\s*([A-Za-z][A-Za-z /-]{2,30}):\s*(.*)$/));
    if (marker && (fieldNames.has(normalize(marker[1])) || /^\s*(?:\*\*|#{2,6}\s)/.test(line))) {
      flush(); active = normalize(marker[1]);
      const level = line.match(/^(#{2,6})\s/)?.[1].length || 2;
      while (headings.length && headings.at(-1).level >= level) headings.pop();
      const inherited = headings.at(-1)?.role;
      role = inherited === 'proposed-change' ? inherited : proposed.has(active) ? 'proposed-change' : discussion.has(active) ? 'discussion' :
        ['proofofconcept', 'poc', 'output'].includes(active) ? 'reported-poc-output' : ['code', 'vulnerablecode', 'currentcode'].includes(active) ? 'reported-code' : inherited || 'reporter-allegation';
      headings.push({ level, role }); lines = [marker[2] || ''];
    }
    else lines.push(line);
  }
  flush();
  return { sections, fields, current: sections.filter(section => !section.proposed && section.field !== 'severity').map(section => section.text).join('\n\n'),
    proposed: sections.filter(section => section.proposed).map(section => section.text).join('\n\n') };
}
function reportQuery(issue = {}) {
  const parsed = content(issue.reportText || issue.body || '');
  const fields = { ...parsed.fields, ...issue.fields };
  const excluded = new Set(parsed.sections.filter(section => section.proposed).map(section => section.field));
  const pieces = [issue.title, parsed.current, ...Object.entries(fields).filter(([key]) => !proposed.has(key) && !excluded.has(key) && key !== 'severity').map(([, value]) => value)];
  return [...new Set(pieces.filter(Boolean))].join('\n\n');
}
function mentions(text) {
  const result = [], seen = new Set();
  const pattern = /\b(?:(?<contract>[A-Za-z_$][\w$]*)\s*(?:::|\.)\s*)?(?<name>[A-Za-z_$][\w$]*)\s*\((?<args>[^()\n]*)\)/g;
  for (const match of text.matchAll(pattern)) {
    const { contract: receiver, name, args } = match.groups;
    const contract = receiver && /^[A-Z]/.test(receiver) ? receiver : null;
    if (['if', 'for', 'while', 'require', 'assert', 'function', 'returns', 'mapping'].includes(name)) continue;
    const params = args.split(',').map(part => part.trim());
    const typed = !args.trim() || params.every(part => /^(?:u?int\d*|address|bool|string|bytes\d*)(?:\[\d*\])*(?:\s+(?:memory|calldata|storage|payable))*$/.test(part));
    const signature = typed && (args.trim() || contract) ? `${name}(${args.trim() ? params.map(canonicalType).join(',') : ''})` : null;
    const key = [contract, name, signature].join(':'); if (seen.has(key)) continue; seen.add(key);
    result.push({ contract: contract || null, receiver: receiver || null, name, signature, callExpression: !!receiver && !contract, text: match[0] });
  }
  // Reports commonly name Contract.method without a parameter list. A receiver
  // expression such as manager.take(a, b) is not a declaration signature.
  for (const match of text.matchAll(/\b([A-Z][\w$]*)\s*(?:::|\.)\s*([A-Za-z_$][\w$]*)\b(?!\s*\()/g)) {
    if (result.some(item => item.contract === match[1] && item.name === match[2])) continue;
    result.push({ contract: match[1], receiver: match[1], name: match[2], signature: null, text: match[0] });
  }
  return result;
}
function canonicalType(text) { return text.replace(/\s+(memory|calldata|storage|payable)\b/g, '').trim().replace(/^uint(?=\b|\[)/, 'uint256').replace(/^int(?=\b|\[)/, 'int256'); }
function functionSignature(header, name) {
  const params = header.match(/\(([^)]*)\)/)?.[1];
  if (params == null) return '';
  // Complex function/mapping types are deliberately not guessed by this helper.
  if (/[()]/.test(params)) return '';
  return `${name}(${params.trim() ? params.split(',').map(part => canonicalType(part.trim().replace(/\s+(memory|calldata|storage|payable)\b/g, '').split(/\s+/)[0])).join(',') : ''})`;
}
module.exports = { content, fieldNames, normalize, reportQuery, mentions, functionSignature };
