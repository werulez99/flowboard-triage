'use strict';
// Deterministic subprocess transport fixture. It is not a model response or an
// evidence/guide acceptance fixture, and makes no network/provider request.
let input = '';
process.stdin.setEncoding('utf8'); process.stdin.on('data', chunk => { input += chunk; });
process.stdin.on('end', async () => {
  if (!input.includes('fictional-transport-check')) process.exit(2);
  const value = { text: '// café source; \u0431\u044a\u043b\u0433\u0430\u0440\u0441\u043a\u0438 🧪', source: 'function read() external {}' };
  const output = process.argv[2] === 'claude' ? JSON.stringify({ structured_output: value, usage: { input_tokens: 11, output_tokens: 7 }, total_cost_usd: 0, modelUsage: { 'fixture-not-a-model': {} } }) :
    [ { type: 'thread.started', thread_id: 'fixture-only' }, { type: 'item.completed', item: { type: 'agent_message', text: JSON.stringify(value) } },
      { type: 'turn.completed', usage: { input_tokens: 11, output_tokens: 7 } } ].map(event => JSON.stringify(event)).join('\n');
  const bytes = Buffer.from(output);
  for (let i = 0; i < bytes.length; i++) {
    process.stdout.write(bytes.subarray(i, i + 1));
    await new Promise(resolve => setTimeout(resolve, 1));
  }
});
