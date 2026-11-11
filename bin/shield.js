#!/usr/bin/env node
'use strict';

const { main } = require('../src/cli');

main(process.argv.slice(2))
  .then((code) => {
    process.exit(code ?? 0);
  })
  .catch((err) => {
    const message = err && err.message ? err.message : String(err);
    console.error(message);
    process.exit(1);
  });
