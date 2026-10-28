#!/usr/bin/env node
// The orchestrator's only way to change factory state. See ../references/state.md.
import { run } from "./lib/cli.mjs";

const code = run(process.argv.slice(2), {
  env: process.env,
  cwd: process.cwd(),
  out: (line) => process.stdout.write(`${line}\n`),
  err: (line) => process.stderr.write(`${line}\n`)
});
process.exitCode = code;
