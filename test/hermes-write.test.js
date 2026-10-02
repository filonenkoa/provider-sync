// hermes writes: entry creation, upsert-by-url, refusal to guess a layout.
// The module reads ~/.hermes/config.yaml from HOME at import time, so the
// tests point HOME at a temp dir and import dynamically afterwards.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const home = mkdtempSync(path.join(tmpdir(), "ps-hermes-"));
process.env.HOME = home;
process.env.USERPROFILE = home;
const { hermesUpsert, HERMES_CFG } = await import("../bin/provider-sync.js");

const MODELS = [
  { id: "IY/Qwen3.8-27B-262Kctx", ctx: 262144 },
  { id: "tiny", ctx: null },
];
const write = (text) => { mkdirSync(path.dirname(HERMES_CFG), { recursive: true }); writeFileSync(HERMES_CFG, text); };
const read = () => readFileSync(HERMES_CFG, "utf8");
const BASE = `model:
  default: x

# must survive
custom_providers:
  - name: Existing
    base_url: http://127.0.0.1:8080/v1
    api_key: dummy
    models:
      gemma-4-12b-it:
        context_length: 131072

trailing_key:
  keep: me
`;

before(() => write(BASE));
after(() => rmSync(home, { recursive: true, force: true }));

test("creates an entry, keeping comments and other sections", () => {
  const r = hermesUpsert({ name: "New One", base: "http://10.0.0.5:64980/v1", key: "sk-1", model: "tiny", models: MODELS, dryRun: false });
  assert.equal(r.status, "created");
  const out = read();
  assert.match(out, /# must survive/);
  assert.match(out, /trailing_key:/);
  assert.match(out, /- name: New One\n {4}base_url: http:\/\/10\.0\.0\.5:64980\/v1\n {4}api_key: sk-1/);
  assert.match(out, / {4}models_discovered: true/);
  assert.doesNotMatch(out, /},/); // no stray comma — we write yaml, not json
});

test("writes dummy as the key when the server needs none", () => {
  write(BASE);
  hermesUpsert({ name: "NoAuth", base: "http://10.0.0.6:64980/v1", key: null, model: "tiny", models: MODELS, dryRun: false });
  assert.match(read(), /api_key: dummy/);
});

test("matches by base url so re-running updates instead of duplicating", () => {
  write(BASE);
  hermesUpsert({ name: "First", base: "http://10.0.0.7:64980/v1", key: "k1", model: "tiny", models: MODELS, dryRun: false });
  hermesUpsert({ name: "Second", base: "http://10.0.0.7:64980/v1", key: "k2", model: "tiny", models: MODELS, dryRun: false });
  const out = read();
  assert.equal(out.match(/http:\/\/10\.0\.0\.7:64980/g).length, 1, "url appears once");
  assert.match(out, /api_key: k2/, "key updated on the existing entry");
  assert.doesNotMatch(out, /- name: Second/);
});

test("localhost and 127.0.0.1 are the same server, so no duplicate appears", () => {
  write(BASE);
  hermesUpsert({ name: "Localhost", base: "http://localhost:8080/v1", key: null, model: "tiny", models: MODELS, dryRun: false });
  const r = hermesUpsert({ name: "Loopback", base: "http://127.0.0.1:8080/v1", key: null, model: "tiny", models: MODELS, dryRun: false });
  assert.equal(r.status, "updated");
  assert.equal(r.name, "Existing", "the existing entry is reused, not renamed");
  assert.equal(read().match(/base_url: http:\/\/127\.0\.0\.1:8080\/v1/g).length, 1);
});

test("dryRun reports the plan without touching the file", () => {
  write(BASE);
  const before = read();
  const r = hermesUpsert({ name: "Ghost", base: "http://10.0.0.9:64980/v1", key: "k", model: "tiny", models: MODELS, dryRun: true });
  assert.equal(r.status, "created");
  assert.equal(read(), before);
  assert.doesNotMatch(read(), /Ghost/);
});

test("refuses to append next to list items it does not understand", () => {
  write("custom_providers:\n  - opaque: 1\n    x: 2\n");
  const before = read();
  const r = hermesUpsert({ name: "Nope", base: "http://10.0.0.8:64980/v1", key: null, model: "tiny", models: MODELS, dryRun: false });
  assert.equal(r.status, "unparsed");
  assert.equal(read(), before);
});

test("reports a missing hermes install instead of failing", () => {
  rmSync(HERMES_CFG);
  const r = hermesUpsert({ name: "X", base: "http://10.0.0.4:1/v1", key: null, model: null, models: MODELS, dryRun: false });
  assert.equal(r.status, "absent");
  assert.equal(existsSync(HERMES_CFG), false);
});

test("reports a config without a custom_providers section", () => {
  write("model:\n  default: x\n");
  const r = hermesUpsert({ name: "X", base: "http://10.0.0.4:1/v1", key: null, model: null, models: MODELS, dryRun: false });
  assert.equal(r.status, "no-section");
});

test("preserves CRLF line endings", () => {
  write(BASE.replace(/\n/g, "\r\n"));
  hermesUpsert({ name: "Win", base: "http://10.0.0.3:64980/v1", key: "k", model: "tiny", models: MODELS, dryRun: false });
  assert.equal(read().includes("\r\n"), true);
  assert.equal(/[^\r]\n/.test(read()), false, "no bare LF was introduced");
});

test("keeps a rotating backup of the previous file", () => {
  write(BASE);
  for (const port of [2, 5, 6, 7])
    hermesUpsert({ name: "Bak" + port, base: `http://10.0.0.${port}:64980/v1`, key: "k", model: "tiny", models: MODELS, dryRun: false });
  const baks = readdirSync(path.dirname(HERMES_CFG)).filter((f) => f.startsWith("config.yaml.bak-provider-sync-"));
  assert.equal(baks.length, 3, "only the last 3 backups are kept");
  assert.equal(baks.join(), baks.sort().join(), "backups sorted oldest-first by name");
});