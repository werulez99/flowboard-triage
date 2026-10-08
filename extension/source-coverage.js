'use strict';
// Mechanical reading coverage only, never semantic or execution proof.
function contains(expected, supplied, read = false) {
  if (!expected?.source || !supplied?.complete || !supplied.source ||
      supplied.source.file !== expected.source.file || supplied.source.sourceHash !== expected.source.sourceHash ||
      supplied.source.line > expected.source.line || supplied.source.endLine < expected.source.endLine ||
      read && (supplied.readThrough || supplied.source.line - 1) < expected.source.endLine && !covers(supplied.readRanges,expected.source.line,expected.source.endLine)) return false;
  const lines = supplied.code.split('\n');
  return lines.length === supplied.source.endLine - supplied.source.line + 1 &&
    lines.slice(expected.source.line - supplied.source.line, expected.source.endLine - supplied.source.line + 1).join('\n') === expected.code;
}
function ranges(supplied){return supplied?.providedRanges||[{line:supplied?.line,endLine:supplied?.endLine}];}
function covers(ranges,line,endLine){return (ranges||[]).some(r=>r.line<=line&&r.endLine>=endLine);}
function read(unit,line,endLine){return (unit.readThrough??unit.source.line-1)>=endLine||covers(unit.readRanges,line,endLine);}
module.exports = { contains, ranges, covers, read };
