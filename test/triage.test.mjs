import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ceilingOf, invalidationCriteria, platforms, severityCriteria, triageOptions } from "../src/triage.mjs";

/** A criteria directory shaped like the real one, so parsing is tested not mocked. */
const fixture = () => {
  const dir = mkdtempSync(join(tmpdir(), "jev-judging-"));
  writeFileSync(join(dir, "severity-criteria.md"), [
    "| Severity | Definition |",
    "| --- | --- |",
    "| **Critical** | Funds stolen without admin keys |",
    "| **High** | Funds at risk under specific conditions |",
    "| **Low** | Best practice violations |",
  ].join("\n"));
  writeFileSync(join(dir, "invalidation-library.md"), [
    "## DUST_IMPACT", "", "**DI-1: Rounding bounded to 1 wei**", "**DI-2: Does not compound**", "",
    "## EXISTING_GUARD", "", "**EG-1: Access control prevents it**",
  ].join("\n"));
  writeFileSync(join(dir, "criteria-sherlock.md"), [
    "| ID | Rule | Result |",
    "| --- | --- | --- |",
    "| AI-4 | Zero address check | INVALID |",
    "| AI-7 | Admin action that breaks assumptions | INVALID |",
  ].join("\n"));
  writeFileSync(join(dir, "criteria-cantina.md"), [
    "| ID | Rule | Result |",
    "| --- | --- | --- |",
    "| AI-2 | Requires admin/owner access to execute | Low at most |",
    "| AI-4 | Approval/ERC20 race condition | INVALID |",
  ].join("\n"));
  return dir;
};

test("severity definitions are read from the criteria table", () => {
  const s = severityCriteria(fixture());
  assert.deepEqual(Object.keys(s), ["Critical", "High", "Low"]);
  assert.match(s.Critical, /Funds stolen/);
});

test("invalidation classes carry their own reasons", () => {
  const inv = invalidationCriteria(fixture());
  assert.deepEqual(Object.keys(inv).sort(), ["DUST_IMPACT", "EXISTING_GUARD"]);
  assert.equal(inv.DUST_IMPACT.reasons.length, 2);
});

test("platforms are discovered, not hard-coded", () => {
  assert.deepEqual(platforms(fixture()).sort(), ["cantina", "sherlock"]);
});

// The ceiling is stated by the rule; reading it wrong turns a cap into a rejection.
test("a rule's ceiling is read from its own result column", () => {
  assert.equal(ceilingOf("INVALID"), "INVALID");
  assert.equal(ceilingOf("Low at most"), "Low");
  assert.equal(ceilingOf("Informational at most"), "Informational");
  assert.equal(ceilingOf("Downgrade: H->M"), "DOWNGRADE");
  assert.equal(ceilingOf(""), null);
});

// 96 flat options made Jev pick a near-identical neighbour; the set must stay decidable.
test("the option set is small, and every categorical class carries a ceiling", () => {
  const o = triageOptions(fixture());
  assert.ok(Object.keys(o).length <= 20, `${Object.keys(o).length} options is too many to decide between`);
  assert.equal(o.NONE.ceiling, null);
  assert.equal(o.TRUSTED_ACTOR_REQUIRED.ceiling, "Low");
  assert.equal(o.CATEGORICALLY_EXCLUDED.ceiling, "INVALID");
  assert.equal(o.DUST_IMPACT.ceiling, "Low");
});

test("categorical buckets cite the real rules they came from", () => {
  const o = triageOptions(fixture());
  assert.ok(o.CATEGORICALLY_EXCLUDED.examples.some((e) => /zero address/i.test(e)));
  assert.ok(o.TRUSTED_ACTOR_REQUIRED.examples.some((e) => /admin/i.test(e)));
});

test("a missing criteria directory is reported, not crashed through", () => {
  const nowhere = join(tmpdir(), "definitely-not-here");
  assert.equal(severityCriteria(nowhere), null);
  assert.equal(invalidationCriteria(nowhere), null);
  assert.deepEqual(platforms(nowhere), []);
});
