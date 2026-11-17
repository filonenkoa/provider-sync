// remove/restore: providers and single models, across both OpenCode shapes and
// both Hermes surfaces, with tombstones so a later `sync` cannot resurrect a
// deliberately deleted model.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import http from "node:http";
import { runCli, runCliAsyncP, flat } from "./helpers.js";

let server, url;
const homes = [];

before(async () => {
  server = http.createServer((q, s) => {
    if (q.url === "/v1/models") {
      s.setHeader("content-type", "application/json");
      s.end(JSON.stringify({ data: [{ id: "m1", context_length: 4096 }, { id: "m2", context_length: 8192 }] }));
      return;
    }
    s.statusCode = 404;
    s.end("{}");
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  url = `http://127.0.0.1:${server.address().port}/v1`;
});
after(() => { server.close(); for (const h of homes) rmSync(h, { recursive: true, force: true }); });

const homeWith = (files) => {
  const home = mkdtempSync(path.join(tmpdir(), "ps-remove-"));
  homes.push(home);
  for (const [rel, content] of Object.entries(files)) {
    const f = path.join(home, rel);
    mkdirSync(path.dirname(f), { recursive: true });
    writeFileSync(f, content);
  }
  return home;
};
const read = (home, rel) => readFileSync(path.join(home, rel), "utf8");
const statePath = (home) => path.join(home, ".config/provider-sync/state.json");
const state = (home) => JSON.parse(read(home, ".config/provider-sync/state.json"));
const runFail = (home, args) => {
  try { runCli(home, args); }
  catch (e) { return { status: e.status, out: String(e.stdout || "") + String(e.stderr || "") }; }
  assert.fail(`expected provider-sync ${args.join(" ")} to fail`);
};

const OC = (top = "") => `{
  ${top}"provider": {
    "keepme": { "models": { "m1": {} }, "options": { "baseURL": "${url}" } },
    "dropme": { "models": { "m1": {}, "m2": {} }, "options": { "baseURL": "${url}" } }
  }
}
`;
const HERMES = (top = "") => `${top}providers:
  keep:
    api: ${url}
    default_model: m1
    models:
      - m1
  dropme:
    api: ${url}
    default_model: m1
    models:
      - m1
      - m2
custom_providers:
  - name: keep
    base_url: ${url}
    model: m1
    models:
      m1: {}
  - name: dropme
    base_url: ${url}
    model: m1
    models:
      m1: {}
      m2: {}
`;

test("remove --apply deletes the provider from both OpenCode shapes and both Hermes surfaces", () => {
  const home = homeWith({ ".config/opencode/opencode.jsonc": OC(), ".hermes/config.yaml": HERMES() });
  const out = flat(runCli(home, ["remove", "dropme", "--apply"]));
  assert.match(out, /removed/);
  const oc = JSON.parse(read(home, ".config/opencode/opencode.jsonc"));
  assert.equal(oc.provider.dropme, undefined);
  assert.ok(oc.provider.keepme, "other providers survive");
  const h = read(home, ".hermes/config.yaml");
  assert.doesNotMatch(h, /dropme/, "both surfaces are cleaned");
  assert.match(h, /keep/);
  assert.equal(existsSync(statePath(home)), false, "a provider tombstone is not needed");
});

test("remove without --apply writes nothing", () => {
  const home = homeWith({ ".config/opencode/opencode.jsonc": OC(), ".hermes/config.yaml": HERMES() });
  const beforeOc = read(home, ".config/opencode/opencode.jsonc");
  const beforeH = read(home, ".hermes/config.yaml");
  const out = flat(runCli(home, ["remove", "dropme"]));
  assert.match(out, /would be removed/);
  assert.equal(read(home, ".config/opencode/opencode.jsonc"), beforeOc);
  assert.equal(read(home, ".hermes/config.yaml"), beforeH);
  assert.equal(existsSync(statePath(home)), false);
});

test("remove --model tombstones the model and sync does not resurrect it", async () => {
  const home = homeWith({ ".config/opencode/opencode.jsonc": `{
  "provider": { "dropme": { "models": { "m1": {}, "m2": {} }, "options": { "baseURL": "${url}" } } }
}
`, ".hermes/config.yaml": `providers:
  dropme:
    api: ${url}
    default_model: m1
    models:
      - m1
      - m2
` });
  flat(runCli(home, ["remove", "dropme", "--model", "m2", "--apply"]));
  const oc = JSON.parse(read(home, ".config/opencode/opencode.jsonc"));
  assert.deepEqual(Object.keys(oc.provider.dropme.models), ["m1"]);
  assert.doesNotMatch(read(home, ".hermes/config.yaml"), /m2/);
  const st = state(home);
  assert.equal(st.excluded.length, 2);
  assert.deepEqual(st.excluded.map((e) => e.target).sort(), ["hermes", "opencode"]);
  assert.deepEqual(st.excluded.map((e) => e.models), [["m2"], ["m2"]]);

  const rep = flat(await runCliAsyncP(home, ["sync", "--apply"]));
  assert.match(rep, /hidden by provider-sync remove/);
  const ocAfter = JSON.parse(read(home, ".config/opencode/opencode.jsonc"));
  assert.deepEqual(Object.keys(ocAfter.provider.dropme.models), ["m1"], "sync did not add m2 back");
  assert.doesNotMatch(read(home, ".hermes/config.yaml"), /m2/);
});

test("restore lifts the tombstone and the next sync re-adds the model", async () => {
  const home = homeWith({ ".config/opencode/opencode.jsonc": `{
  "provider": { "dropme": { "models": { "m1": {} }, "options": { "baseURL": "${url}" } } }
}
`, ".hermes/config.yaml": `providers:
  dropme:
    api: ${url}
    default_model: m1
    models:
      - m1
` });
  flat(runCli(home, ["remove", "dropme", "--model", "m2", "--apply"]));
  const out = flat(runCli(home, ["restore", "dropme", "--model", "m2"]));
  assert.match(out, /restored/);
  assert.deepEqual(state(home).excluded, []);
  flat(await runCliAsyncP(home, ["sync", "--apply"]));
  const oc = JSON.parse(read(home, ".config/opencode/opencode.jsonc"));
  assert.deepEqual(Object.keys(oc.provider.dropme.models).sort(), ["m1", "m2"]);
  assert.match(read(home, ".hermes/config.yaml"), /- id: m2/);
});

test("a default-model reference refuses removal without --force", () => {
  const home = homeWith({
    ".config/opencode/opencode.jsonc": OC(`"model": "dropme/m1",\n  `),
    ".hermes/config.yaml": HERMES("model:\n  provider: dropme\n  default: m1\n"),
  });
  const beforeOc = read(home, ".config/opencode/opencode.jsonc");
  const beforeH = read(home, ".hermes/config.yaml");
  const bad = runFail(home, ["remove", "dropme", "--apply"]);
  assert.notEqual(bad.status, 0);
  assert.match(bad.out, /--force/);
  assert.equal(read(home, ".config/opencode/opencode.jsonc"), beforeOc);
  assert.equal(read(home, ".hermes/config.yaml"), beforeH);
  const ok = runCli(home, ["remove", "dropme", "--apply", "--force"]);
  assert.match(flat(ok), /removed/);
  assert.doesNotMatch(read(home, ".hermes/config.yaml"), /^ {4}dropme:/m);
});

test("removing an unconfigured model still records the intent", async () => {
  const home = homeWith({ ".config/opencode/opencode.jsonc": `{
  "provider": { "dropme": { "models": { "m1": {} }, "options": { "baseURL": "${url}" } } }
}
` });
  flat(runCli(home, ["remove", "dropme", "--model", "m2", "--apply"]));
  assert.deepEqual(state(home).excluded.map((e) => e.models), [["m2"]]);
  flat(await runCliAsyncP(home, ["sync", "--apply"]));
  const oc = JSON.parse(read(home, ".config/opencode/opencode.jsonc"));
  assert.deepEqual(Object.keys(oc.provider.dropme.models), ["m1"]);
});

test("remove keeps rotating backups of every file it changes", () => {
  const home = homeWith({ ".config/opencode/opencode.jsonc": OC(), ".hermes/config.yaml": HERMES() });
  runCli(home, ["remove", "dropme", "--apply"]);
  const ocBaks = readdirSync(path.join(home, ".config/opencode")).filter((f) => f.startsWith("opencode.jsonc.bak-provider-sync-"));
  const hBaks = readdirSync(path.join(home, ".hermes")).filter((f) => f.startsWith("config.yaml.bak-provider-sync-"));
  assert.ok(ocBaks.length >= 1, "opencode config was backed up");
  assert.ok(hBaks.length >= 1, "hermes config was backed up");
});

test("list reports how many models remove is hiding", () => {
  const home = homeWith({
    ".config/opencode/opencode.jsonc": `{
  "provider": { "dropme": { "models": { "m1": {}, "m2": {} }, "options": { "baseURL": "${url}" } } }
}
`,
    ".hermes/config.yaml": `providers:
  dropme:
    api: ${url}
    default_model: m1
    models:
      - m1
      - m2
`,
  });
  flat(runCli(home, ["remove", "dropme", "--model", "m2", "--apply"]));
  const out = flat(runCli(home, ["list"]));
  assert.match(out, /dropme\s+1 models\s+.*1 hidden \(remove\)/);
  assert.equal((out.match(/1 hidden \(remove\)/g) || []).length, 2, "both harnesses report it");
});

const WEB = ".dsh/profiles/web/cordis.patch.yml";
const STORE = ".dsh/.credentials.yaml";
const DSH_PATCH = () => `# the live profile patch
- id: ui-settings
  name: "@deepseek-ai/dsh-ui-settings"
- id: llm-pi-ai
  name: "@deepseek-ai/dsh-llm-pi-ai"
  config:
    providers:
      keep:
        displayName: Keep
        api: openai-completions
        baseURL: ${url}
        apiKeyEnv: SHARED_API_KEY
        models:
          - id: m1
            contextWindow: 4096
      dropme:
        api: openai-completions
        baseURL: ${url}
        apiKeyEnv: DROP_API_KEY
        models:
          - id: m1
            contextWindow: 4096
          - id: m2
            contextWindow: 8192
`;

test("remove --apply deletes a dsh provider from the live profile patch", () => {
  const home = homeWith({ [WEB]: DSH_PATCH() });
  const out = flat(runCli(home, ["remove", "dropme", "--apply"]));
  assert.match(out, /dsh/);
  const cfg = read(home, WEB);
  assert.doesNotMatch(cfg, /^ {6}dropme:/m, "the route is gone");
  assert.match(cfg, /^ {6}keep:/m);
  assert.match(cfg, /displayName: Keep/);
  assert.match(cfg, /- id: ui-settings/);
});

test("remove --model on a dsh route filters its models list and sync respects it", async () => {
  const home = homeWith({ [WEB]: DSH_PATCH() });
  flat(runCli(home, ["remove", "dropme", "--model", "m2", "--apply"]));
  const cfg = read(home, WEB);
  assert.match(cfg, /- id: m1/);
  assert.doesNotMatch(cfg, /- id: m2/);
  assert.ok(state(home).excluded.some((e) => e.target === "dsh" && e.models.includes("m2")));
  const rep = flat(await runCliAsyncP(home, ["sync", "--target", "dsh", "--apply"]));
  assert.match(rep, /hidden by provider-sync remove/);
  assert.doesNotMatch(read(home, WEB), /- id: m2/, "sync did not add the model back");
});

test("--purge-credentials deletes a ref no other dsh route uses", () => {
  const home = homeWith({
    [WEB]: DSH_PATCH(),
    [STORE]: "version: 1\nrefs:\n  SHARED_API_KEY: sk-shared\n  DROP_API_KEY: sk-drop\n",
  });
  flat(runCli(home, ["remove", "dropme", "--apply", "--purge-credentials"]));
  const store = read(home, STORE);
  assert.doesNotMatch(store, /DROP_API_KEY/);
  assert.match(store, /SHARED_API_KEY: sk-shared/, "a ref another route still uses survives");
  assert.doesNotMatch(read(home, WEB), /DROP_API_KEY/);
});

test("--purge-credentials keeps a ref another route still names", () => {
  const home = homeWith({
    [WEB]: DSH_PATCH().replace("apiKeyEnv: DROP_API_KEY", "apiKeyEnv: SHARED_API_KEY"),
    [STORE]: "version: 1\nrefs:\n  SHARED_API_KEY: sk-shared\n",
  });
  const out = flat(runCli(home, ["remove", "dropme", "--apply", "--purge-credentials"]));
  assert.match(out, /SHARED_API_KEY still used/);
  assert.match(read(home, STORE), /SHARED_API_KEY: sk-shared/);
});

test("remove --target dsh without a dsh home is skipped, not an error", () => {
  const home = homeWith({ ".config/opencode/opencode.jsonc": OC() });
  const out = flat(runCli(home, ["remove", "dropme", "--target", "dsh", "--apply"]));
  assert.match(out, /dsh.*not found — skipped/);
  assert.match(read(home, ".config/opencode/opencode.jsonc"), /dropme/, "opencode was not touched");
});
