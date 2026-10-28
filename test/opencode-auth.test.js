// OpenCode 2.x keeps credentials in SQLite, not in auth.json. provider-sync
// must notice and never write the legacy file there; keys it stores itself go
// into the provider's config entry.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import http from "node:http";
import { detectBackend, parseCredentialList, defaultDbPath } from "../lib/opencode-auth.js";
import { configApiKey, configApiKeyPaths, storeConfigApiKey, derefKey } from "../bin/provider-sync.js";
import { runCliAsyncP, flat } from "./helpers.js";
const loadCfgIn = (home) => JSON.parse(readFileSync(path.join(home, ".config/opencode/opencode.jsonc"), "utf8"));

// ---------- pure units (run everywhere) ----------

test("parses an array of credential rows", () => {
  assert.deepEqual(parseCredentialList('[{"id":"anthropic","type":"oauth"},{"provider":"local","type":"api"}]'),
    { anthropic: "oauth", local: "api" });
});

test("parses a map keyed by provider id", () => {
  assert.deepEqual(parseCredentialList('{"openai":{"type":"api"},"gemini":{"type":"wellknown"}}'),
    { openai: "api", gemini: "wellknown" });
});

test("parses wrapped lists and tolerates junk", () => {
  assert.deepEqual(parseCredentialList('{"credentials":[{"id":"a","type":"api"}]}'), { a: "api" });
  assert.deepEqual(parseCredentialList('{"providers":[{"id":"a","type":"api"}]}'), { a: "api" });
  assert.equal(parseCredentialList("not json"), null);
  assert.deepEqual(parseCredentialList("[]"), {});
});

test("OPENCODE_DB wins over the default location", () => {
  const b = detectBackend({ env: { OPENCODE_DB: "/somewhere/else.db" } });
  assert.equal(b.mode, "db");
  // path.resolve is drive-relative on Windows, so compare resolved forms
  assert.equal(b.dbPath, path.resolve("/somewhere/else.db"));
  assert.ok(path.isAbsolute(b.dbPath));
});

test("the documented default honours XDG_DATA_HOME", () => {
  assert.equal(defaultDbPath({ XDG_DATA_HOME: "/xdg" }), path.join("/xdg", "opencode", "opencode.db"));
});

