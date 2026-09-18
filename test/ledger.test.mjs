import { test } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { append, costOf, read, toSchema, stats } from "../src/ledger.mjs";

const turn = (over = {}) => ({
  t: 1, shape: "hard0/std/files1/mid", tier: "sonnet", backend: "local",
  score: 0.3, conf: 0.8, verdict: "ok", code: null,
  in: 1000, out: 500, cacheRead: 0, cacheWrite: 0, ...over,
});

test("a record never carries prompt text, file names, or model output", () => {
  const dirty = toSchema({
    ...turn(),
    prompt: "the user's secret prompt",
    files: ["src/secret.ts"],
    response: "model output",
    code: "freeform judge prose that quotes the content",
  });
  assert.deepEqual(Object.keys(dirty).sort(), [
    "backend", "cacheRead", "cacheWrite", "code", "conf", "in", "out", "score", "shape", "t", "tier", "verdict",
  ]);
  assert.equal(dirty.code, null, "an off-vocabulary reason code is dropped, not stored");
  assert.ok(!JSON.stringify(dirty).includes("secret"));
});

test("only known verdicts and tiers survive", () => {
  const r = toSchema({ ...turn(), tier: "gpt-9", verdict: "maybe" });
  assert.equal(r.tier, "unknown");
  assert.equal(r.verdict, "ok");
});

test("a round trip through the file preserves the record", () => {
  const file = join(mkdtempSync(join(tmpdir(), "jev-")), "turns.jsonl");
  append(turn(), file);
  append(turn({ tier: "haiku", verdict: "escalated", code: "redo" }), file);
  const records = read(file);
  assert.equal(records.length, 2);
  assert.equal(records[1].code, "redo");
});

test("a truncated line is skipped, not fatal", () => {
  const file = join(mkdtempSync(join(tmpdir(), "jev-")), "turns.jsonl");
  append(turn(), file);
  appendFileSync(file, '{"t":1,"tie\n'); // a half-written record, the realistic corruption
  append(turn({ tier: "haiku" }), file);
  assert.equal(read(file).length, 2);
});

test("a missing ledger reads as empty, not an error", () => {
  assert.deepEqual(read(join(tmpdir(), "definitely-not-here", "x.jsonl")), []);
});

test("cost scales with the tier the turn actually ran on", () => {
  const r = turn();
  assert.ok(costOf(r, "opus") > costOf(r, "sonnet"));
  assert.ok(costOf(r, "sonnet") > costOf(r, "haiku"));
});

test("savings are measured against pinning everything to the strongest tier", () => {
  const s = stats([turn({ tier: "haiku" }), turn({ tier: "haiku" }), turn({ tier: "opus" })]);
  assert.equal(s.turns, 3);
  assert.ok(s.saved > 0);
  assert.ok(s.savedPct > 0 && s.savedPct < 1);
  assert.equal(s.byTier.haiku.turns, 2);
});

test("escalation rate is per tier", () => {
  const s = stats([
    turn({ tier: "haiku", verdict: "escalated", code: "redo" }),
    turn({ tier: "haiku" }),
    turn({ tier: "opus" }),
  ]);
  assert.equal(s.byTier.haiku.escalationRate, 0.5);
  assert.equal(s.byTier.opus.escalationRate, 0);
});

test("an empty ledger produces zeros, not NaN", () => {
  const s = stats([]);
  assert.equal(s.turns, 0);
  assert.equal(s.savedPct, 0);
  assert.ok(Number.isFinite(s.saved));
});

test("a record truncated by a kill does not take the next one with it", () => {
  const file = join(mkdtempSync(join(tmpdir(), "jev-")), "turns.jsonl");
  append(turn(), file);
  appendFileSync(file, '{"t":1,"tier":"son'); // killed mid-write, no terminator
  append(turn({ tier: "opus" }), file);
  const records = read(file);
  assert.equal(records.length, 2, "only the truncated record is lost");
  assert.equal(records.at(-1).tier, "opus");
});
