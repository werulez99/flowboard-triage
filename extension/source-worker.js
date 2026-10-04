'use strict';
const { parentPort, workerData } = require('node:worker_threads');
const { analyze } = require('./runner-adapter');

analyze(workerData.extensionPath, workerData.root, { mode: 'source' }).then(({ result, diagnostics }) => {
  parentPort.postMessage({ result, diagnostics });
}).catch(error => {
  parentPort.postMessage({ error: { message: error.message, code: error.code } });
});
