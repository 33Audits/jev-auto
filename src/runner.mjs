// Starting the real CLI with the proxy in front of it.
//
// Claude Code is spawned by name and left to find itself on PATH — Node already does that
// lookup, and doing it again by hand only adds a way to disagree with it. On Windows the
// install is a `.cmd` shim, which needs a shell; everywhere else it does not.
import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { SENTINEL } from "./ladder.mjs";
import { startRelay } from "./relay.mjs";
import { wire as codexWire } from "./wire-codex.mjs";
import { savedChoice, undoSentinel } from "./picker.mjs";
import { appraiserName } from "./appraisers/index.mjs";
import { LOG_FILE } from "./diag.mjs";

export const PACKAGE_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const WINDOWS = process.platform === "win32";

/** Real environment wins, then the launch directory, then the user's own file. */
export function loadEnvFiles() {
  for (const file of [join(process.cwd(), ".env"), join(homedir(), ".jev-auto.env")]) {
    try {
      process.loadEnvFile(file);
    } catch {
      // Every one of these is optional.
    }
  }
}

/**
 * The environment that puts "Jev Auto" in the `/model` picker and starts the session on it.
 *
 * Claude Code forwards an unknown model id verbatim when a custom base URL is set, which is
 * the whole mechanism: a request naming the sentinel is one the user wants routed, and a
 * request naming anything else is a choice they made themselves. Capabilities are declared
 * so Claude Code still composes thinking and effort for the tiers that have them; the proxy
 * strips whatever the tier it lands on cannot accept.
 */
export function pickerEnv() {
  const env = {
    ANTHROPIC_CUSTOM_MODEL_OPTION: SENTINEL,
    ANTHROPIC_CUSTOM_MODEL_OPTION_NAME: "Jev Auto",
    ANTHROPIC_CUSTOM_MODEL_OPTION_DESCRIPTION: "Route each turn to the cheapest model that can do it",
    ANTHROPIC_CUSTOM_MODEL_OPTION_SUPPORTED_CAPABILITIES:
      "thinking,adaptive_thinking,interleaved_thinking,effort,max_effort",
    CLAUDE_CODE_DISABLE_UNKNOWN_MODEL_WINDOW_ENFORCEMENT: "1",
    CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY: "1",
  };
  // Session-scoped, never written to settings, so choosing a default costs nothing lasting.
  if (!process.env.ANTHROPIC_MODEL) env.ANTHROPIC_MODEL = SENTINEL;
  return env;
}

/** Whether the user has a status line of their own that must not be replaced. */
export function hasOwnStatusLine() {
  return [join(process.cwd(), ".claude"), join(homedir(), ".claude")].some((dir) => {
    try {
      return Boolean(JSON.parse(readFileSync(join(dir, "settings.json"), "utf8")).statusLine);
    } catch {
      return false;
    }
  });
}

/**
 * Claude Code's UI names the model it asked for, never the one the proxy sent, so the status
 * line is the only place a decision is visible. Written to a settings file and passed by
 * path: `--settings` merges rather than replaces, and inline JSON does not survive the shell
 * on Windows.
 */
export function statusLineArgs() {
  if (process.env.JEV_NO_STATUSLINE || hasOwnStatusLine()) return [];
  const file = join(tmpdir(), "jev-auto", "statusline.settings.json");
  const command = `"${process.execPath}" "${join(PACKAGE_ROOT, "bin", "jev-statusline.mjs")}"`;
  try {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify({ statusLine: { type: "command", command } }));
    return ["--settings", file];
  } catch {
    return []; // a status line is not worth failing a launch over
  }
}

const NOT_INSTALLED =
  "[jev] Claude Code is not installed, or `claude` is not on your PATH.\n" +
  "[jev] jev runs the real Claude Code CLI; install it first:\n" +
  "[jev]   https://code.claude.com/docs/en/setup\n";

