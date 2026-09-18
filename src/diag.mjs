// Two sinks, chosen by whether anything is currently drawing a terminal UI.
//
// In interactive mode Claude Code owns the screen and repaints over anything written to it,
// so diagnostics have to go to a file or they corrupt the display. In print mode (`-p`) and
// under a pipe there is no UI to damage and stderr is where a caller expects them.
import { appendFileSync, mkdirSync } from "node:fs";
import { STATE_DIR, LOG_FILE } from "./tuning.mjs";

const toFile = (text) => {
  try {
    mkdirSync(STATE_DIR, { recursive: true });
    appendFileSync(LOG_FILE, `${new Date().toISOString()} ${text}`);
  } catch {
    // An unwritable log is not a reason to lose a session.
  }
};

export function log(line) {
  const text = `[jev] ${line}\n`;
  if (process.stdout.isTTY) toFile(text);
  else process.stderr.write(text);
}

/** Verbose diagnostics, off unless asked for. */
export const debug = (line) => {
  if (process.env.JEV_DEBUG) log(line);
};

export { LOG_FILE };
