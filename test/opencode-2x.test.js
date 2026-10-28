// OpenCode 2.x config shape: a native entry lives in `providers.<id>` (package /
// settings.baseURL / settings.apiKey / models). When both sections name one id,
// 2.x lets the native entry REPLACE the legacy one wholesale — so a partial
// native entry (e.g. only an apiKey) shadows and breaks a complete legacy
// provider. provider-sync must update the shape an entry already uses and never
// write a second entry for the same id.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import http from "node:http";
import { runCli, runCliAsync, runCliAsyncP, hermeticEnv, flat, CLI } from "./helpers.js";

let server, url;
const homes = [];

before(async () => {
  server = http.createServer((q, s) => {
    if (q.url === "/v1/models") {
      s.setHeader("content-type", "application/json");
      s.end(JSON.stringify({ data: [
        { id: "mm-1", context_length: 4096 },
        { id: "mm-2", context_length: 8192 },
      ] }));
    } else { s.statusCode = 404; s.end("{}"); }
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  url = `http://127.0.0.1:${server.address().port}/v1`;
});
after(() => { server.close(); for (const h of homes) rmSync(h, { recursive: true, force: true }); });

const homeWith = (files) => {
  const home = mkdtempSync(path.join(tmpdir(), "ps-2x-"));
  homes.push(home);
  for (const [rel, content] of Object.entries(files)) {
    const f = path.join(home, rel);
    mkdirSync(path.dirname(f), { recursive: true });
    writeFileSync(f, content);
  }
  return home;
};
const readCfg = (home, rel = ".config/opencode/opencode.jsonc") =>
  JSON.parse(readFileSync(path.join(home, rel), "utf8"));
const addEnv = async (home, args = [], extraEnv = {}) =>
  flat(await runCliAsyncP(home, ["add", "mm", url, ...args], extraEnv));
const add = (home, args = []) => addEnv(home, args);

const NATIVE_PKG = "@opencode/ai/providers/openai-compatible";

test("a new provider in a mixed config stays legacy — no partial native entry", async () => {
  // OpenCode 2.x would let providers.mm (holding only a key) shadow the whole
  // legacy provider.mm and fail with "Model unavailable"
  const mixed = JSON.stringify({
    provider: { old: { npm: "@ai-sdk/openai-compatible", options: { baseURL: "http://old/v1" }, models: {} } },
    providers: { native: { name: "Native", package: NATIVE_PKG, settings: { baseURL: "http://native/v1" }, models: { x: {} } } },
  }, null, 2) + "\n";
  const home = homeWith({ ".config/opencode/opencode.jsonc": mixed });
  const out = await add(home, ["--key", "K1"]);
  assert.match(out, /provider "mm" \(2 models/);
  const cfg = readCfg(home);
  assert.equal(cfg.providers.mm, undefined, "no partial native entry for a legacy provider");
  assert.equal(cfg.provider.mm.options.apiKey, "K1");
  assert.equal(cfg.provider.mm.options.baseURL, url);
  assert.equal(cfg.provider.mm.models["mm-1"].limit.context, 4096);
});

test("add updates a 2.x providers entry in place", async () => {
  const cfg0 = JSON.stringify({
    providers: {
      mm: {
        name: "MM",
        package: NATIVE_PKG,
        settings: { baseURL: url, apiKey: "OLD", timeout: 5000 },
        models: { stale: { name: "stale" } },
      },
    },
  }, null, 2) + "\n";
  const home = homeWith({ ".config/opencode/opencode.jsonc": cfg0 });
  const out = await add(home, ["--key", "NEW"]);
  assert.match(out, /api key for "mm" in \S*opencode\.jsonc \S*providers\.mm\.settings\.apiKey/);
  const cfg = readCfg(home);
  assert.equal(cfg.provider, undefined, "no legacy section invented");
  const p = cfg.providers.mm;
  assert.equal(p.package, NATIVE_PKG, "the runtime package is kept");
  assert.equal(p.settings.apiKey, "NEW");
  assert.equal(p.settings.timeout, 5000, "unrelated settings are kept");
  assert.equal(p.settings.baseURL, url);
  assert.equal(p.models.stale, undefined, "stale model removed");
  assert.equal(p.models["mm-1"].limit.context, 4096);
  assert.equal(p.models["mm-2"].limit.context, 8192);
});

test("a providers-only config gets a new provider in 2.x shape", async () => {
  const home = homeWith({ ".config/opencode/opencode.jsonc": '{ "providers": {} }\n' });
  const out = await add(home, ["--key", "K1"]);
  assert.match(out, /provider "mm" \(2 models/);
  const cfg = readCfg(home);
  assert.equal(cfg.provider, undefined, "a 2.x file must not grow a 1.x section");
  const p = cfg.providers.mm;
  assert.equal(p.name, "mm");
  assert.equal(p.package, NATIVE_PKG);
  assert.ok(!p.npm, "2.x entries use package, not npm");
  assert.ok(!p.options, "2.x entries keep endpoints in settings");
  assert.equal(p.settings.baseURL, url);
  assert.equal(p.settings.apiKey, "K1");
  assert.deepEqual(p.models["mm-1"].capabilities.input, ["text"]);
  assert.deepEqual(p.models["mm-1"].capabilities.output, ["text"]);
  assert.equal(p.models["mm-1"].capabilities.tools, true);
  assert.equal(p.models["mm-1"].limit.context, 4096);
});

test("when both shapes name one id, add updates the native one OpenCode uses", async () => {
  const cfg0 = JSON.stringify({
    provider: { mm: { npm: "@ai-sdk/openai-compatible", options: { baseURL: "http://legacy/v1" }, models: { leg: {} } } },
    providers: { mm: { package: NATIVE_PKG, settings: { baseURL: url }, models: {} } },
  }, null, 2) + "\n";
  const home = homeWith({ ".config/opencode/opencode.jsonc": cfg0 });
  const out = await add(home, ["--key", "K1"]);
  assert.match(out, /note: mm exists in both "provider" and "providers"/);
  const cfg = readCfg(home);
  assert.equal(cfg.providers.mm.settings.apiKey, "K1");
  assert.equal(cfg.provider.mm.options.apiKey, undefined, "the shadowed legacy entry is left alone");
  assert.deepEqual(Object.keys(cfg.provider.mm.models), ["leg"], "legacy models are not touched");
  assert.ok(cfg.providers.mm.models["mm-1"], "models are reconciled into the native entry");
});

test("sync --apply updates the 2.x entry in place and reads its settings.baseURL", async () => {
  const cfg0 = JSON.stringify({
    providers: {
      mm: {
        package: NATIVE_PKG,
        settings: { baseURL: url },
        models: { "mm-1": { name: "mm-1", limit: { context: 999, output: 4096 } }, gone: { name: "gone" } },
      },
    },
  }, null, 2) + "\n";
  const home = homeWith({ ".config/opencode/opencode.jsonc": cfg0 });
  const out = flat(await runCliAsyncP(home, ["sync", "--apply"]));
  assert.match(out, /mm \(\S+, \S*\): 2 on server, 2 in config/);
  assert.match(out, /~ ctx mm-1: 999 -> 4096/);
  assert.match(out, /APPLIED/);
  const cfg = readCfg(home);
  assert.equal(cfg.provider, undefined, "no legacy section invented");
  const p = cfg.providers.mm;
  assert.equal(p.models.gone, undefined);
  assert.equal(p.models["mm-1"].limit.context, 4096);
  assert.equal(p.models["mm-1"].limit.output, 4096, "the configured output limit survives");
  assert.equal(p.models["mm-2"].limit.context, 8192);
});

test("sync --apply backfills release dates when dates are the only drift", async () => {
  const cfg0 = JSON.stringify({
    providers: {
      mm: {
        package: NATIVE_PKG,
        settings: { baseURL: url },
        models: {
          "mm-1": { name: "mm-1", limit: { context: 4096, output: 65536 } },
          "mm-2": { name: "mm-2", limit: { context: 8192, output: 65536 } },
        },
      },
    },
  }, null, 2) + "\n";
  const home = homeWith({ ".config/opencode/opencode.jsonc": cfg0 });
  const report = flat(await runCliAsyncP(home, ["sync"]));
  assert.match(report, /~ release date mm-1: missing -> \d{4}-\d{2}-\d{2}/);
  assert.match(report, /~ release date mm-2: missing -> \d{4}-\d{2}-\d{2}/);
  assert.match(report, /2 change\(s\) pending/);
  const out = flat(await runCliAsyncP(home, ["sync", "--apply"]));
  assert.match(out, /APPLIED 2 change\(s\)/);
  const cfg = readCfg(home);
  const today = new Date().toISOString().slice(0, 10);
  assert.equal(cfg.providers.mm.models["mm-1"].releaseDate, today);
  assert.equal(cfg.providers.mm.models["mm-2"].releaseDate, today);
});

test("list marks 2.x entries and reads their settings", async () => {
  const cfg0 = JSON.stringify({
    provider: { old: { options: { baseURL: "http://o/v1" }, models: {} } },
    providers: { mm: { settings: { baseURL: url, apiKey: "K9" }, models: { a: {}, b: {} } } },
  }, null, 2) + "\n";
  const home = homeWith({ ".config/opencode/opencode.jsonc": cfg0 });
  const out = flat(await runCliAsyncP(home, ["list"]));
  assert.match(out, /mm \(2\.x\) 2 models http:\/\/127\.0\.0\.1:\d+\/v1 key \(config\)/);
  assert.match(out, /old 0 models http:\/\/o\/v1 no-key/);
});

test("OPENCODE_CONFIG names the explicit file provider-sync reads and writes", async () => {
  const GLOBAL = '{ "provider": { "glob": { "options": { "baseURL": "http://g/v1" }, "models": {} } } }\n';
  const home = homeWith({
    ".config/opencode/opencode.jsonc": GLOBAL,
    "custom.jsonc": '{ "providers": {} }\n',
  });
  const explicit = path.join(home, "custom.jsonc");
  const out = await addEnv(home, ["--key", "K1"], { OPENCODE_CONFIG: explicit });
  assert.match(out, /provider "mm"/);
  assert.equal(readFileSync(path.join(home, ".config/opencode/opencode.jsonc"), "utf8"), GLOBAL,
    "the global file is not touched when OPENCODE_CONFIG points elsewhere");
  const cfg = readCfg(home, "custom.jsonc");
  assert.equal(cfg.providers.mm.settings.apiKey, "K1");
  assert.equal(cfg.providers.mm.settings.baseURL, url);
  const listed = flat(await runCliAsyncP(home, ["list"], { OPENCODE_CONFIG: explicit }));
  assert.match(listed, /custom\.jsonc/);
  assert.match(listed, /mm \(2\.x\) 2 models/);
});

test("the config.json note appears only when OpenCode 2.x is around", async () => {
  const CONFIG_JSON = '{ "provider": { "p": { "options": { "baseURL": "http://p/v1" }, "models": {} } } }\n';
  const run = (home, extraEnv) => runCliAsync(process.execPath, [CLI, "list"], { env: hermeticEnv(home, extraEnv) });
  if (process.platform === "win32") return; // spawn/env plumbing below is POSIX-only in CI
  const withDb = homeWith({
    ".config/opencode/config.json": CONFIG_JSON,
    ".local/share/opencode/opencode.db": "x",
  });
  const r1 = await run(withDb, { XDG_DATA_HOME: path.join(withDb, ".local/share") });
  assert.match(r1.stderr, /config\.json is an OpenCode 1\.x config name/);
  assert.match(flat(r1.stdout), /p 0 models http:\/\/p\/v1/);
  const noDb = homeWith({ ".config/opencode/config.json": CONFIG_JSON });
  const r2 = await run(noDb, { XDG_DATA_HOME: path.join(noDb, ".local/share") });
  assert.doesNotMatch(r2.stderr, /1\.x config name/);
});

test("a flag that means nothing for the command is refused with a hint", () => {
  // these used to be accepted and silently ignored: sync --no-hermes synced
  // both harnesses, list --key K dropped the key, add --apply added anyway
  const home = homeWith({ ".config/opencode/opencode.jsonc": '{ "provider": {} }\n' });
  assert.throws(() => runCli(home, ["sync", "--no-hermes"]), /--no-hermes is for add/);
  assert.throws(() => runCli(home, ["list", "--key", "K"]), /--key is not used by list/);
  assert.throws(() => runCli(home, ["add", "x", "http://h/v1", "--apply"]), /--apply is for sync/);
  assert.throws(() => runCli(home, ["set-ctx", "x", "--target", "hermes"]), /--target is not used by set-ctx/);
});

test("positional arguments are checked per command", () => {
  const home = homeWith({ ".config/opencode/opencode.jsonc": '{ "provider": {} }\n' });
  assert.throws(() => runCli(home, ["list", "extra"]), /unexpected argument "extra"/);
  assert.throws(() => runCli(home, ["add", "only-id"]), /usage: provider-sync add <id> <baseURL>/);
  assert.throws(() => runCli(home, ["sync", "oops"]), /unexpected argument "oops"/);
  assert.throws(() => runCli(home, ["set-ctx"]), /usage: provider-sync set-ctx <provider>/);
});

test("sync --provider refuses unknown, disabled and hermes-targeted requests", () => {
  const home = homeWith({
    ".config/opencode/opencode.jsonc": JSON.stringify({
      provider: { mm: { options: { baseURL: "http://127.0.0.1:9/v1" }, models: {} }, off: { options: { baseURL: "http://127.0.0.1:9/v1" }, models: {} } },
      disabled_providers: ["off"],
    }) + "\n",
  });
  assert.throws(() => runCli(home, ["sync", "--provider", "nope", "--target", "opencode"]), /unknown provider "nope"/);
  assert.throws(() => runCli(home, ["sync", "--provider", "mm", "--target", "hermes"]), /--provider is only for the opencode target/);
  assert.throws(() => runCli(home, ["sync", "--provider", "off", "--target", "opencode"]), /is disabled \(disabled_providers/);
});

test("--help works on any command and wins over argument trouble", () => {
  const home = homeWith({ ".config/opencode/opencode.jsonc": '{ "provider": {} }\n' });
  const out = runCli(home, ["add", "--help"]);
  assert.match(out, /add <id> <baseURL>/);
  const out2 = runCli(home, ["list", "-h"]);
  assert.match(out2, /provider-sync/);
  const ver = runCli(home, ["list", "--version"]).trim();
  assert.match(ver, /^\d+\.\d+\.\d+$/);
});
