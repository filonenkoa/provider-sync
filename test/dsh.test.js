// The dsh target end to end: listing, drift reporting, writing the live
// profile patch (or settings.yaml while dsh has not imported it yet), the
// credential store, and the refusals that keep the user's own YAML safe.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, statSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import http from "node:http";
import { runCliAsyncP, runCli, flat, hermeticEnv } from "./helpers.js";

let server, url, authServer, authUrl;
const homes = [];
before(async () => {
  server = http.createServer((q, s) => {
    if (q.url === "/v1/models") {
      s.setHeader("content-type", "application/json");
      s.end(JSON.stringify({ data: [
        { id: "qwen3.8-27b", context_length: 262144 },
        { id: "new-model", context_length: 32768 },
      ] }));
    } else { s.statusCode = 404; s.end("{}"); }
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  url = `http://127.0.0.1:${server.address().port}/v1`;
  authServer = http.createServer((q, s) => {
    if (q.headers.authorization) { s.setHeader("content-type", "application/json"); s.end(JSON.stringify({ data: [{ id: "m1" }] })); }
    else { s.statusCode = 401; s.end("{}"); }
  });
  await new Promise((r) => authServer.listen(0, "127.0.0.1", r));
  authUrl = `http://127.0.0.1:${authServer.address().port}/v1`;
});
after(() => { server.close(); authServer.close(); for (const h of homes) rmSync(h, { recursive: true, force: true }); });

const homeWith = (files) => {
  const home = mkdtempSync(path.join(tmpdir(), "ps-dsh-"));
  homes.push(home);
  for (const [rel, content] of Object.entries(files)) {
    const f = path.join(home, rel);
    mkdirSync(path.dirname(f), { recursive: true });
    writeFileSync(f, content);
  }
  return home;
};
const inHome = (home, rel) => path.join(home, rel);
const read = (home, rel) => readFileSync(inHome(home, rel), "utf8");
const list = (home, args = []) => flat(runCli(home, ["list", ...args]));
const sync = async (home, args = []) => flat(await runCliAsyncP(home, ["sync", ...args]));
const add = async (home, args = []) => flat(await runCliAsyncP(home, ["add", "mm", url, ...args]));

const patchWith = (providers) => `# Your patch layer for this dsh profile.
- id: ui-settings
  name: "@deepseek-ai/dsh-ui-settings"
  config:
    theme: dark
- id: llm-pi-ai
  name: "@deepseek-ai/dsh-llm-pi-ai"
  config:
    providers:
${providers}`;
const m4maxBlock = (base) => `      m4max:
        displayName: M4 Max
        api: openai-completions
        baseURL: ${base}
        apiKeyEnv: M4MAX_API_KEY
        models:
          - id: qwen3.8-27b
            contextWindow: 4096
          - id: stale-model
            contextWindow: 1024
`;
const M4MAX = m4maxBlock("http://127.0.0.1:9/v1"); // list-only tests never probe
const WEB = ".dsh/profiles/web/cordis.patch.yml";
const STORE = ".dsh/.credentials.yaml";

test("list: dsh providers, key states and notes", () => {
  const home = homeWith({
    [WEB]: patchWith(M4MAX),
    [STORE]: "version: 1\nrefs:\n  M4MAX_API_KEY: sk-secret\n",
    ".dsh/settings.yaml.imported": "llm-pi-ai:\n  providers:\n",
  });
  const out = list(home, ["--target", "dsh"]);
  assert.match(out, /dsh \S*cordis\.patch\.yml \(profile web\)/);
  assert.match(out, /m4max\s+2 models\s+http:\/\/127\.0\.0\.1:9\/v1\s+key \(stored\)/);
  assert.match(out, /note: settings\.yaml\.imported exists/);
  assert.doesNotMatch(out, /opencode|hermes/);
});

test("list: an unset reference is named, not guessed", () => {
  const home = homeWith({ [WEB]: patchWith(M4MAX) });
  const out = list(home, ["--target", "dsh"]);
  assert.match(out, /no-key \(M4MAX_API_KEY unset here\)/);
});

test("list: disabled and env sources are shown", () => {
  const home = homeWith({ [WEB]: patchWith(M4MAX).replace("- id: llm-pi-ai\n", "- id: llm-pi-ai\n  disabled: true\n") });
  const out = list(home, ["--target", "dsh"]);
  assert.match(out, /note: the llm-pi-ai patch item is disabled/);
  // the launch environment wins over the store; the label names the variable
  const envOut = flat(runCli(home, ["list", "--target", "dsh"], { env: hermeticEnv(home, { M4MAX_API_KEY: "sk-env" }) }));
  assert.match(envOut, /key \(env M4MAX_API_KEY\)/);
});

test("list: dsh missing is reported as skipped, and other targets do not mention it", () => {
  const home = homeWith({ ".config/opencode/opencode.jsonc": '{ "provider": {} }\n' });
  assert.match(list(home), /dsh \S*\.dsh: not found — skipped/);
  const out = list(home, ["--target", "opencode"]);
  assert.doesNotMatch(out, /dsh/);
});

test("sync: drift is reported and nothing is written without --apply", async () => {
  const home = homeWith({ [WEB]: patchWith(m4maxBlock(url)) });
  const before = read(home, WEB);
  const out = await sync(home, ["--target", "dsh"]);
  assert.match(out, /dsh \(\S*cordis\.patch\.yml \(profile web\)\): 1 provider\(s\)/);
  assert.match(out, /m4max \(\w+, http:\/\/127\.0\.0\.1:\d+\/v1\): 2 on server, 2 in config/);
  assert.match(out, /\+ new-model/);
  assert.match(out, /- stale-model \(no longer on server\)/);
  assert.match(out, /~ ctx qwen3\.8-27b: 4096 -> 262144/);
  assert.match(out, /3 change\(s\) pending — re-run with --apply to write/);
  assert.equal(read(home, WEB), before, "read-only run must not touch the file");
});

test("sync --apply: model drift is written, the rest of the file survives", async () => {
  const home = homeWith({ [WEB]: patchWith(m4maxBlock(url)) });
  const before = read(home, WEB);
  const out = await sync(home, ["--target", "dsh", "--apply"]);
  assert.match(out, /APPLIED 3 change\(s\)/);
  assert.match(out, /written:\n\s+dsh \S*cordis\.patch\.yml 3 change\(s\) in 1 provider\(s\)/);
  const after = read(home, WEB);
  assert.equal(after.slice(0, after.indexOf("    providers:")), before.slice(0, before.indexOf("    providers:")),
    "the ui-settings item and the header are byte-identical");
  assert.match(after, /- id: new-model\n\s+contextWindow: 32768\n/);
  assert.match(after, /- id: qwen3\.8-27b\n\s+contextWindow: 262144\n/);
  assert.doesNotMatch(after, /stale-model/);
  const baks = readdirSync(inHome(home, ".dsh/profiles/web")).filter((f) => f.includes(".bak-provider-sync-"));
  assert.equal(baks.length, 1, "a backup was kept");
  // a second run finds nothing left to do
  const again = await sync(home, ["--target", "dsh"]);
  assert.match(again, /in sync/);
});

test("sync: a server with no ctx writes no contextWindow", async () => {
  const noCtx = http.createServer((q, s) => {
    if (q.url === "/v1/models") { s.setHeader("content-type", "application/json"); s.end(JSON.stringify({ data: [{ id: "bare-model" }] })); }
    else { s.statusCode = 404; s.end("{}"); }
  });
  await new Promise((r) => noCtx.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${noCtx.address().port}/v1`;
  const home = homeWith({ [WEB]: patchWith(`      p:\n        api: openai-completions\n        baseURL: ${base}\n        apiKeyEnv: P_API_KEY\n        models: []\n`) });
  try {
    const out = await sync(home, ["--target", "dsh", "--apply"]);
    assert.match(out, /APPLIED 1 change\(s\)/);
    const after = read(home, WEB);
    assert.match(after, /- id: bare-model\n/);
    assert.doesNotMatch(after, /contextWindow/);
  } finally { noCtx.close(); }
});

test("sync: offline and auth-failing servers are skipped, the rest continues", async () => {
  const home = homeWith({ [WEB]: patchWith(
    `      dead:\n        api: openai-completions\n        baseURL: http://127.0.0.1:9/v1\n        apiKeyEnv: DEAD_API_KEY\n        models: []\n` +
    `      locked:\n        api: openai-completions\n        baseURL: ${authUrl}\n        apiKeyEnv: NOPE_KEY\n        models: []\n` +
    m4maxBlock(url)) });
  const out = await sync(home, ["--target", "dsh"]);
  assert.match(out, /dead \(http:\/\/127\.0\.0\.1:9\/v1\): OFFLINE \(.*\) — skipped/);
  assert.match(out, /locked \(http:\/\/127\.0\.0\.1:\d+\/v1\): AUTH 401 — its key is NOPE_KEY, which is not set here/);
  assert.match(out, /\+ new-model/, "the reachable provider is still checked");
});

