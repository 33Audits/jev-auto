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
import { debug, log } from "./diag.mjs";
import { recordDecision, recordManual } from "./journal.mjs";
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
export async function startRelay({
  wire = claudeWire,
  upstreamURL = wire.upstream,
  appraise = selectAppraiser(),
  ledger = recordTurn,
} = {}) {
  const platform = wire.platform;
  const threads = new Map();
  const catalog = new Map();
  // Cutoffs are derived once at startup: the ledger only moves them across sessions, and
  // re-deriving per turn would shift a session's routing under the user mid-task.
  const cutoffs = calibratedCutoffs(readLedger());
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
      threads.set(key, (s = { tier: null, model: null, pending: null, floor: null, floorTurns: 0 }));
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

              // JEV_PIN meters a session without routing it: the relay still records tokens,
              // cost, and escalations, but every turn runs on one rung. This is the control
              // arm a routed run is compared against, and the honest way to measure both —
              // same accounting path, same overhead, only the decision differs.
              const pinned = TIER_ORDER.includes(process.env.JEV_PIN) ? process.env.JEV_PIN : null;

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
                    upstream: upstreamURL,
                    auth: authHeadersOf(req.headers),
                  }),
                )
                .catch((err) => (log(`appraiser failed, holding ${current}: ${err.message}`), null));

              const { tier, reason } = verdictFor({
                prompt, decision, current, available, contextTokens,
                hasCache: state.tier !== null, floor: state.floor, platform,
              });
              state.tier = tier;
              state.model = tier === current && state.model ? state.model : modelIdFor(models, tier, platform);
              state.pending = {
                t: Date.now(), shape: decision?.shape ?? "unknown", tier,
                backend: decision?.backend ?? "none", score: decision?.score ?? null,
                conf: decision?.confidence ?? null, in: 0, out: 0, cacheRead: 0, cacheWrite: 0,
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
