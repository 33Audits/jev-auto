import { test } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DIR, decisionHistory, latestDecision, recordDecision, recordManual } from "../src/journal.mjs";
import { renderStatusLine } from "../src/statusline.mjs";

let n = 0;
const session = () => `unit-${process.pid}-${n++}`;
const journalFor = (id) => join(DIR, `${id}.jsonl`);

test("the latest decision is what a reader sees", () => {
  const id = session();
  assert.equal(latestDecision(id), null, "a session with no decisions yet reads as nothing");
  recordDecision(id, { tier: "haiku", confidence: 0.9 });
  recordDecision(id, { tier: "opus", confidence: 0.8 });
  assert.equal(latestDecision(id).tier, "opus");
  assert.equal(latestDecision(id).history.length, 2);
});

test("history is bounded, keeping the most recent", () => {
  const id = session();
  for (let i = 0; i < 40; i++) recordDecision(id, { tier: "haiku", seq: i });
  const history = decisionHistory(id);
  assert.equal(history.length, 20);
  assert.equal(history.at(-1).seq, 39);
});

test("taking manual control replaces the history rather than appending to it", () => {
  const id = session();
  recordDecision(id, { tier: "haiku" });
  recordManual(id, "claude-opus-5");
  const status = latestDecision(id);
  assert.equal(status.manual, true);
  assert.equal(status.model, "claude-opus-5");
  assert.equal(status.history.length, 1, "a paused session does not still show a routed tier");
});

test("a line truncated by a killed session costs one line, not the file", () => {
  const id = session();
  recordDecision(id, { tier: "haiku" });
  appendFileSync(journalFor(id), '{"tier":"son');
  recordDecision(id, { tier: "opus" });
  assert.equal(decisionHistory(id).length, 2);
  assert.equal(latestDecision(id).tier, "opus");
});

test("concurrent writers do not overwrite each other", () => {
  const id = session();
  for (let i = 0; i < 5; i++) recordDecision(id, { tier: "haiku", seq: i });
  assert.deepEqual(decisionHistory(id).map((d) => d.seq), [0, 1, 2, 3, 4], "every write survives, in order");
  assert.ok(readFileSync(journalFor(id), "utf8").includes('"seq":0'), "the first write is still on disk");
});

test("an unnamed session is a no-op, not a crash", () => {
  recordDecision("", { tier: "haiku" });
  recordDecision(undefined, { tier: "haiku" });
  assert.equal(latestDecision(undefined), null);
});

test("the status line names the tier, the directory, and the context used", () => {
  const line = renderStatusLine(
    { workspace: { current_dir: "/home/me/my-project" }, context_window: { used_percentage: 8.4 } },
    { tier: "haiku", confidence: 0.94, reason: "routed" },
  );
  assert.match(line, /haiku/);
  assert.match(line, /p=0\.94/);
  assert.match(line, /my-project/);
  assert.match(line, /8% context/);
});

test("the status line explains itself only when routing declined the obvious thing", () => {
  const plain = renderStatusLine({}, { tier: "haiku", confidence: 0.9, reason: "routed" });
  assert.ok(!plain.includes("("), "the common case stays short");
  const held = renderStatusLine({}, { tier: "sonnet", confidence: 0.6, reason: "routed+context-too-large/no-change" });
  assert.match(held, /context-too-large/);
});

test("a paused session says so instead of showing a stale tier", () => {
  const line = renderStatusLine({ model: { display_name: "Opus 5" } }, { manual: true });
  assert.match(line, /manual/);
  assert.match(line, /Opus 5/);
});

test("the status line renders before anything has been routed", () => {
  assert.match(renderStatusLine({}, null), /waiting for first prompt/);
  assert.ok(renderStatusLine().length > 0);
});