test("add: creates the llm-pi-ai item in the profile patch and stores the key", async () => {
  const home = homeWith({ [WEB]: "# Your patch layer.\n[]\n" });
  const out = await add(home, ["--key", "K1"]);
  assert.match(out, /opencode \S* skipped — opencode is not installed here/);
  assert.match(out, /dsh \S*cordis\.patch\.yml provider "mm" created \(2 models, key ref MM_API_KEY\)/);
  assert.match(out, /dsh-keys \S*\.credentials\.yaml key "MM_API_KEY" stored/);
  const cfg = read(home, WEB);
  assert.match(cfg, /- id: llm-pi-ai\n  name: "@deepseek-ai\/dsh-llm-pi-ai"\n  config:\n    providers:\n      mm:\n/);
  assert.match(cfg, /api: openai-completions/);
  assert.match(cfg, /baseURL: http:\/\/127\.0\.0\.1:\d+\/v1/);
  assert.match(cfg, /apiKeyEnv: MM_API_KEY/);
  assert.match(cfg, /- id: qwen3\.8-27b\n\s+contextWindow: 262144\n/);
  assert.equal(read(home, STORE), "version: 1\nrefs:\n  MM_API_KEY: K1\n");
  if (process.platform !== "win32") // process mode bits are POSIX-only
    assert.equal(statSync(inHome(home, STORE)).mode & 0o777, 0o600, "the store is owner-only");
});

