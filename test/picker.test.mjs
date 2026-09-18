import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SENTINEL, SENTINEL as AUTO_MODEL_VALUE } from "../src/ladder.mjs";
import { savedChoice, undoSentinel } from "../src/picker.mjs";

const settings = (contents) => {
  const file = join(mkdtempSync(join(tmpdir(), "jev-")), "settings.json");
  writeFileSync(file, typeof contents === "string" ? contents : JSON.stringify(contents, null, 2));
  return file;
};
const read = (file) => JSON.parse(readFileSync(file, "utf8"));

test("a sentinel left behind is debris, not a preference", () => {
  assert.equal(savedChoice(settings({ model: SENTINEL })), undefined);
  assert.equal(savedChoice(settings({ model: "claude-opus-5" })), "claude-opus-5");
  assert.equal(savedChoice(join(tmpdir(), "nope", "settings.json")), undefined);
});

test("the sentinel is replaced by whatever was there before", () => {
  const file = settings({ model: SENTINEL, theme: "dark" });
  assert.equal(undoSentinel("claude-opus-5", file), true);
  assert.deepEqual(read(file), { model: "claude-opus-5", theme: "dark" });
});

test("with nothing set before, the key is removed rather than invented", () => {
  const file = settings({ model: SENTINEL, theme: "dark" });
  assert.equal(undoSentinel(undefined, file), true);
  assert.deepEqual(read(file), { theme: "dark" });
});

test("a model chosen during the session outranks what came before it", () => {
  const file = settings({ model: "claude-haiku-4-5" });
  assert.equal(undoSentinel("claude-opus-5", file), false);
  assert.equal(read(file).model, "claude-haiku-4-5");
});

test("settings changed during the session are kept, not rolled back", () => {
  const file = settings({ model: SENTINEL, theme: "dark", newSettingAddedMidSession: true });
  undoSentinel(undefined, file);
  assert.equal(read(file).newSettingAddedMidSession, true);
});

test("restoring is not also a reformat", () => {
  const tabbed = settings('{\n\t"model": "jev-auto",\n\t"theme": "dark"\n}\n');
  undoSentinel("claude-opus-5", tabbed);
  assert.match(readFileSync(tabbed, "utf8"), /\n\t"theme"/, "the file's own indentation survives");

  const wide = settings('{\n    "model": "jev-auto",\n    "theme": "dark"\n}\n');
  undoSentinel("claude-opus-5", wide);
  assert.match(readFileSync(wide, "utf8"), /\n {4}"theme"/);
});

test("a missing or unparseable file is left alone", () => {
  assert.equal(undoSentinel(undefined, join(tmpdir(), "nope", "settings.json")), false);
  const broken = settings("{ not json");
  assert.equal(undoSentinel(undefined, broken), false);
  assert.equal(readFileSync(broken, "utf8"), "{ not json");
});

// The names below belong to Claude Code, not to this codebase. A rename inside jev must
// never reach them: the value can change, the key cannot. This test exists because a
// blanket identifier rename once rewrote `ANTHROPIC_BASE_URL` and the sentinel stopped
// resolving, which no other test could see.
test("the environment contract with Claude Code is spelled exactly", async () => {
  const { pickerEnv } = await import("../src/runner.mjs");
  const env = pickerEnv();
  for (const key of [
    "ANTHROPIC_CUSTOM_MODEL_OPTION",
    "ANTHROPIC_CUSTOM_MODEL_OPTION_NAME",
    "ANTHROPIC_CUSTOM_MODEL_OPTION_DESCRIPTION",
    "ANTHROPIC_CUSTOM_MODEL_OPTION_SUPPORTED_CAPABILITIES",
    "CLAUDE_CODE_DISABLE_UNKNOWN_MODEL_WINDOW_ENFORCEMENT",
    "CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY",
  ]) {
    assert.ok(key in env, `${key} is Claude Code's name and must not be renamed`);
  }
  assert.equal(env.ANTHROPIC_CUSTOM_MODEL_OPTION, AUTO_MODEL_VALUE);
});

test("the sentinel the picker registers is the one the relay looks for", async () => {
  const { pickerEnv } = await import("../src/runner.mjs");
  const { isSentinel } = await import("../src/ladder.mjs");
  assert.ok(isSentinel(pickerEnv().ANTHROPIC_CUSTOM_MODEL_OPTION), "picker and relay must agree");
});
