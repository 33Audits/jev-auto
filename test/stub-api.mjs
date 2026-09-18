import http from "node:http";

/** A stand-in for the Anthropic API that records what the proxy actually sent. */
export async function fakeUpstream({ status = 200, usage = { input_tokens: 100, output_tokens: 40 } } = {}) {
  const seen = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString();
      let body = null;
      try {
        body = JSON.parse(raw);
      } catch {
        // GETs have no body.
      }
      seen.push({ url: req.url, method: req.method, body, headers: req.headers });

      if (req.method === "GET" && req.url.startsWith("/v1/models")) {
        res.writeHead(200, { "content-type": "application/json" });
        return res.end(JSON.stringify({ data: [{ id: "claude-sonnet-5", display_name: "Sonnet 5" }] }));
      }
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify({ id: "msg_1", model: body?.model, usage }));
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return { url: `http://127.0.0.1:${server.address().port}`, seen, close: () => server.close() };
}

export const post = (base, body, headers = {}) =>
  fetch(`${base}/v1/messages`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
