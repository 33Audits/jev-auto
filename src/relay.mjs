import http from "node:http";
import https from "node:https";
import { writeFileSync } from "node:fs";
import { SENTINEL, TIER_ORDER, retarget, enabledTiers, accountModels, defaultIdFor, isSentinel, modelIdFor, heightOf, tierOfModel } from "./ladder.mjs";
import { threadKey, weighRequest, readsAsRetry, freshTurnText, normalizeToolSchema, sessionIdOf, meterFrom } from "./wire.mjs";
import { verdictFor } from "./verdict.mjs";
import { selectAppraiser, appraiserName } from "./appraisers/index.mjs";
import { cutoffs as calibratedThresholds } from "./calibrate.mjs";
import { append as appendLedger, read as readLedger } from "./ledger.mjs";
import { RULES } from "./tuning.mjs";
import { debug, log } from "./diag.mjs";
import { recordDecision, recordManual } from "./journal.mjs";

export const UPSTREAM_DEFAULT = "https://api.anthropic.com";

const AUTH_HEADERS = ["authorization", "x-api-key", "anthropic-version", "anthropic-beta"];
const authHeadersOf = (headers) =>
  Object.fromEntries(AUTH_HEADERS.filter((h) => headers[h]).map((h) => [h, headers[h]]));

const isMessagesCall = (url) => /^\/v1\/messages/.test(url ?? "");
const isModelsCall = (method, url) => method === "GET" && /^\/v1\/models(?:\?|$)/.test(url ?? "");

/**
 * Starts the loopback proxy. It forwards the CLI's own authorization headers without
 * reading, storing, or modifying them; the only thing it changes in a request is which
 * model it names.
 */
export async function startRelay({
  upstreamURL = UPSTREAM_DEFAULT,
  appraise = selectAppraiser(),
  ledger = appendLedger,
} = {}) {
  const threads = new Map();
  const catalog = new Map();
  // Boundaries are derived once at startup: the ledger only moves them across sessions, and
  // re-deriving per turn would make a session's routing shift under the user mid-task.
  const cutoffs = calibratedThresholds(readLedger());
  debug(`cutoffs cheap=${cutoffs.cheap} strong=${cutoffs.strong} backend=${appraiserName()}`);

  const threadState = (key) => {
    let s = threads.get(key);
    if (!s) {
      if (threads.size > 50) {
        const oldest = threads.keys().next().value;
        flush(threads.get(oldest));
        threads.delete(oldest);
      }
      threads.set(key, (s = { tier: null, model: null, pending: null, floor: null, floorTurns: 0 }));
    }
    return s;
  };

  /** Write a finished turn to the ledger. Called when the next turn starts, or at shutdown. */
  const flush = (state, verdict = "ok", code = null) => {
    if (!state?.pending) return;
    ledger({ ...state.pending, verdict, code });
    state.pending = null;
  };

  /**
   * Grade the previous turn against what the user did next. This is the ground truth the
   * calibrator runs on: a correction, a manual escalation, or an API error means the tier
   * chosen for that turn was too cheap.
   */
  const grade = (state, { correction }) => {
    if (!state.pending) return;
    if (correction) {
      flush(state, "escalated", "redo");
      holdFloor(state, state.tier);
    } else {
      flush(state, "ok");
      if (state.floorTurns > 0 && --state.floorTurns === 0) state.floor = null;
    }
  };

  const holdFloor = (state, from) => {
    const next = TIER_ORDER[Math.min(heightOf(from) + 1, heightOf("opus"))];
    state.floor = next;
    state.floorTurns = RULES.escalationStickyTurns;
    debug(`escalation floor -> ${next} for ${RULES.escalationStickyTurns} turns`);
  };

  const server = http.createServer((req, res) => {
    if (req.method === "HEAD") return res.writeHead(200).end(); // base-URL probe

    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", async () => {
      let out = Buffer.concat(chunks);
      let routed = null; // { state } when this request is a routed agent turn

      if (isMessagesCall(req.url)) {
        try {
          const body = JSON.parse(out.toString());
          if (process.env.JEV_DUMP) {
            writeFileSync(`${process.env.JEV_DUMP}.${Date.now()}.json`, JSON.stringify(body, null, 2));
          }
          body.tools?.forEach((t) => normalizeToolSchema(t.input_schema));

          if (!isSentinel(body.model)) {
            // Anything but the sentinel is a model the user chose, and an explicit choice
            // beats the router. This also covers Claude Code's own cheap auxiliary calls,
            // which must never be pinned up to the session's tier.
            const state = threads.get(threadKey(body));
            if (Array.isArray(body.tools) && body.tools.length) {
              recordManual(sessionIdOf(body), body.model);
              // Switching to a stronger model mid-conversation is the clearest possible
              // statement that the routed tier was not enough.
              if (state?.pending && heightOf(tierOfModel(body.model)) > heightOf(state.pending.tier)) {
                flush(state, "escalated", "manual_escalate");
                holdFloor(state, state.pending?.tier ?? state.tier);
              }
            }
            debug(`passthrough, user selected ${body.model}`);
          } else {
            const state = threadState(threadKey(body));
            routed = state;
            // What the prompt cache was built on. Before anything has been routed there is
            // no cache and no evidence, so the baseline is the balanced tier: an
            // unroutable request must not silently default to the most expensive model.
            const current = state.tier ?? "sonnet";
            const prompt = freshTurnText(body);

            if (prompt) {
              grade(state, { correction: readsAsRetry(prompt) });

              const models = accountModels([...catalog.values()]).filter((m) =>
                enabledTiers().includes(m.tier),
              );
              const available = [...new Set(models.map((m) => m.tier))];
              const contextTokens = weighRequest(body);
              // Wrapped rather than awaited directly: a backend may be synchronous (the
              // local one is) and may throw rather than reject. Both are failures that must
              // land on "keep the current tier", never on a broken request.
              const decision = await Promise.resolve()
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
                .catch((err) => (log(`router failed, holding ${current}: ${err.message}`), null));

              const { tier, reason } = verdictFor({
                prompt,
                decision,
                current,
                available,
                contextTokens,
                hasCache: state.tier !== null,
                floor: state.floor,
              });
              state.tier = tier;
              // Prefer the exact newest model in the chosen tier that the account reports.
              state.model = tier === current && state.model ? state.model : modelIdFor(models, tier);
              state.pending = {
                t: Date.now(),
                shape: decision?.shape ?? "unknown",
                tier,
                backend: decision?.backend ?? "none",
                score: decision?.score ?? null,
                conf: decision?.confidence ?? null,
                in: 0, out: 0, cacheRead: 0, cacheWrite: 0,
              };
              debug(
                `${state.tier} (${reason}) score=${decision?.score?.toFixed(2) ?? "n/a"} ` +
                  `p=${decision?.confidence?.toFixed(2) ?? "n/a"} ctx~${contextTokens} | ${prompt.slice(0, 60)}`,
              );
              recordDecision(sessionIdOf(body), {
                tier,
                model: state.model,
                prompt,
                reason,
                confidence: decision?.confidence ?? null,
                metrics: decision?.metrics ?? null,
                score: decision?.score ?? null,
                backend: decision?.backend ?? "none",
                cutoffs,
                floor: state.floor,
                at: Date.now(),
              });
            }

            // The sentinel is not a real model, so every routed request must be rewritten,
            // including tool-loop follow-ups that reuse the tier chosen for the turn.
            const tier = state.tier ?? current;
            retarget(body, tier, state.model ?? defaultIdFor(tier));
          }
          out = Buffer.from(JSON.stringify(body));
        } catch (err) {
          debug(`passthrough, could not process body: ${err.message}`);
        }
      }

      pipeUpstream(req, res, out, { upstreamURL, catalog, routed, flush });
    });
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    port: server.address().port,
    cutoffs,
    close: () => {
      for (const state of threads.values()) flush(state);
      server.close();
    },
  };
}