test("no database means the legacy file", () => {
  const home = mkdtempSync(path.join(tmpdir(), "ps-v1-"));
  try {
    assert.equal(detectBackend({ env: { XDG_DATA_HOME: path.join(home, "data") } }).mode, "json");
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("any *.db in the data directory means 2.x, whichever release channel", () => {
  const home = mkdtempSync(path.join(tmpdir(), "ps-chan-"));
  try {
    const dir = path.join(home, "opencode");
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "opencode-beta.db"), "x");
    const b = detectBackend({ env: { XDG_DATA_HOME: home } });
    assert.equal(b.mode, "db");
    assert.match(b.dbPath, /opencode-beta\.db$/);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("derefKey resolves {env:VAR} from the process environment", () => {
  process.env.PS_TEST_DEREF = "v";
  try {
    assert.equal(derefKey("{env:PS_TEST_DEREF}"), "v");
    assert.equal(derefKey("{env:PS_TEST_UNSET_XYZ}"), null, "an unset variable is not a key");
    assert.equal(derefKey("literal"), "literal");
    assert.equal(derefKey(null), null);
    assert.equal(derefKey("{env:not a name}"), "{env:not a name}", "not a reference: passes through");
  } finally { delete process.env.PS_TEST_DEREF; }
});

// ---------- end to end against a fake opencode 2.x ----------

let server, url, binDir;
const homes = [];
const made = [];

before(async () => {
  server = http.createServer((q, s) => {
    if (q.url === "/v1/models") {
      s.setHeader("content-type", "application/json");
      s.end(JSON.stringify({ data: [{ id: "v2m", context_length: 4096 }] }));
    } else { s.statusCode = 404; s.end("{}"); }
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  url = `http://127.0.0.1:${server.address().port}/v1`;

  // a stand-in for the opencode 2.x CLI: reports a credential list as JSON
  binDir = mkdtempSync(path.join(tmpdir(), "ps-bin2-"));
  made.push(binDir);
  const script = path.join(binDir, "opencode");
  writeFileSync(script, `#!/bin/sh
case "$1 $2" in
  "debug paths") echo "$FAKE_DB" ;;
  "auth list")
    if [ -n "$FAKE_AUTH_FAIL" ]; then echo "opencode auth list"; echo "Usage: opencode auth list [options]"; exit 0; fi
    echo '[{"id":"v2prov","type":"api"}]' ;;
  *) echo '{}' ;;
esac
`, { mode: 0o755 });
});
after(() => { server.close(); for (const h of [...homes, ...made]) rmSync(h, { recursive: true, force: true }); });

const homeWith = (files) => {
  const home = mkdtempSync(path.join(tmpdir(), "ps-v2home-"));
  homes.push(home);
  for (const [rel, content] of Object.entries(files)) {
    const f = path.join(home, rel);
    mkdirSync(path.dirname(f), { recursive: true });
    writeFileSync(f, content);
  }
  return home;
};
const OC_CFG = `{
  "provider": {
    "v2prov": { "options": { "baseURL": "__URL__" }, "models": {} },
    "plain": { "options": { "baseURL": "http://x/v1" }, "models": {} }
  }
}
`;
const withFakeOpencode = async (home, args, extraEnv = {}) =>
  flat(await runCliAsyncP(home, args, {
    PATH: `${binDir}:${process.env.PATH}`,
    FAKE_DB: path.join(home, ".local/share/opencode/opencode.db"),
    ...extraEnv,
  }));

test("on 2.x, add --key stores it in the config entry, never in auth.json", { skip: process.platform === "win32" }, async () => {
  const home = homeWith({
    ".config/opencode/opencode.jsonc": OC_CFG.replace("__URL__", url),
    ".local/share/opencode/opencode.db": "SQLite format 3\0",
  });
  const out = await withFakeOpencode(home, ["add", "v2prov", url, "--key", "SECRET"]);
  assert.match(out, /keys \S*opencode\.jsonc api key for "v2prov"/);
  assert.equal(existsSync(path.join(home, ".local/share/opencode/auth.json")), false,
    "auth.json must not be created on 2.x");
  assert.equal(configApiKey(loadCfgIn(home), "v2prov"), "SECRET");
  // and list sees it as a usable credential, without printing the secret
  const listed = await withFakeOpencode(home, ["list"]);
  assert.match(listed, /v2prov .* key \(config\)/);
  assert.doesNotMatch(listed, /SECRET/, "a secret must never be printed");
});

test("on 2.x, list shows that a credential exists but not its value", { skip: process.platform === "win32" }, async () => {
  const home = homeWith({
    ".config/opencode/opencode.jsonc": OC_CFG.replace("__URL__", url),
    ".local/share/opencode/opencode.db": "SQLite format 3\0",
  });
  const out = await withFakeOpencode(home, ["list"]);
  assert.match(out, /v2prov .* key \(api, in opencode db\)/);
  assert.match(out, /plain .* no-key/);
  assert.match(out, /credentials live in OpenCode's database/);
  assert.doesNotMatch(out, /SECRET/, "a secret must never be printed");
});

test("on 1.x, the key goes to the same config entry and is reused", { skip: process.platform === "win32" }, async () => {
  const home = homeWith({ ".config/opencode/opencode.jsonc": OC_CFG.replace("__URL__", url) });
  const out = await withFakeOpencode(home, ["add", "v2prov", url, "--key", "SECRET"]);
  assert.match(out, /keys \S*opencode\.jsonc api key for "v2prov"/);
  assert.equal(configApiKey(loadCfgIn(home), "v2prov"), "SECRET");
  assert.match(await withFakeOpencode(home, ["list"]), /v2prov .* key \(config\)/);
});

test("--key-env stores an env reference instead of the secret", { skip: process.platform === "win32" }, async () => {
  const home = homeWith({ ".config/opencode/opencode.jsonc": OC_CFG.replace("__URL__", url) });
  await withFakeOpencode(home, ["add", "v2prov", url, "--key-env", "V2PROV_KEY"]);
  assert.equal(configApiKey(loadCfgIn(home), "v2prov"), "{env:V2PROV_KEY}");
});

test("both config schemas round-trip a key", () => {
  const v1 = { provider: { a: { options: {} } } };
  assert.deepEqual(storeConfigApiKey(v1, "a", "K"), ["provider.a.options.apiKey"]);
  assert.equal(configApiKey(v1, "a"), "K");
  const v2 = { providers: { b: { settings: {} } } };
  assert.deepEqual(storeConfigApiKey(v2, "b", "K"), ["providers.b.settings.apiKey"],
    "a 2.x-only config must get the 2.x path and no 1.x entry");
  assert.equal(configApiKey(v2, "b"), "K");
  // the path shown in the report is the path actually written
  assert.deepEqual(configApiKeyPaths(v2, "b"), storeConfigApiKey(v2, "b", "K"));
  // the key goes to the entry's own shape only: OpenCode 2.x lets a native
  // entry shadow a legacy one wholesale, so a duplicate is not harmless
  const mixed = { provider: { d: { options: {} } }, providers: { c: { settings: {} } } };
  assert.deepEqual(configApiKeyPaths(mixed, "c"), ["providers.c.settings.apiKey"]);
  assert.deepEqual(storeConfigApiKey(mixed, "c", "K"), ["providers.c.settings.apiKey"]);
  assert.deepEqual(configApiKeyPaths(mixed, "d"), ["provider.d.options.apiKey"]);
  assert.deepEqual(storeConfigApiKey(mixed, "d", "K"), ["provider.d.options.apiKey"]);
  assert.equal("d" in mixed.providers, false, "no partial native entry for a legacy provider");
  // a brand-new id in a providers-only config follows the 2.x dialect
  const v2only = { providers: {} };
  assert.deepEqual(configApiKeyPaths(v2only, "e"), ["providers.e.settings.apiKey"]);
});

test("a mixed install still uses the readable key and says it may be stale", { skip: process.platform === "win32" }, async () => {
  const home = homeWith({
    ".config/opencode/opencode.jsonc": OC_CFG.replace("__URL__", url),
    ".local/share/opencode/opencode.db": "SQLite format 3\0",      // 2.x store exists
    ".local/share/opencode/auth.json": JSON.stringify({ v2prov: { type: "api", key: "OLD" } }),
  });
  const out = await withFakeOpencode(home, ["list"]);
  // the value we can read wins over the store we cannot read
  assert.match(out, /v2prov .* key \(auth\.json, may be stale\)/);
  assert.match(out, /plain .* no-key/);
  assert.match(out, /imported at migration and may be stale/);
});

test("a database with no listable CLI reports unknown, not no-key", { skip: process.platform === "win32" }, async () => {
  const home = homeWith({
    ".config/opencode/opencode.jsonc": OC_CFG.replace("__URL__", url),
    ".local/share/opencode/opencode.db": "SQLite format 3\0",
  });
  // an opencode build whose "auth list" cannot answer (1.x binary, 2.x database)
  const out = await withFakeOpencode(home, ["list"], { FAKE_AUTH_FAIL: "1" });
  assert.match(out, /unknown \(a database is present; the opencode CLI cannot list credentials\)/);
  assert.doesNotMatch(out, /no-key/);
});

test("detecting the backend must not create directories in the home", { skip: process.platform === "win32" }, async () => {
  const home = homeWith({ ".config/opencode/opencode.jsonc": OC_CFG.replace("__URL__", url) });
  await withFakeOpencode(home, ["list"]);
  assert.equal(existsSync(path.join(home, ".local")), false, "no ~/.local created by detection");
  assert.equal(existsSync(path.join(home, ".cache")), false, "no ~/.cache created by detection");
});

test("an {env:VAR} config key is resolved from the environment when probing", async () => {
  const srv = http.createServer((q, s) => {
    if (q.url === "/v1/models" && q.headers.authorization === "Bearer SECRET") {
      s.setHeader("content-type", "application/json");
      s.end(JSON.stringify({ data: [{ id: "m1", context_length: 4096 }] }));
    } else {
      s.statusCode = 401;
      s.end("{}");
    }
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  try {
    const u = `http://127.0.0.1:${srv.address().port}/v1`;
    const today = new Date().toISOString().slice(0, 10);
    const home = homeWith({
      ".config/opencode/opencode.jsonc": `{
  "provider": {
    "envp": { "options": { "baseURL": "${u}", "apiKey": "{env:PS_TEST_SYNC_KEY}" }, "models": { "m1": { "release_date": "${today}", "limit": { "context": 4096, "output": 1024 } } } }
  }
}
`,
    });
    // with the variable set, sync authenticates and the provider is in sync
    const ok = flat(await runCliAsyncP(home, ["sync", "--target", "opencode"], { PS_TEST_SYNC_KEY: "SECRET" }));
    assert.match(ok, /in sync/);
    assert.doesNotMatch(ok, /AUTH 401/);
    // without it, the failure names the variable instead of misreporting the key
    const miss = flat(await runCliAsyncP(home, ["sync", "--target", "opencode"]));
    assert.match(miss, /AUTH 401 — its key is \{env:PS_TEST_SYNC_KEY\}, which is not set in this environment/);
    // a --key that is rejected is reported as the rejected key, not as "missing"
    const wrong = flat(await runCliAsyncP(home, ["sync", "--target", "opencode", "--key", "WRONG"]));
    assert.match(wrong, /AUTH 401 — the key passed with --key was rejected/);
  } finally { srv.close(); }
});

test("hermes sync explains a key stored in the opencode database, and --key still checks the server", { skip: process.platform === "win32" }, async () => {
  const srv = http.createServer((q, s) => {
    if (q.url === "/v1/models" && q.headers.authorization === "Bearer SECRET") {
      s.setHeader("content-type", "application/json");
      s.end(JSON.stringify({ data: [{ id: "m1", context_length: 4096 }] }));
    } else {
      s.statusCode = 401;
      s.end("{}");
    }
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  try {
    const u = `http://127.0.0.1:${srv.address().port}/v1`;
    const home = homeWith({
      ".config/opencode/opencode.jsonc": `{\n  "provider": {\n    "v2prov": { "options": { "baseURL": "${u}" }, "models": {} }\n  }\n}\n`,
      ".local/share/opencode/opencode.db": "SQLite format 3\0",
      ".hermes/config.yaml": `custom_providers:\n  - name: H\n    base_url: ${u}\n    api_key: dummy\n    models:\n      m1:\n        context_length: 4096\n`,
    });
    // the fake opencode CLI says v2prov's credential lives in the database:
    // the failure must say where the key is, not that it is missing
    const miss = await withFakeOpencode(home, ["sync", "--target", "hermes"]);
    assert.match(miss, /AUTH 401 — its key is in OpenCode's database \(from v2prov\) and cannot be read here; pass --key K/);
    // and --key turns that into a working check without storing anything
    const ok = await withFakeOpencode(home, ["sync", "--target", "hermes", "--key", "SECRET"]);
    assert.match(ok, /in sync/);
    assert.doesNotMatch(ok, /AUTH 401/);
    assert.doesNotMatch(readFileSync(path.join(home, ".hermes/config.yaml"), "utf8"), /SECRET/);
  } finally { srv.close(); }
});

test("list --target hermes does not print the opencode key-store line", { skip: process.platform === "win32" }, async () => {
  const home = homeWith({
    ".config/opencode/opencode.jsonc": OC_CFG.replace("__URL__", url),
    ".local/share/opencode/opencode.db": "SQLite format 3\0",
    ".hermes/config.yaml": `custom_providers:\n  - name: H\n    base_url: ${url}\n    api_key: dummy\n    models:\n      m1:\n        context_length: 4096\n`,
  });
  const onlyH = await withFakeOpencode(home, ["list", "--target", "hermes"]);
  assert.match(onlyH, /hermes \S*config\.yaml/);
  assert.doesNotMatch(onlyH, /credentials live in OpenCode's database/, "an opencode-only store line is not hermes output");
  // a run that does show opencode still names its store
  const full = await withFakeOpencode(home, ["list"]);
  assert.match(full, /credentials live in OpenCode's database/);
});
