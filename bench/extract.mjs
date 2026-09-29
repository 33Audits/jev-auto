#!/usr/bin/env node
// Builds a benchmark corpus from real Claude Code sessions on this machine.
//
// The corpus has to come from somewhere neither router's author chose. Prompts written to
// exercise a scorer will always flatter that scorer; a developer's own session history is
// the distribution the router actually faces, and it was recorded before either router
// existed. It stays on this machine — bench/corpus*.jsonl is gitignored.
//
// Usage: node bench/extract.mjs [--out bench/corpus.jsonl] [--max 2000]
import { appendFileSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const args = new Map(process.argv.slice(2).flatMap((a, i, all) => (a.startsWith("--") ? [[a.slice(2), all[i + 1]]] : [])));
const OUT = args.get("out") ?? "bench/corpus.jsonl";
const MAX = Number(args.get("max") ?? 2000);
const ROOT = join(homedir(), ".claude", "projects");

const textOf = (content) => {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  if (content.some((b) => b?.type === "tool_result")) return ""; // a continuation, not a turn
  return content.filter((b) => b?.type === "text").map((b) => b.text ?? "").join("\n");
};

/** Slash commands, pastes, and hook noise are not prompts a human wrote to be routed. */
const isRealPrompt = (text) =>
  text.length > 8 &&
  text.length < 20000 &&
  !text.startsWith("/") &&
  !text.startsWith("<") &&
  !/^\[Request interrupted/.test(text) &&
  !/^(caveat|system-reminder)/i.test(text);

function* sessions() {
  for (const project of readdirSync(ROOT)) {
    const dir = join(ROOT, project);
    let entries = [];
    try {
      entries = readdirSync(dir).filter((f) => f.endsWith(".jsonl"));
    } catch {
      continue;
    }
    for (const file of entries) yield { project, path: join(dir, file) };
  }
}

mkdirSync(dirname(OUT), { recursive: true });
rmSync(OUT, { force: true });

const seen = new Set();
let kept = 0;
let scanned = 0;

for (const { project, path } of sessions()) {
  if (kept >= MAX) break;
  let lines = [];
  try {
    if (statSync(path).size > 80e6) continue; // a runaway session, not a useful sample
    lines = readFileSync(path, "utf8").split("\n");
  } catch {
    continue;
  }

  // Turn index within the session approximates how much conversation precedes a prompt,
  // which is what the context-window rules key off.
  let turn = 0;
  let chars = 0;
  for (const line of lines) {
    if (!line) continue;
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    chars += line.length;
    if (record.type !== "user" || record.isSidechain) continue;
    const text = textOf(record.message?.content).trim();
    scanned++;
    if (!isRealPrompt(text)) continue;

    const key = text.slice(0, 200);
    if (seen.has(key)) continue; // the same prompt retried is one sample, not several
    seen.add(key);

    appendFileSync(
      OUT,
      `${JSON.stringify({
        text,
        turn: turn++,
        // Everything before this prompt in the transcript, as a rough conversation size.
        priorChars: chars,
        project: project.slice(0, 40),
      })}\n`,
    );
    if (++kept >= MAX) break;
  }
}

process.stdout.write(`corpus: ${kept} prompts kept from ${scanned} user records -> ${OUT}\n`);
