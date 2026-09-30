#!/usr/bin/env node
// Grades a built app against what was actually asked for.
//
// "built: true, tested: true" only says the thing compiles and some test passed — an app
// that ignored half the brief clears both. A cheaper arm that ships less is not cheaper, it
// is worse, so cost is only comparable between arms that scored the same here.
//
// Usage: node bench/grade.mjs <dir> [<dir>...]
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { basename, join } from "node:path";

const srcOf = (dir) => {
  const out = [];
  const walk = (d) => {
    for (const entry of readdirSync(d)) {
      if (entry === "node_modules" || entry === "dist" || entry === ".git") continue;
      const p = join(d, entry);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.(jsx?|tsx?|html)$/.test(entry)) out.push({ p, text: readFileSync(p, "utf8") });
    }
  };
  try {
    walk(dir);
  } catch {
    // Unreadable tree scores zero rather than crashing the comparison.
  }
  return out;
};

/** One check per line of the brief the arms were given. */
const CHECKS = [
  {
    id: "vite-react",
    why: "a React app on Vite, plain JS",
    test: (files, dir) =>
      existsSync(join(dir, "vite.config.js")) &&
      files.some((f) => /from ["']react["']/.test(f.text)) &&
      !existsSync(join(dir, "tsconfig.json")),
  },
  {
    id: "todo-input-add",
    why: "an input and an add button that appends to state",
    test: (files) =>
      files.some((f) => /<input/.test(f.text) && /useState/.test(f.text)) &&
      files.some((f) => /setTodos\(|setItems\(/.test(f.text)),
  },
  {
    id: "filters",
    why: "All / Active / Completed filtering",
    test: (files) => files.some((f) => /active/i.test(f.text) && /completed/i.test(f.text) && /filter/i.test(f.text)),
  },
  {
    id: "toggle",
    why: "a checkbox that toggles completion",
    test: (files) => files.some((f) => /type=["']checkbox["']/.test(f.text)),
  },
  {
    id: "renamed",
    why: "`t` renamed to `todo` everywhere",
    test: (files) =>
      files.some((f) => /\btodo\b/.test(f.text)) &&
      !files.some((f) => /\.(jsx?)$/.test(f.p) && /[^.\w]t\s*=>|\(\s*t\s*\)\s*=>|\bt\.completed\b/.test(f.text)),
  },
  {
    id: "heading",
    why: "an <h1> saying My Todos",
    test: (files) => files.some((f) => /<h1[^>]*>\s*My Todos/i.test(f.text)),
  },
  {
    id: "real-test",
    why: "a test that adds a todo and asserts it appears",
    test: (files) =>
      files.some(
        (f) => /\.test\.jsx?$/.test(f.p) && /expect\(/.test(f.text) && /(render|screen)/.test(f.text),
      ),
  },
];

export function grade(dir) {
  const files = srcOf(dir);
  const passed = CHECKS.filter((c) => {
    try {
      return c.test(files, dir);
    } catch {
      return false;
    }
  });
  return { dir, score: passed.length, total: CHECKS.length, missing: CHECKS.filter((c) => !passed.includes(c)) };
}

if (process.argv[1]?.endsWith("grade.mjs")) {
  const dirs = process.argv.slice(2);
  for (const dir of dirs) {
    const g = grade(dir);
    console.log(`  ${basename(dir).padEnd(22)} ${g.score}/${g.total}${g.missing.length ? "  missing: " + g.missing.map((m) => m.id).join(", ") : "  complete"}`);
  }
}
