// network layer: server detection, request counts, body caps.
// These lock in the behaviour of the probe cache and the capped openapi.json read.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { req, probe, fetchModels, probeCached, clearProbeCache } from "../bin/provider-sync.js";

let server, base;
let hits = {};
const bump = (p) => { hits[p] = (hits[p] || 0) + 1; };
const reset = () => { hits = {}; clearProbeCache(); };
const url = (kind) => `${base}/${kind}/v1`;

// a padded OpenAPI-ish document: info.title sits early, then 300 KB of filler,
// so a capped read cannot possibly parse it as JSON
const OPENAPI_BIG = JSON.stringify({ info: { title: "Unsloth UI 0.2" }, paths: { "/api": { x: "y".repeat(300000) } } });

before(async () => {
  server = http.createServer((rq, rs) => {
    const kind = rq.url.split("/")[1];
    const send = (code, body, type = "application/json") => { bump(kind + rq.url.replace("/" + kind, "")); rs.writeHead(code, { "content-type": type }); rs.end(body); };
    if (kind === "unsloth" && rq.url.endsWith("/openapi.json")) return send(200, OPENAPI_BIG);
    if (rq.url.endsWith("/openapi.json")) return send(404, "{}");
    if (kind === "lm" && rq.url.endsWith("/api/v0/models"))
      return send(200, JSON.stringify({ data: [{ id: "lm-1", loaded_context_length: 8192, type: "llm" }, { id: "emb", type: "embeddings" }] }));
    if (rq.url.endsWith("/api/v0/models")) return send(404, "{}");
    if (kind === "dead") return send(500, "nope", "text/plain");
    if (kind === "auth") return send(401, JSON.stringify({ error: "no key" }));
    if (rq.url.endsWith("/v1/models")) return send(200, JSON.stringify({ data: [{ id: "oa-1", context_length: 4096 }] }));
    send(404, "{}");
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

test("openai-compatible server: /v1/models is fetched once in total", async () => {
  reset();
  const pr = await probe(url("openai"), null);
  const models = await fetchModels(pr, url("openai"), null);
  assert.equal(pr.kind, "openai");
  assert.deepEqual(models.map((m) => m.id), ["oa-1"]);
  assert.equal(hits["openai/v1/models"], 1, "probe payload must be reused, not refetched");
});

test("lm studio: /api/v0/models is fetched once and embeddings are skipped", async () => {
  reset();
  const pr = await probe(url("lm"), null);
  const models = await fetchModels(pr, url("lm"), null);
  assert.equal(pr.kind, "lmstudio");
  assert.deepEqual(models.map((m) => m.id), ["lm-1", "emb"]);
  assert.equal(models[0].ctx, 8192);
  assert.equal(models[1].skip, true, "embeddings are flagged skip, not dropped");
  assert.equal(hits["lm/api/v0/models"], 1, "probe payload must be reused, not refetched");
});

test("unsloth is still detected when the openapi.json is too big to parse", async () => {
  reset();
  const pr = await probe(url("unsloth"), null);
  assert.equal(pr.kind, "unsloth", "title must be read from the text when json is truncated");
});

test("the openapi.json read is capped instead of downloading everything", async () => {
  reset();
  const r = await req(url("unsloth").replace("/v1", "") + "/openapi.json", { cap: 8192 });
  assert.ok(r.text.length < OPENAPI_BIG.length / 4, `read ${r.text.length} of ${OPENAPI_BIG.length} bytes`);
  assert.equal(r.json, null, "a capped body is not valid json, by design");
});

test("the probe cache serves a second probe of the same url", async () => {
  reset();
  const a = await probeCached(url("openai"), null);
  const b = await probeCached(url("openai"), null);
  assert.equal(a, b, "same cached result object");
  assert.equal(hits["openai/openapi.json"], 1, "second call made no request");
});

test("different keys are probed separately", async () => {
  reset();
  await probeCached(url("openai"), "k1");
  await probeCached(url("openai"), "k2");
  assert.equal(hits["openai/openapi.json"], 2);
});

test("an unreachable server reports offline instead of throwing", async () => {
  reset();
  const pr = await probe("http://127.0.0.1:1/v1", null);
  assert.equal(pr.kind, "offline");
  assert.ok(pr.error, "carries a reason");
});

test("a 500 from the models endpoint is reported as offline with the status", async () => {
  reset();
  const pr = await probe(url("dead"), null);
  assert.equal(pr.kind, "offline");
  assert.match(pr.error, /HTTP 500/);
});

test("a 401 from the models endpoint is reported as auth, not offline", async () => {
  reset();
  const pr = await probe(url("auth"), "sk-wrong");
  assert.equal(pr.kind, "auth");
});
