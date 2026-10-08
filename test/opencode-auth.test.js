// OpenCode 2.x keeps credentials in SQLite, not in auth.json. provider-sync
// must notice, never write the legacy file there, and say what to run instead.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import http from "node:http";
import { detectBackend, parseCredentialList, defaultDbPath, loginCommand } from "../lib/opencode-auth.js";
import { runCliAsyncP, flat } from "./helpers.js";

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

test("the documented store command is the one we tell users to run", () => {
  assert.equal(loginCommand("myprov"), "opencode auth login myprov --method key");
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

test("on 2.x, add --key does not write auth.json and names the real command", { skip: process.platform === "win32" }, async () => {
  const home = homeWith({
    ".config/opencode/opencode.jsonc": OC_CFG.replace("__URL__", url),
    ".local/share/opencode/opencode.db": "SQLite format 3\0",
  });
  const out = await withFakeOpencode(home, ["add", "v2prov", url, "--key", "SECRET"]);
  assert.match(out, /keys \S*auth\.json not written by provider-sync — run: opencode auth login v2prov --method key/);
  assert.match(out, /note: provider-sync did not store the key/);
  assert.equal(existsSync(path.join(home, ".local/share/opencode/auth.json")), false,
    "auth.json must not be created on 2.x");
  assert.doesNotMatch(out, /auth\.json\s+api key for/);
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

test("on 1.x, auth.json is still written and reused", { skip: process.platform === "win32" }, async () => {
  const home = homeWith({ ".config/opencode/opencode.jsonc": OC_CFG.replace("__URL__", url) });
  const out = await withFakeOpencode(home, ["add", "v2prov", url, "--key", "SECRET"]);
  assert.match(out, /auth\.json\s+api key for "v2prov"/);
  const authPath = path.join(home, ".local/share/opencode/auth.json");
  assert.equal(JSON.parse(readFileSync(authPath, "utf8")).v2prov.key, "SECRET");
  // and a second run reuses it instead of asking again
  assert.match(await withFakeOpencode(home, ["list"]), /v2prov .* key/);
});

test("with no credential store at all, the legacy write still happens with a warning", { skip: process.platform === "win32" }, async () => {
  const home = homeWith({ ".config/opencode/opencode.jsonc": OC_CFG.replace("__URL__", url) });
  const out = await withFakeOpencode(home, ["add", "v2prov", url, "--key", "SECRET"]);
  assert.match(out, /note: no OpenCode credential store was found/);
  assert.match(out, /opencode auth login v2prov --method key/, "still points at the 2.x way");
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