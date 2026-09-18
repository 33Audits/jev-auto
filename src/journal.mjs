// Per-session routing state, shared between the proxy that writes it and the status line and
// `jev why` that read it from separate short-lived processes.
//
// Append-only, one line per decision, same shape as the turn ledger — so there is one
// persistence idea in this codebase rather than two. That also removes the read-modify-write
// the obvious implementation needs: two processes appending cannot lose each other's work,
// and a session killed mid-write costs one truncated line instead of the whole file.
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const DIR = join(tmpdir(), "jev-auto");

/** Decisions kept per session. Enough for `jev why` to look back over a working session. */
const KEEP = 20;

const journalFor = (sessionId) => join(DIR, `${String(sessionId).replace(/[^\w-]/g, "")}.jsonl`);

function write(sessionId, record, { truncate = false } = {}) {
  if (!sessionId) return;
  try {
    mkdirSync(DIR, { recursive: true });
    const json = JSON.stringify(record);
    // Wrapped in newlines on both sides, not just terminated by one. A process killed
    // mid-write leaves a fragment; a trailing newline stops it gluing onto the record before
    // it, and the next record's leading newline stops it gluing onto the one after. The
    // damage stays at the one truncated line. Blank lines are skipped on read.
    if (truncate) writeFileSync(journalFor(sessionId), `${json}\n`);
    else appendFileSync(journalFor(sessionId), `\n${json}\n`);
  } catch {
    // Everything this file supports is display. It must never interfere with a request.
  }
}

/** Record a routing decision. */
export const recordDecision = (sessionId, decision) => write(sessionId, decision);

/**
 * Record that the user has taken manual control. Written as a truncate rather than an
 * append: once routing is paused, the decisions before it are no longer what is happening,
 * and `jev why` should say so plainly instead of showing a stale tier.
 */
export const recordManual = (sessionId, model) =>
  write(sessionId, { manual: true, model, at: Date.now() }, { truncate: true });

/** Every retained decision for a session, oldest first. */
export function decisionHistory(sessionId) {
  try {
    return readFileSync(journalFor(sessionId), "utf8")
      .split("\n")
      .filter(Boolean)
      .slice(-KEEP)
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return null; // a truncated final line from a killed session
        }
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

/** The latest decision for a session, with its history attached, or null. */
export function latestDecision(sessionId) {
  const history = decisionHistory(sessionId);
  return history.length ? { ...history.at(-1), history } : null;
}