test("add: re-running updates instead of duplicating and keeps the key", async () => {
  const home = homeWith({ [WEB]: "# h\n[]\n" });
  await add(home, ["--key", "K1"]);
  const out = await add(home, []);
  assert.match(out, /provider "mm" updated \(2 models, key ref MM_API_KEY\)/);
  assert.match(out, /dsh-keys \S* no change \(no key to store\)/);
  assert.match(read(home, WEB), /MM_API_KEY/);
  assert.equal(read(home, STORE), "version: 1\nrefs:\n  MM_API_KEY: K1\n", "the stored key is untouched");
  assert.equal((read(home, WEB).match(/providers:/g) || []).length, 1, "no duplicate item");
});

test("add: --key-env sets apiKeyEnv and never writes the store", async () => {
  const home = homeWith({ [WEB]: "# h\n[]\n" });
  const out = await add(home, ["--key-env", "DSH_TEST_KEY"]);
  assert.match(out, /key ref DSH_TEST_KEY\)/);
  assert.match(read(home, WEB), /apiKeyEnv: DSH_TEST_KEY/);
  assert.equal(existsSync(inHome(home, STORE)), false);
});

test("add: a server with no auth gets the dummy placeholder", async () => {
  const home = homeWith({ [WEB]: "# h\n[]\n" });
  const out = await add(home, []);
  assert.match(out, /no key known for MM_API_KEY — storing "dummy"/);
  assert.match(out, /dsh-keys \S* key "MM_API_KEY" set to "dummy"/);
  assert.equal(read(home, STORE), "version: 1\nrefs:\n  MM_API_KEY: dummy\n");
});

