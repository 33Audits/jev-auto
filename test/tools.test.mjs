import { test } from "node:test";
import assert from "node:assert/strict";
import { groupOf, groupsIn, pruneTools } from "../src/tools.mjs";

const mcp = (server, op) => ({ name: `mcp__${server}__${op}`, input_schema: { type: "object" } });
const builtin = (name) => ({ name, input_schema: { type: "object" } });

test("toolsets are identified by the MCP naming convention", () => {
  assert.equal(groupOf("mcp__claude_ai_Gmail__send_message"), "claude_ai_Gmail");
  assert.equal(groupOf("Read"), null, "a built-in belongs to no server");
  assert.equal(groupOf(undefined), null);
});

test("toolsets report what they cost and what they can do", () => {
  const groups = groupsIn([mcp("gmail", "send"), mcp("gmail", "search"), mcp("github", "pr"), builtin("Read")]);
  assert.deepEqual(groups.map((g) => g.name).sort(), ["github", "gmail"]);
  assert.deepEqual(groups.find((g) => g.name === "gmail").tools.sort(), ["search", "send"]);
  assert.ok(groups.every((g) => g.chars > 0), "cost is measured, not guessed");
});

// The failure that would matter most: an agent that cannot read a file.
test("built-ins are never dropped, whatever was selected", () => {
  const tools = [builtin("Read"), builtin("Bash"), mcp("gmail", "send"), mcp("github", "pr")];
  const kept = pruneTools(tools, new Set(["github"]));
  assert.deepEqual(kept.map((t) => t.name), ["Read", "Bash", "mcp__github__pr"]);
});

test("an unrecognised tool name is kept rather than guessed about", () => {
  const odd = [{ name: "weird_thing" }, { name: "mcp__gmail__send" }];
  assert.deepEqual(pruneTools(odd, new Set()).map((t) => t.name), ["weird_thing"]);
});

test("no selection means no pruning — the request goes out untouched", () => {
  const tools = [mcp("gmail", "send"), builtin("Read")];
  assert.equal(pruneTools(tools, null), tools);
  assert.equal(pruneTools(tools, undefined), tools);
});

test("keeping everything drops nothing", () => {
  const tools = [mcp("a", "x"), mcp("b", "y"), builtin("Read")];
  assert.equal(pruneTools(tools, new Set(["a", "b"])).length, 3);
});
