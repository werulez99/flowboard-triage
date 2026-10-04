'use strict';
const { mentions, content } = require('./report-content');
// Applicability is checked before lexical expansion, including for old imports.
// Only explicit title/root-cause declarations are mandatory; a member call on
// a variable is an operation to inspect, not a named contract definition.
function inspect(catalog, title = '', body = '') {
  const qualified = mentions(title).filter(item => item.contract && !/\.sol\b/.test(item.text));
  const selected = [], blockers = [];
  for (const item of qualified) {
    const matches = catalog.mentioned(item);
    if (matches.length === 1) selected.push(matches[0]);
    else if (!matches.length) blockers.push(`The report names ${item.text}, but no matching definition exists in this project's indexed code. Check the project folder, imports or report version. No similar function was substituted.`);
    else blockers.push(`The report names ${item.text}, but ${matches.length} definitions match. The required implementation or signature is not established.`);
  }
  const sections = content(body), location = sections.fields.location || sections.fields.locations || '';
  const cited = [...location.matchAll(/(?:[\w.@-]+[\\/])*[\w.@-]+\.sol\b/g)].map(match => match[0]);
  const paths = [...catalog.sourceStamps.keys()];
  for (const file of cited) if (!require('./source-path').resolve(catalog.root, file, paths)) blockers.push(`The report's code file ${file} is not present unambiguously in the indexed project. Confirm the checkout or supply that dependency.`);
  return { selected: [...new Map(selected.map(fn => [catalog.key(fn), fn])).values()], blockers: [...new Set(blockers)], named: qualified.map(item => item.text) };
}
module.exports = { inspect };
