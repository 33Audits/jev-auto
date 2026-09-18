// Per-conversation routing state that outlives the relay process.
//
// `jev` run interactively holds one relay for the whole session, so an in-memory map is
// enough. `jev -p` does not: every invocation is a fresh process, so a scripted or CI loop
// driving one conversation across many calls started each turn with no memory of the last.
// The consequences were invisible and expensive — `hasCache` read false on every turn, so
// the prompt-cache guard never fired and the conversation was free to switch model on each
// turn, paying a full cache rebuild every time.
//
// Small enough to be a JSON file per conversation, written after each decision.
import { mkdirSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * JEV_THREADS relocates the store. Read on every call rather than captured at import, so a
 * process that changes it mid-run (a test suite isolating cases) is actually honoured.
 */
export const dirOf = () => process.env.JEV_THREADS || join(tmpdir(), "jev-auto", "threads");

/** Conversations idle longer than this are finished; their state is not worth keeping. */
const TTL_MS = 12 * 60 * 60 * 1000;

const fileFor = (key) => join(dirOf(), `${String(key).replace(/[^\w-]/g, "")}.json`);

export function load(key) {
  try {
    const file = fileFor(key);
    // Freshness comes from the file's own mtime, the same clock `sweep` uses. Reading a
    // timestamp out of the contents instead let the two disagree.
    if (Date.now() - statSync(file).mtimeMs > TTL_MS) return null;
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

export function save(key, state) {
  try {
    mkdirSync(dirOf(), { recursive: true });
    // Only the fields that must survive; never prompt text.
    writeFileSync(
      fileFor(key),
      JSON.stringify({ tier: state.tier, model: state.model, floor: state.floor, floorTurns: state.floorTurns, at: Date.now() }),
    );
  } catch {
    // Losing continuity costs a cache rebuild, not correctness.
  }
}

/** Drop state for conversations that have gone quiet, so the directory cannot grow forever. */
export function sweep(now = Date.now()) {
  let removed = 0;
  try {
    const dir = dirOf();
    for (const f of readdirSync(dir)) {
      const p = join(dir, f);
      try {
        if (now - statSync(p).mtimeMs > TTL_MS) {
          unlinkSync(p);
          removed++;
        }
      } catch {
        // Raced with another process; nothing to do.
      }
    }
  } catch {
    // No directory yet.
  }
  return removed;
}
