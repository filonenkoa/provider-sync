// `add` on an Unsloth UI server: --username/--password is one login pair.
// Half a pair used to be dropped silently (the login branch needs both), and a
// pair that cannot be used must be reported instead of vanishing.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import http from "node:http";
import { runCliAsyncP, flat } from "./helpers.js";

let server, base;
let hits = {};
const homes = [];
const MODELS = [{ id: "u-1", context_length: 32768 }];

before(async () => {
  server = http.createServer((q, s) => {
    hits[q.url] = (hits[q.url] || 0) + 1;
    const json = (body) => { s.setHeader("content-type", "application/json"); s.end(JSON.stringify(body)); };
    // an Unsloth UI: /openapi.json names it, the login routes mint a key
    if (q.url === "/unsloth/openapi.json") return json({ info: { title: "Unsloth UI mock" } });
    if (q.url === "/unsloth/api/auth/login") return json({ access_token: "login-token" });
    if (q.url === "/unsloth/api/auth/api-keys") return json({ api_key: "created-key" });
    if (q.url === "/unsloth/v1/models" || q.url === "/plain/v1/models") return json({ data: MODELS });
    s.statusCode = 404;
    s.end("{}");
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => { server.close(); for (const h of homes) rmSync(h, { recursive: true, force: true }); });

const homeWith = (files) => {
  const home = mkdtempSync(path.join(tmpdir(), "ps-unsloth-"));
  homes.push(home);
  for (const [rel, content] of Object.entries(files)) {
    const f = path.join(home, rel);
    mkdirSync(path.dirname(f), { recursive: true });
    writeFileSync(f, content);
  }
  return home;
};
const OC_CFG = '{\n  "provider": {}\n}\n';
const ocHome = () => homeWith({ ".config/opencode/opencode.jsonc": OC_CFG });
const cfgIn = (home) => JSON.parse(readFileSync(path.join(home, ".config/opencode/opencode.jsonc"), "utf8"));
const authHits = () => Object.keys(hits).filter((u) => u.includes("/api/auth")).length;

test("half a --username/--password pair is refused before anything is probed", async () => {
  const home = ocHome();
  // a closed port: if the pair were not checked first, the run would fail with
  // a connection error instead of the pairing message
  const dead = "http://127.0.0.1:1/v1";
  await assert.rejects(() => runCliAsyncP(home, ["add", "mm", dead, "--username", "u"]),
    /--username and --password must be given together/);
  await assert.rejects(() => runCliAsyncP(home, ["add", "mm", dead, "--password", "p"]),
    /--username and --password must be given together/);
  assert.equal(readFileSync(path.join(home, ".config/opencode/opencode.jsonc"), "utf8"), OC_CFG,
    "a refused add writes nothing");
});

test("a full pair logs in to an Unsloth UI and stores the created key", async () => {
  hits = {};
  const home = ocHome();
  const out = flat(await runCliAsyncP(home, ["add", "mm", `${base}/unsloth/v1`, "--username", "u", "--password", "p", "--target", "opencode"]));
  assert.match(out, /created persistent Unsloth API key for mm/);
  assert.match(out, /provider "mm" \(1 models/);
  assert.equal(cfgIn(home).provider.mm.options.apiKey, "created-key");
  assert.equal(hits["/unsloth/api/auth/login"], 1, "the login route is called once");
  assert.equal(hits["/unsloth/api/auth/api-keys"], 1, "a persistent key is created once");
});

test("a pair on a server that is not Unsloth UI is a note, not a silent no-op", async () => {
  hits = {};
  const home = ocHome();
  const out = flat(await runCliAsyncP(home, ["add", "mm", `${base}/plain/v1`, "--username", "u", "--password", "p", "--target", "opencode"]));
  assert.match(out, /note: --username\/--password not used — the server was detected as openai, not Unsloth UI/);
  assert.equal(authHits(), 0, "no login is attempted against a non-Unsloth server");
  assert.ok(!("apiKey" in cfgIn(home).provider.mm.options), "no key is invented");
});

test("with a usable key already present the pair is reported as unused", async () => {
  hits = {};
  const home = homeWith({
    ".config/opencode/opencode.jsonc": JSON.stringify({
      provider: { mm: { options: { baseURL: `${base}/unsloth/v1`, apiKey: "OLD" }, models: {} } },
    }, null, 2) + "\n",
  });
  const out = flat(await runCliAsyncP(home, ["add", "mm", `${base}/unsloth/v1`, "--username", "u", "--password", "p", "--target", "opencode"]));
  assert.match(out, /note: --username\/--password not used — an API key is already available/);
  assert.equal(authHits(), 0, "no login when a key already works");
  assert.equal(cfgIn(home).provider.mm.options.apiKey, "OLD", "the existing key is kept");
});

test("--dry-run with a pair uses a temporary token and creates no key", async () => {
  hits = {};
  const home = ocHome();
  const out = flat(await runCliAsyncP(home, ["add", "mm", `${base}/unsloth/v1`, "--username", "u", "--password", "p", "--target", "opencode", "--dry-run"]));
  assert.match(out, /note: dry-run — using a temporary login token, no API key created/);
  assert.match(out, /dry-run: nothing written/);
  assert.equal(hits["/unsloth/api/auth/login"], 1);
  assert.equal(hits["/unsloth/api/auth/api-keys"], undefined, "no persistent key in a dry run");
  assert.equal(readFileSync(path.join(home, ".config/opencode/opencode.jsonc"), "utf8"), OC_CFG);
});
