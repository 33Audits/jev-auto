import http from "node:http";
import https from "node:https";
import { writeFileSync } from "node:fs";
import {
  SENTINEL, TIER_ORDER, accountModels, defaultIdFor, enabledTiers, heightOf, isSentinel, modelIdFor, tierOfModel,
} from "./ladder.mjs";
import { verdictFor } from "./verdict.mjs";
import { selectAppraiser, appraiserName } from "./appraisers/index.mjs";
import { cutoffs as calibratedCutoffs } from "./calibrate.mjs";
import { append as recordTurn, read as readLedger } from "./ledger.mjs";
import { RULES } from "./tuning.mjs";
import { applyLearned, cheaperThan, shouldExplore } from "./explore.mjs";
import { pruneTools, selectToolsets } from "./tools.mjs";
import { debug, log } from "./diag.mjs";
import { recordDecision, recordManual } from "./journal.mjs";
import { load as loadThread, save as saveThread, sweep as sweepThreads } from "./threads.mjs";
import { wire as claudeWire } from "./wire.mjs";
import { readsAsRetry } from "./wire.mjs";

const AUTH_HEADERS = ["authorization", "x-api-key", "anthropic-version", "anthropic-beta", "chatgpt-account-id", "openai-beta"];
const authHeadersOf = (headers) =>
  Object.fromEntries(AUTH_HEADERS.filter((h) => headers[h]).map((h) => [h, headers[h]]));

/**
 * Starts the loopback relay. It forwards the CLI's own authorization headers without
 * reading, storing, or modifying them; the only thing it changes in a request is which
 * model it names.
 *
 * `wire` is the platform adapter — Claude Code's Messages shape or Codex's Responses shape.
 * Nothing below this line knows which one it has.
 */
/**
 * A live A/B on real work. `jev ab` assigns each session to an arm at random and both arms run
 * through the same relay, so the only difference is whether the decisions are applied. Without
 * randomisation the comparison is whatever the user happened to do on each day.
 */
export const pickArm = (rng = Math.random) => (rng() < 0.5 ? "routed" : "control");

