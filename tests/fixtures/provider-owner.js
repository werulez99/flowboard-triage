'use strict';
// Controlled local crash/ownership fixture. No model, network or protocol use.
const fs = require('node:fs');
const ownership = require('../../extension/provider-ownership');
const [mode, file] = process.argv.slice(2);
const sleepForever = () => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
if (mode === 'empty-held') {
  const descriptor = fs.openSync(file, 'wx', 0o600);
  process.send?.({ ready: true, pid: process.pid, descriptor });
  setInterval(() => {}, 1000);
} else if (mode === 'metadata-held') {
  ownership.publish(file, ownership.ownerMetadata());
  process.send?.({ ready: true, pid: process.pid });
  setInterval(() => {}, 1000);
} else if (mode === 'before-publish' || mode === 'after-publish') {
  const original = fs.linkSync;
  fs.linkSync = (...args) => {
    if (mode === 'after-publish') original(...args);
    process.send?.({ ready: true, pid: process.pid });
    sleepForever();
  };
  ownership.publish(file, ownership.ownerMetadata());
} else throw new Error('Unknown controlled ownership mode.');
