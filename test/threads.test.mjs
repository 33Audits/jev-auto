import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readdirSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { dirOf, load, save, sweep } from "../src/threads.mjs";
import { wire } from "../src/wire.mjs";

let n = 0;
const key = () => `t${process.pid}x${n++}`;

test("state survives a process that did not create it", () => {
  const k = key();
  assert.equal(load(k), null, "an unknown conversation starts clean");
  save(k, { tier: "fast", model: "claude-haiku-4-5", floor: null, floorTurns: 0 });
  assert.equal(load(k).tier, "fast", "a later invocation of the same conversation sees it");
});

test("an escalation floor survives too — it is the expensive thing to forget", () => {
  const k = key();
  save(k, { tier: "balanced", model: "m", floor: "strong", floorTurns: 3 });
  const s = load(k);
  assert.equal(s.floor, "strong");
  assert.equal(s.floorTurns, 3);
});

test("no prompt text is ever written to thread state", () => {
  const k = key();
  save(k, { tier: "fast", model: "m", floor: null, floorTurns: 0, prompt: "a secret prompt", pending: { shape: "x" } });
  const raw = JSON.stringify(load(k));
  assert.ok(!raw.includes("secret"));
  assert.deepEqual(Object.keys(load(k)).sort(), ["at", "floor", "floorTurns", "model", "tier"]);
});

test("stale conversations are not resumed, and get swept", () => {
  const k = key();
  save(k, { tier: "fast", model: "m", floor: null, floorTurns: 0 });
  const file = join(dirOf(), `${k}.json`);
  const old = Date.now() / 1000 - 60 * 60 * 48;
  utimesSync(file, old, old);
  assert.equal(load(k), null, "a day-old conversation is finished, not continued");
  sweep();
  assert.ok(!readdirSync(dirOf()).includes(`${k}.json`));
});

test("a broken or missing file reads as no state, never throws", () => {
  mkdirSync(dirOf(), { recursive: true });
  assert.equal(load("definitely-not-here"), null);
  assert.equal(load(""), null);
});

// The bug this file exists for: Claude Code issues a new session_id per `-p --continue` call,
// so a key including it split one scripted conversation into one thread per turn.
test("a conversation keeps one identity across invocations with different session ids", () => {
  const body = (sid) => ({
    metadata: { user_id: JSON.stringify({ session_id: sid }) },
    messages: [{ role: "user", content: "Create a minimal React app" }],
  });
  assert.equal(wire.threadKey(body("session-one")), wire.threadKey(body("session-two")));
});

test("sub-agents are still separate conversations", () => {
  const body = (text) => ({ metadata: {}, messages: [{ role: "user", content: text }] });
  assert.notEqual(wire.threadKey(body("main task")), wire.threadKey(body("sub task")));
});
