// What is being injected into every turn, and a switch for the parts you are not using.
//
// Claude Code auto-loads `~/.claude/rules/**.md` into every session in every repository. On
// this machine that is 86k tokens of audit-pipeline methodology — larger, after toolset
// pruning, than anything else in the request.
//
// It cannot simply be deleted. Those files are symlinks, and the tools that own them read
// them back through that exact path: plamen's CLAUDE.md and command prompts, its install
// manifest, and several skills. Removing a symlink stops the injection and breaks the tool.
//
// So parking, not deleting. A parked rule moves to `rules-parked/` and is restored by name.
// Nothing is copied or rewritten, the symlink target is never touched, and `jev context --on`
// puts it back exactly where it was.
import { mkdirSync, readdirSync, readlinkSync, renameSync, statSync, symlinkSync, unlinkSync, lstatSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const RULES = join(homedir(), ".claude", "rules");
export const PARKED = join(homedir(), ".claude", "rules-parked");

/** Bytes of markdown a rules entry contributes, following symlinks and directories. */
function weigh(path) {
  let bytes = 0;
  const walk = (p) => {
    let st;
    try {
      st = statSync(p); // follows symlinks on purpose: the cost is the target's
    } catch {
      return;
    }
    if (st.isDirectory()) {
      for (const e of readdirSync(p)) walk(join(p, e));
    } else if (/\.md$/i.test(p)) {
      bytes += st.size;
    }
  };
  walk(path);
  return bytes;
}

/** Everything currently injected, heaviest first. 3.6 chars per token, as measured. */
export function listRules(dir = RULES) {
  let entries = [];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  return entries
    .map((name) => {
      const path = join(dir, name);
      let target = null;
      try {
        if (lstatSync(path).isSymbolicLink()) target = readlinkSync(path);
      } catch {
        // Not a link.
      }
      return { name, path, target, bytes: weigh(path), tokens: Math.round(weigh(path) / 3600) };
    })
    .filter((e) => e.bytes > 0)
    .sort((a, b) => b.bytes - a.bytes);
}

export const listParked = () => listRules(PARKED);

/** Move a rule out of the auto-loaded directory. Reversible, and never follows the link. */
export function park(name) {
  const from = join(RULES, name);
  if (!existsSync(from)) return { ok: false, why: "not loaded" };
  mkdirSync(PARKED, { recursive: true });
  const to = join(PARKED, name);
  if (existsSync(to)) return { ok: false, why: "already parked" };
  try {
    // rename moves the link itself, leaving whatever it points at alone.
    renameSync(from, to);
    return { ok: true };
  } catch (err) {
    return { ok: false, why: err.message };
  }
}

export function unpark(name) {
  const from = join(PARKED, name);
  if (!existsSync(from)) return { ok: false, why: "not parked" };
  const to = join(RULES, name);
  if (existsSync(to)) return { ok: false, why: "already loaded" };
  try {
    renameSync(from, to);
    return { ok: true };
  } catch (err) {
    return { ok: false, why: err.message };
  }
}