export async function startRelay({
  wire = claudeWire,
  upstreamURL = wire.upstream,
  appraise = selectAppraiser(),
  ledger = recordTurn,
  // Passed in rather than read from the environment on every request: a global that changes
  // under async work is untestable, and two tests mutating it raced.
  pin = TIER_ORDER.includes(process.env.JEV_PIN) ? process.env.JEV_PIN : null,
  // Same reason as `pin`: resolved once when the relay starts, not read from a global on
  // every request. Two relays in one process must not be able to steer each other's state.
  threadStore = undefined,
  // Exploration deliberately makes routing nondeterministic — it sometimes takes a rung the
  // appraiser did not pick. Injectable so a caller that needs a deterministic relay (a test
  // asserting which model went out) can switch it off, rather than fighting a coin flip.
  exploreRate = undefined,
  // What exploration has already established. Read from the ledger by default; injectable so
  // a test is not steered by whatever trials happen to sit in the developer's ledger.
  history = readLedger(),
  // "control" runs the relay with the decisions switched off: metered identically, nothing
  // routed, nothing pruned. That is the honest counterfactual for a real session.
  arm = process.env.JEV_ARM === "control" || process.env.JEV_ARM === "routed" ? process.env.JEV_ARM : null,
} = {}) {
  const platform = wire.platform;
  const threads = new Map();
  const catalog = new Map();
  // Cutoffs are derived once at startup: the ledger only moves them across sessions, and
  // re-deriving per turn would shift a session's routing under the user mid-task.
  const cutoffs = calibratedCutoffs(history);
  sweepThreads();
  debug(`${platform}: cutoffs ${cutoffs.cheap}/${cutoffs.strong} appraiser=${appraiserName()}`);

  const commit = (state, verdict = "ok", code = null) => {
    if (!state?.pending) return;
    ledger({ ...state.pending, verdict, code });
    state.pending = null;
  };

  const threadState = (key) => {
    let s = threads.get(key);
    if (!s) {
      if (threads.size > 50) {
        const oldest = threads.keys().next().value;
        commit(threads.get(oldest));
        threads.delete(oldest);
      }
      // Continue a conversation this process did not start: `jev -p` is a new process per
      // invocation, and without this every scripted turn looked like a first turn.
      const persisted = loadThread(key, threadStore);
      s = { tier: null, model: null, pending: null, floor: null, floorTurns: 0, ...(persisted ?? {}) };
      threads.set(key, s);
    }
    return s;
  };

  const holdFloor = (state, from) => {
    state.floor = TIER_ORDER[Math.min(heightOf(from) + 1, heightOf("strong"))];
    state.floorTurns = RULES.escalationStickyTurns;
    debug(`escalation floor -> ${state.floor} for ${RULES.escalationStickyTurns} turns`);
  };

  /** Grade the previous turn against what the user did next. The calibrator's ground truth. */
  const gradePrevious = (state, correction) => {
    if (!state.pending) return;
    if (correction) {
      commit(state, "escalated", "redo");
      holdFloor(state, state.tier);
    } else {
      commit(state, "ok");
      if (state.floorTurns > 0 && --state.floorTurns === 0) state.floor = null;
    }
  };

  const server = http.createServer((req, res) => {
    if (req.method === "HEAD") return res.writeHead(200).end(); // base-URL probe

    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", async () => {
      let out = Buffer.concat(chunks);
      let active = null;

      if (wire.isTurnCall(req.url)) {
        try {
          const body = JSON.parse(out.toString());
          if (process.env.JEV_DUMP) {
            writeFileSync(`${process.env.JEV_DUMP}.${Date.now()}.json`, JSON.stringify(body, null, 2));
          }
          wire.prepare(body);

          if (!isSentinel(wire.modelOf(body))) {
            // Anything but the sentinel is a model the user chose, and an explicit choice
            // beats the router. This also covers the CLI's own cheap auxiliary calls.
            const state = threads.get(wire.threadKey(body));
            recordManual(wire.sessionIdOf(body), wire.modelOf(body));
            if (state?.pending && heightOf(tierOfModel(wire.modelOf(body), platform)) > heightOf(state.pending.tier)) {
              commit(state, "escalated", "manual_escalate");
              holdFloor(state, state.pending?.tier ?? state.tier);
            }
            debug(`passthrough, user selected ${wire.modelOf(body)}`);
          } else {
            const state = threadState(wire.threadKey(body));
            active = state;
            // Before anything has been routed there is no cache and no evidence, so the
            // baseline is the balanced rung: an unroutable request must not silently
            // default to the most expensive model.
            const current = state.tier ?? "balanced";
            const prompt = wire.freshTurnText(body);

            if (prompt) {
              gradePrevious(state, readsAsRetry(prompt));

              // A pinned rung meters a session without routing it: the relay still records
              // tokens, cost and escalations, but every turn runs on one rung. This is the
              // control arm a routed run is compared against.
              // A control turn holds the rung the CLI would have used, so cost differences come
              // from the decisions rather than from a different starting point.
              const pinned = arm === "control" ? (pin ?? "balanced") : pin;

              // Ask Jev which toolsets this turn needs and drop the rest, BEFORE measuring the
              // request. A tool schema that is never called is waste at every rung, and on this
              // machine the unused ones were ~91k tokens of a ~100k block. Order matters: the
              // rung must be chosen against what is actually sent, and 91k is the difference
              // between the cheapest rung fitting the conversation and not. Decided once per
              // turn and reused by the tool loop. Built-ins are never dropped.
              if (arm !== "control" && process.env.JEV_PRUNE_TOOLS !== "0" && Array.isArray(body.tools)) {
                const picked = await selectToolsets({ prompt, tools: body.tools });
                if (picked?.dropped) {
                  state.keepToolsets = picked.keep;
                  state.prunedTokens = Math.round(picked.savedChars / 3600);
                  body.tools = pruneTools(body.tools, picked.keep);
                  debug(
                    `${platform}: dropped ${picked.dropped} toolsets, ~${Math.round(picked.savedChars / 3600)}k tokens (${picked.ms}ms)`,
                  );
                }
              }

              const models = accountModels([...catalog.values()], platform).filter((m) =>
                enabledTiers().includes(m.tier),
              );
              const available = [...new Set(models.map((m) => m.tier))];
              const contextTokens = wire.weighRequest(body);
              // Wrapped rather than awaited directly: an appraiser may be synchronous (the
              // local one is) and may throw rather than reject. Both mean "keep the rung".
              const decision = pinned ? { choice: pinned, confidence: 1, backend: "pinned", shape: "pinned", score: null } : await Promise.resolve()
                .then(() =>
                  appraise({
                    prompt,
                    contextTokens,
                    toolCount: body.tools?.length ?? 0,
                    cutoffs,
                    // Offering a rung the account cannot use invites Jev to spend probability
                    // mass on it; `long` was being offered even when disabled.
                    available,
                    upstream: upstreamURL,
                    auth: authHeadersOf(req.headers),
                  }),
                )
                .catch((err) => (log(`appraiser failed, holding ${current}: ${err.message}`), null));

              let { tier, reason } = verdictFor({
                prompt, decision, current, available, contextTokens,
                hasCache: state.tier !== null, floor: state.floor, platform,
              });

              // Everything exploration has already established, applied. This is where the
              // trials turn into saving rather than just data.
              const shape = decision?.shape ?? "unknown";
              const learned = applyLearned({ tier, shape, contextTokens, floor: state.floor, records: history });
              if (learned !== tier) {
                tier = learned;
                reason = `${reason}+learned-cheaper`;
              }

              // And occasionally take the cheaper rung anyway, to find out.
              let explored = false;
              if (
                state.tier === null &&
                shouldExplore({
                  tier, shape, contextTokens, floor: state.floor, records: history,
                  confidence: decision?.confidence,
                  ...(exploreRate === undefined ? {} : { rate: exploreRate }),
                })
              ) {
                tier = cheaperThan(tier) ?? tier;
                reason = `${reason}+exploring`;
                explored = true;
              }

              state.tier = tier;
              state.model = tier === current && state.model ? state.model : modelIdFor(models, tier, platform);
              saveThread(wire.threadKey(body), state, threadStore);
              state.pending = {
                t: Date.now(), shape, tier,
                backend: decision?.backend ?? "none", score: decision?.score ?? null,
                conf: decision?.confidence ?? null, platform, explored, arm,
                prunedTokens: state.prunedTokens ?? 0,
                in: 0, out: 0, cacheRead: 0, cacheWrite: 0,
              };
              debug(
                `${platform}: ${tier} (${reason}) score=${decision?.score?.toFixed(2) ?? "n/a"} ` +
                  `p=${decision?.confidence?.toFixed(2) ?? "n/a"} ctx~${contextTokens} | ${prompt.slice(0, 60)}`,
              );
              recordDecision(wire.sessionIdOf(body), {
                tier, model: state.model, prompt, reason, platform,
                confidence: decision?.confidence ?? null, metrics: decision?.metrics ?? null,
                score: decision?.score ?? null, backend: decision?.backend ?? "none",
                cutoffs, floor: state.floor, at: Date.now(),
              });
            }

            // The sentinel is not a real model, so every routed request must be rewritten,
            // including tool-loop follow-ups that reuse the rung chosen for the turn.
            // Applied to every request of the turn, not only the opening one: the tool block
            // is re-sent on each tool-loop continuation, which is where most of it is paid for.
            if (state.keepToolsets && Array.isArray(body.tools)) {
              body.tools = pruneTools(body.tools, state.keepToolsets);
            }
            const tier = state.tier ?? current;
            wire.retarget(body, tier, state.model ?? defaultIdFor(tier, platform));
          }
          out = Buffer.from(JSON.stringify(body));
        } catch (err) {
          debug(`passthrough, could not process body: ${err.message}`);
        }
      }

      pipeUpstream(req, res, out, { wire, upstreamURL, catalog, active, commit });
    });
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    port: server.address().port,
    platform,
    cutoffs,
    close: () => {
      for (const state of threads.values()) commit(state);
      server.close();
    },
  };
}

