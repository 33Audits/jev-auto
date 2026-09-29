#!/usr/bin/env node
// Claude Code pipes a JSON session payload on stdin and renders whatever this prints.
// https://code.claude.com/docs/en/statusline
import { latestDecision } from "../src/journal.mjs";
import { renderStatusLine } from "../src/statusline.mjs";

const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);

let input = {};
try {
  input = JSON.parse(Buffer.concat(chunks).toString() || "{}");
} catch {
  // Malformed input still gets a usable line.
}

process.stdout.write(`${renderStatusLine(input, latestDecision(input.session_id))}\n`);
