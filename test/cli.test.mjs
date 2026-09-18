import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const JEV = join(dirname(dirname(fileURLToPath(import.meta.url))), "bin", "jev.mjs");

/**
 * Run a subcommand fully isolated: HOME holds the ledger, TMPDIR holds the session journal.
 * Isolating only one of them leaves the test reading a developer's real sessions.
 */
const run = (...args) =>
  spawnSync(process.execPath, [JEV, ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      HOME: mkdtempSync(join(tmpdir(), "jev-home-")),
      TMPDIR: mkdtempSync(join(tmpdir(), "jev-tmp-")),
      JEV_DEBUG: "",
    },
  });

// Every subcommand is a separate entry point, and a bad import in one is invisible to the
// unit tests that only reach the modules directly. These load each one for real.

test("help lists the subcommands", () => {
  const { status, stdout } = run("help");
  assert.equal(status, 0);
  for (const cmd of ["stats", "why", "try", "doctor", "reset"]) assert.match(stdout, new RegExp(`jev ${cmd}`));
});

test("try scores a prompt without running anything", () => {
  const { status, stdout } = run("try", "why does the withdrawal path intermittently revert under concurrent load?");
  assert.equal(status, 0);
  assert.match(stdout, /strong/);
  assert.match(stdout, /dry run/);
});

test("try routes mechanical work to the cheapest tier", () => {
  assert.match(run("try", "rename the foo variable to bar").stdout, /fast/);
});

test("try without a prompt explains itself instead of crashing", () => {
  const { status, stdout } = run("try");
  assert.equal(status, 0);
  assert.match(stdout, /Usage/);
});

test("stats on an empty ledger says so rather than dividing by zero", () => {
  const { status, stdout } = run("stats");
  assert.equal(status, 0);
  assert.match(stdout, /No turns recorded/);
});

test("why with no session reports that, and does not throw", () => {
  const { status, stdout } = run("why");
  assert.equal(status, 0);
  assert.match(stdout, /no routing decision/i);
});

test("doctor reports every check and exits on the result", () => {
  const { status, stdout } = run("doctor");
  assert.ok(status === 0 || status === 1);
  for (const check of ["Node", "Claude Code", "Routing backend", "Ledger", "Boundaries"]) {
    assert.match(stdout, new RegExp(check));
  }
});

test("reset is safe to run when there is nothing to reset", () => {
  const { status, stdout } = run("reset");
  assert.equal(status, 0);
  assert.match(stdout, /Cleared/);
});

test("version prints the package version", () => {
  assert.match(run("version").stdout.trim(), /^\d+\.\d+\.\d+$/);
});
