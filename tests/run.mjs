// Test entry point.
//
// Deliberately does NOT use `node --test <path>`: this repo's CI invokes
// `pnpm test --if-present`, and pnpm appends `--if-present` to the script's
// argv while not expanding globs the way an interactive shell does. Under
// `node --test` that combination silently resolved to ZERO test files and
// still exited 0 — a green step that ran nothing.
//
// Importing the suites here instead makes the run independent of argv: the
// node:test harness executes every registered test in-process and sets a
// non-zero exit code if any of them fails. Extra arguments are ignored.
//
// Add a suite by importing it below.

import "./flow-contract.test.mjs";
import "./lifecycle-d-w6-declaration.test.mjs";
import "./lifecycle-d-w8-flow.test.mjs";