/** Launch Claude Code with routing in front of it. Resolves when the child exits. */
export async function runClaude(args) {
  loadEnvFiles();

  const env = { ...process.env };
  // The packaged /jev-why skill lives under the install root, so Claude Code must read it.
  const argv = [...args, "--add-dir", PACKAGE_ROOT];

  if (process.env.JEV_ROUTER === "off") {
    process.stderr.write("[jev] JEV_ROUTER=off — starting Claude Code without routing\n");
  } else {
    const previousModel = savedChoice();
    const { port, close, cutoffs } = await startRelay();
    env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${port}`;
    Object.assign(env, pickerEnv());
    argv.push(...statusLineArgs());
    process.on("exit", () => {
      close();
      undoSentinel(previousModel);
    });
    if (process.env.JEV_DEBUG && process.stdout.isTTY) {
      process.stderr.write(
        `[jev] backend=${appraiserName()} boundaries=${cutoffs.cheap}/${cutoffs.strong} log=${LOG_FILE}\n`,
      );
    }
  }

  // `shell` only on Windows, where the install is a .cmd shim. Under a shell the arguments
  // are re-parsed, so any containing whitespace has to survive that trip quoted.
  const child = spawn("claude", WINDOWS ? argv.map((a) => (/\s/.test(a) ? `"${a}"` : a)) : argv, {
    stdio: "inherit",
    shell: WINDOWS,
    env,
  });

  child.on("error", (err) => {
    process.stderr.write(err.code === "ENOENT" ? NOT_INSTALLED : `[jev] could not start Claude Code: ${err.message}\n`);
    process.exit(1);
  });
  child.on("exit", (code, signal) => process.exit(signal ? 1 : (code ?? 0)));
}


/**
 * Launch Codex with routing in front of it.
 *
 * Codex validates models server-side, so the sentinel must never reach OpenAI — the relay
 * rewrites it first. It is registered as a temporary provider on the command line rather
 * than written into ~/.codex/config.toml, so nothing about the user's install is modified
 * and an interrupted session leaves no trace. `requires_openai_auth` makes Codex attach the
 * credentials from its own `codex login`; the relay forwards them without reading them.
 */
export async function runCodex(args) {
  loadEnvFiles();

  const argv = [...args];
  const env = { ...process.env };

  if (process.env.JEV_ROUTER === "off") {
    process.stderr.write("[jev] JEV_ROUTER=off — starting Codex without routing\n");
  } else {
    const { port, close, cutoffs } = await startRelay({ wire: codexWire });
    argv.unshift(
      "-c", `model_providers.jevauto.name="Jev Auto"`,
      "-c", `model_providers.jevauto.base_url="http://127.0.0.1:${port}"`,
      "-c", `model_providers.jevauto.requires_openai_auth=true`,
      "-c", `model_provider="jevauto"`,
      "-c", `model="${SENTINEL}"`,
    );
    process.on("exit", close);
    if (process.env.JEV_DEBUG && process.stdout.isTTY) {
      process.stderr.write(
        `[jev] codex backend=${backendName()} cutoffs=${cutoffs.cheap}/${cutoffs.strong} log=${LOG_FILE}\n`,
      );
    }
  }

  const child = spawn("codex", WINDOWS ? argv.map((a) => (/\s/.test(a) ? `"${a}"` : a)) : argv, {
    stdio: "inherit",
    shell: WINDOWS,
    env,
  });
  child.on("error", (err) => {
    process.stderr.write(
      err.code === "ENOENT"
        ? "[jev] Codex is not installed, or `codex` is not on your PATH.\n" +
            "[jev] jev runs the real Codex CLI; install it first:\n" +
            "[jev]   https://developers.openai.com/codex/cli\n"
        : `[jev] could not start Codex: ${err.message}\n`,
    );
    process.exit(1);
  });
  child.on("exit", (code, signal) => process.exit(signal ? 1 : (code ?? 0)));
}