function pipeUpstream(req, res, out, { upstreamURL, catalog, routed, flush }) {
  const target = new URL(upstreamURL);
  const transport = target.protocol === "http:" ? http : https;
  const headers = { ...req.headers, host: target.host };
  delete headers["content-length"];
  // The model catalog and the usage tap both need to read the body, so ask for it raw.
  if (isModelsCall(req.method, req.url) || isMessagesCall(req.url)) delete headers["accept-encoding"];

  const upstream = transport.request(
    {
      hostname: target.hostname,
      port: target.port || undefined,
      path: `${target.pathname.replace(/\/$/, "")}${req.url}`,
      method: req.method,
      headers,
    },
    (up) => {
      if (isModelsCall(req.method, req.url)) {
        const chunks = [];
        up.on("data", (c) => chunks.push(c));
        up.on("end", () => {
          const data = Buffer.concat(chunks);
          try {
            for (const model of JSON.parse(data.toString()).data ?? []) {
              if (tierOfModel(model?.id)) catalog.set(model.id, model);
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

      // An API error on a routed turn is the third ground-truth signal: the tier could not
      // serve the request as composed.
      if (up.statusCode >= 400) {
        if (routed?.pending) flush(routed, "escalated", "api_error");
        // The body says which request field the routed tier rejected, which is the only
        // way to find a new capability gap when the wire format moves.
        if (process.env.JEV_DEBUG) {
          let body = "";
          up.on("data", (c) => (body += body.length < 1000 ? c.toString("utf8") : ""));
          up.on("end", () => debug(`upstream ${up.statusCode}: ${body.slice(0, 400)}`));
        }
      }

      // Passive usage tap. Reading is free here because the stream is already flowing to
      // the client; nothing is buffered and nothing is delayed.
      if (routed?.pending) {
        const pending = routed.pending;
        // Input counts arrive in the first frame, the final output count in the last, so
        // keep a bounded window of each rather than the whole response.
        let head = "";
        let tail = "";
        up.on("data", (c) => {
          const text = c.toString("utf8");
          if (head.length < 4000) head += text;
          tail = (tail + text).slice(-4000);
        });
        up.on("end", () => {
          for (const window of [head, tail]) {
            const u = meterFrom(window);
            for (const k of ["in", "out", "cacheRead", "cacheWrite"]) pending[k] ||= u[k];
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
