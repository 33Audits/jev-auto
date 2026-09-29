// Claude Code writes `model` into ~/.claude/settings.json whenever a picker row is chosen
// with Enter. Our sentinel is not a real model, so if it is left in there, plain `claude`
// starts against a model no proxy is listening for. This module puts the key back.
//
// The unit of work is the single `model` key, never the file. A session can legitimately
// change other settings while it runs, and restoring a whole-file snapshot on exit would
// throw those away. The file's own indentation is detected and reused so a session that
// touches settings does not also silently reformat them.
import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { SENTINEL } from "./ladder.mjs";

export const USER_SETTINGS = join(homedir(), ".claude", "settings.json");

const load = (file) => {
  try {
    const raw = readFileSync(file, "utf8");
    return { raw, json: JSON.parse(raw) };
  } catch {
    return null;
  }
};

/** Indentation the file already uses, so rewriting it is not also a reformat. */
const indentOf = (raw) => {
  const match = /\n(\t| +)"/.exec(raw);
  return match ? match[1] : 2;
};

/**
 * What `model` was before this session started. A sentinel found here is debris from a
 * session that did not exit cleanly, not a preference, so it reads as "nothing was set".
 */
export function savedChoice(file = USER_SETTINGS) {
  const model = load(file)?.json?.model;
  return model === SENTINEL ? undefined : model;
}

/**
 * Put `previous` back, but only over our own sentinel. A real model sitting there is a
 * choice the user made during the session and outranks whatever they had before it.
 *
 * @returns {boolean} whether the file was changed
 */
export function undoSentinel(previous, file = USER_SETTINGS) {
  const current = load(file);
  if (!current || current.json?.model !== SENTINEL) return false;

  const next = { ...current.json };
  if (previous === undefined) delete next.model;
  else next.model = previous;

  try {
    writeFileSync(file, `${JSON.stringify(next, null, indentOf(current.raw))}\n`);
    return true;
  } catch {
    return false;
  }
}
