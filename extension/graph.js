'use strict';
function layoutGraph(nodes, connections) {
  const byId = new Map(nodes.map(node => [node.id, node]));
  const incoming = new Map(nodes.map(node => [node.id, []]));
  for (const edge of connections) if (byId.has(edge.from) && byId.has(edge.to) && edge.from !== edge.to) incoming.get(edge.to).push(edge.from);
  // Stable depth with cycle protection. A cycle stays visible rather than causing
  // recursive layout/flow expansion to hang or fabricating a linear chronology.
  const depth = new Map(), visiting = new Set();
  function level(id) {
    if (depth.has(id)) return depth.get(id);
    if (visiting.has(id)) return 0;
    visiting.add(id);
    let value = 0;
    for (const parent of incoming.get(id)) value = Math.max(value, Math.min(nodes.length - 1, level(parent) + 1));
    visiting.delete(id); depth.set(id, value); return value;
  }
  const widths = new Map(), columns = new Map();
  for (const node of nodes) {
    const column = level(node.id);
    const longest = Math.max(0, ...node.code.split('\n').map(line => line.length));
    const width = Math.max(590, Math.min(1400, longest * 7.6 + 100));
    widths.set(column, Math.max(widths.get(column) || 0, width));
    if (!columns.has(column)) columns.set(column, []);
    columns.get(column).push(node);
  }
  let x = 30;
  for (const column of [...columns.keys()].sort((a, b) => a - b)) {
    let y = 30;
    for (const node of columns.get(column)) {
      node.x = x; node.y = y;
      // Native Flowboard shows the complete function: reserve the whole height,
      // including modifier/trait rows, so long functions cannot overlap.
      y += node.code.split('\n').length * 24 + 260 + (node.reviewNoteHeight || 0);
    }
    x += widths.get(column) + 110;
  }
  return nodes;
}
module.exports = { layoutGraph };