test("add: an existing settings.yaml is the surface until dsh imports it", async () => {
  const home = homeWith({
    ".dsh/settings.yaml": "ui-onboarding:\n  done: true\nllm-pi-ai:\n  providers:\n",
    [WEB]: "# h\n[]\n",
  });
  const out = await add(home, ["--key", "K1", "--target", "dsh"]);
  assert.match(out, /dsh \S*settings\.yaml provider "mm" created/);
  const s = read(home, ".dsh/settings.yaml");
  assert.match(s, /^ui-onboarding:\n  done: true\nllm-pi-ai:\n  providers:\n    mm:\n/);
  assert.equal(read(home, WEB), "# h\n[]\n", "the patch is not touched while settings.yaml exists");
  const l = list(home, ["--target", "dsh"]);
  assert.match(l, /settings\.yaml \(pre-0\.2 document\)/);
  assert.match(l, /note: settings\.yaml is the pre-0\.2 document/);
});

test("add --target dsh on a machine without dsh creates a profile-agnostic settings.yaml", async () => {
  const home = homeWith({ ".hermes/config.yaml": "custom_providers:\n" });
  const out = await add(home, ["--key", "K1", "--target", "dsh"]);
  assert.match(out, /hermes \S* skipped — not selected \(--target dsh\)/);
  assert.match(out, /dsh \S*settings\.yaml provider "mm" created/);
  const s = read(home, ".dsh/settings.yaml");
  assert.match(s, /^llm-pi-ai:\n  providers:\n    mm:\n/);
  assert.match(list(home, ["--target", "dsh"]), /settings\.yaml \(pre-0\.2 document\)/);
});

test("add: a comment inside the providers block is refused, not dropped", async () => {
  const doc = `llm-pi-ai:
  providers:
    # keep me
    p:
      models: []
`;
  const home = homeWith({ ".dsh/settings.yaml": doc });
  const out = await add(home, ["--key", "K1", "--target", "dsh"]);
  assert.match(out, /dsh \S* skipped — settings\.yaml: the llm-pi-ai provider block: line 3: a comment/);
  assert.equal(read(home, ".dsh/settings.yaml"), doc, "the file is byte-identical");
});

test("a home-level cordis.patch.yml targeting llm-pi-ai wins and is never fought", async () => {
  const home = homeWith({
    [WEB]: patchWith(M4MAX),
    ".dsh/cordis.patch.yml": "- id: llm-pi-ai\n  config:\n    providers:\n      home:\n        models: []\n",
  });
  const l = list(home, ["--target", "dsh"]);
  assert.match(l, /note: \S*cordis\.patch\.yml targets llm-pi-ai too/);
  const s = await sync(home, ["--target", "dsh"]);
  assert.match(s, /a home-level patch wins over the profile's — skipped/);
});

test("flags: --profile picks the profile, conflicts and typos are refused", async () => {
  const home = homeWith({ [WEB]: "# h\n[]\n", ".dsh/profiles/other/cordis.patch.yml": "# other\n[]\n" });
  const out = await add(home, ["--key", "K1", "--target", "dsh", "--profile", "other"]);
  assert.match(out, /dsh \S*profiles[\\/]other[\\/]cordis\.patch\.yml provider "mm" created/);
  assert.equal(read(home, WEB), "# h\n[]\n", "web was not touched");
  await assert.rejects(() => add(home, ["--target", "dsh", "--profile", "nope"]), /no dsh profile "nope"/);
  await assert.rejects(() => add(home, ["--target", "opencode", "--profile", "other"]),
    /--profile is only for the dsh target/);
  await assert.rejects(() => add(home, ["--no-hermes", "--target", "dsh"]), /--no-hermes conflicts with --target dsh/);
  await assert.rejects(() => runCliAsyncP(home, ["sync", "--target", "dsh", "--provider", "x"]),
    /--provider is only for the opencode target/);
  await assert.rejects(() => runCliAsyncP(home, ["list", "--target", "hermes", "--profile", "web"]),
    /--profile is only for the dsh target/);
});

test("an OpenCode-only machine does not grow a dsh home", async () => {
  const home = homeWith({ ".config/opencode/opencode.jsonc": '{ "provider": {} }\n' });
  const out = await add(home, ["--key", "K1"]);
  assert.match(out, /dsh \S* skipped — dsh is not installed here/);
  assert.equal(existsSync(inHome(home, ".dsh")), false);
});
