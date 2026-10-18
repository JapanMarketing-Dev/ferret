#!/usr/bin/env node
import { main } from './index.js';

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (e: unknown) => {
    process.stderr.write(`ferret-video: ${(e as Error)?.stack ?? String(e)}\n`);
    process.exitCode = 1;
  },
);