function pipeUpstream(req, res, out, { wire, upstreamURL, catalog, active, commit }) {
  const target = new URL(upstreamURL);
  const transport = target.protocol === "http:" ? http : https;
  const headers = { ...req.headers, host: target.host };
  delete headers["content-length"];
  // The catalog and the usage tap both read the body, so ask for it uncompressed.
  if (wire.isCatalogCall(req.method, req.url) || wire.isTurnCall(req.url)) delete headers["accept-encoding"];

  const upstream = transport.request(
    {
      hostname: target.hostname,
      port: target.port || undefined,
      path: `${target.pathname.replace(/\/$/, "")}${req.url}`,
      method: req.method,
      headers,
    },
    (up) => {
      if (wire.isCatalogCall(req.method, req.url)) {
        const chunks = [];
        up.on("data", (c) => chunks.push(c));
        up.on("end", () => {
          const data = Buffer.concat(chunks);
          try {
            for (const model of wire.parseCatalog(data.toString())) {
              if (model?.id) catalog.set(model.id, model);
            }
          } catch (err) {
            debug(`could not read model catalog: ${err.message}`);
          }
          const h = { ...up.headers };
          delete h["content-length"];
          res.writeHead(up.statusCode, h);
          res.end(data);
        });
        return;
      }

      res.writeHead(up.statusCode, up.headers);

      if (up.statusCode >= 400) {
        // An API error on a routed turn is the third ground-truth signal: the rung could
        // not serve the request as composed.
        if (active?.pending) commit(active, "escalated", "api_error");
        if (process.env.JEV_DEBUG) {
          let body = "";
          up.on("data", (c) => (body += body.length < 1000 ? c.toString("utf8") : ""));
          up.on("end", () => debug(`upstream ${up.statusCode}: ${body.slice(0, 400)}`));
        }
      }

      if (active?.pending) {
        const pending = active.pending;
        // Input counts arrive in the first frame, the final output count in the last, so
        // keep a bounded window of each rather than the whole response.
        let head = "";
        let tail = "";
        up.on("data", (c) => {
          const text = c.toString("utf8");
          if (head.length < 4000) head += text;
          // Codex puts usage in a final frame that carries the whole response object, so the
          // tail has to be wide enough to still contain it.
          tail = (tail + text).slice(-32000);
        });
        up.on("end", () => {
          // A turn is many requests — every tool call is another round trip — so the turn's
          // cost is their SUM. Taking the first response's usage and keeping it (the obvious
          // `||=`) undercounts a turn that wrote a file to a couple of dozen output tokens.
          //
          // Within one response, head and tail may both contain the same usage object, so
          // the two windows are combined with max rather than added.
          const fromHead = wire.meterFrom(head);
          const fromTail = wire.meterFrom(tail);
          for (const k of ["in", "out", "cacheRead", "cacheWrite"]) {
            pending[k] += Math.max(fromHead[k], fromTail[k]);
          }
        });
      }
      up.pipe(res);
    },
  );

  upstream.on("error", (e) => {
    debug(`upstream error: ${e.message}`);
    if (!res.headersSent) res.writeHead(502, { "content-type": "application/json" });
    res.end(JSON.stringify({ type: "error", error: { message: e.message } }));
  });
  if (out.length) upstream.write(out);
  upstream.end();
}

export { SENTINEL };
