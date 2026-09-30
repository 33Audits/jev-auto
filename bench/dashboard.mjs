#!/usr/bin/env node
// Build the same React + TypeScript dashboard twice: once through jev, once without it.
//
// Unlike the earlier React benchmark this runs on the machine's REAL configuration — MCP
// servers left enabled — because that is the setup being compared. Stripping them to make
// routing look better would measure a configuration nobody runs.
//
//   vanilla   the relay meters but does not route or prune: what you get without jev
//   jev       routing plus Jev-chosen toolsets
//
// Both arms share the relay, so the accounting and overhead are identical and the only
// difference is who decides.
//
// Usage: node bench/dashboard.mjs [--arms vanilla,jev] [--out bench/dash]
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { read as readLedger, stats as summarize } from "../src/ledger.mjs";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const JEV = join(ROOT, "bin", "jev.mjs");
const arg = (k, d) => {
  const i = process.argv.indexOf(`--${k}`);
  return i > 0 ? process.argv[i + 1] : d;
};
const OUT = resolve(arg("out", join(ROOT, "bench", "dash")));

const SCRIPT = [
  "Create a React + TypeScript app in this directory using Vite and npm. Do not start a dev server.",
  "Add src/data.ts exporting a typed Order interface (id, customer, total, status, date) and an array of 12 mock orders, plus monthly revenue totals for 6 months.",
  "Add a Dashboard component with three stat cards showing total revenue, order count, and unique customers, computed from the mock data. Render it from App.",
  "Add a table of the orders below the cards, with a header row, and make the Total column sortable ascending and descending when clicked.",
  "Add a bar chart of the six monthly revenue figures above the table, using inline SVG. Do not add a charting library.",
  "Add a text input that filters the orders table by customer name as you type.",
  "Write a Vitest test that renders the Dashboard, asserts the revenue stat card is present, types a customer name into the filter, and asserts the table narrows to that customer. Install what you need, run the test, and fix anything that fails.",
];

const ARMS = {
  // No routing, no pruning — the relay is present only so both arms are metered identically.
  vanilla: { JEV_PIN: "balanced", JEV_PRUNE_TOOLS: "0" },
  jev: { JEV_ROUTER: "jev" },
};

const run = (cmd, args, opts = {}) =>
  spawnSync(cmd, args, { encoding: "utf8", maxBuffer: 64e6, timeout: 20 * 60e3, ...opts });

/** Checks derived from the brief, one per instruction. */
const CHECKS = [
  ["react+ts on vite", (f, d) => existsSync(join(d, "vite.config.ts")) || existsSync(join(d, "tsconfig.json"))],
  ["typed Order model", (f) => f.some((x) => /(interface|type)\s+Order\b/.test(x.text))],
  ["mock data module", (f) => f.some((x) => /data\.tsx?$/.test(x.p) && /\[/.test(x.text))],
  ["three stat cards", (f) => f.some((x) => /revenue/i.test(x.text) && /customers?/i.test(x.text) && /orders?/i.test(x.text))],
  ["orders table", (f) => f.some((x) => /<t(head|body|able)/i.test(x.text))],
  ["sortable total", (f) => f.some((x) => /sort/i.test(x.text) && /onClick/.test(x.text))],
  ["inline svg chart", (f) => f.some((x) => /<svg/i.test(x.text) && /<rect/i.test(x.text))],
  ["filter input", (f) => f.some((x) => /onChange/.test(x.text) && /filter/i.test(x.text))],
  ["test filters + asserts", (f) => f.some((x) => /\.test\.tsx?$/.test(x.p) && /expect\(/.test(x.text) && /(type|change)/i.test(x.text))],
];

function sources(dir) {
  const out = [];
  const walk = (d) => {
    for (const e of readdirSync(d)) {
      if (["node_modules", "dist", ".git"].includes(e)) continue;
      const p = join(d, e);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.(tsx?|jsx?|html)$/.test(e)) out.push({ p, text: readFileSync(p, "utf8") });
    }
  };
  try {
    walk(dir);
  } catch {
    // Nothing built.
  }
  return out;
}

const results = [];
for (const arm of (arg("arms", "vanilla,jev") || "").split(",").filter(Boolean)) {
  const dir = join(OUT, arm);
  const ledger = join(OUT, `${arm}.jsonl`);
  for (const p of [dir, ledger, `${ledger}.threads`]) rmSync(p, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });

  const env = {
    ...process.env, ...ARMS[arm],
    JEV_LEDGER: ledger, JEV_THREADS: `${ledger}.threads`, JEV_DEBUG: "1",
  };
  process.stderr.write(`\n=== ${arm} ===\n`);

  let wall = 0;
  const notes = [];
  for (const [i, prompt] of SCRIPT.entries()) {
    const started = Date.now();
    const r = run(process.execPath, [JEV, ...(i ? ["--continue"] : []), "-p", prompt], { cwd: dir, env });
    wall += Date.now() - started;
    const pruned = /dropped (\d+) toolsets, ~(\d+)k/.exec(r.stderr ?? "");
    if (pruned) notes.push(`${pruned[2]}k`);
    process.stderr.write(`  ${i + 1}/${SCRIPT.length}  ${Math.round((Date.now() - started) / 1000)}s  exit=${r.status}${pruned ? `  pruned ${pruned[2]}k` : ""}\n`);
  }

  run("npm", ["install", "--no-audit", "--no-fund"], { cwd: dir });
  const build = run("npm", ["run", "build", "--if-present"], { cwd: dir });
  const test = run("npx", ["vitest", "run", "--passWithNoTests"], { cwd: dir });

  const files = sources(dir);
  const passed = CHECKS.filter(([, fn]) => {
    try {
      return fn(files, dir);
    } catch {
      return false;
    }
  });
  const s = summarize(readLedger(ledger));
  const row = {
    arm,
    seconds: Math.round(wall / 1000),
    spend: s.spend,
    mix: Object.fromEntries(Object.entries(s.byTier).map(([k, v]) => [k, v.turns])),
    requirements: `${passed.length}/${CHECKS.length}`,
    missing: CHECKS.filter((c) => !passed.includes(c)).map(([n]) => n),
    built: build.status === 0,
    tested: test.status === 0,
    prunedPerTurn: notes,
  };
  results.push(row);
  writeFileSync(join(OUT, "results.json"), JSON.stringify(results, null, 2));
  process.stderr.write(`  -> ${row.seconds}s $${row.spend.toFixed(4)} reqs=${row.requirements} built=${row.built} tested=${row.tested}\n`);
}

console.log("\n  arm       wall    spend      reqs   built  tested  mix");
for (const r of results) {
  console.log(`  ${r.arm.padEnd(9)} ${String(r.seconds).padStart(4)}s  $${r.spend.toFixed(4)}  ${r.requirements.padEnd(5)}  ${String(r.built).padEnd(5)}  ${String(r.tested).padEnd(6)}  ${JSON.stringify(r.mix)}`);
  if (r.missing.length) console.log(`            missing: ${r.missing.join(", ")}`);
}
const [v, j] = ["vanilla", "jev"].map((a) => results.find((r) => r.arm === a));
if (v && j) {
  console.log(`\n  jev vs vanilla: ${((j.spend / v.spend - 1) * 100).toFixed(0)}% cost, ${((1 - j.seconds / v.seconds) * 100).toFixed(0)}% faster`);
}
console.log("");
