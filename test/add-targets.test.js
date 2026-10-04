// `add` writes only to harnesses that are installed on this machine, and says
// why each target was skipped. A Hermes-only machine must not grow an OpenCode
// config just because a provider was added.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import http from "node:http";
import { runCliAsyncP, flat } from "./helpers.js";
let server, url;
const homes = [];

const MODELS = [
  { id: "mm-1", context_length: 4096 },
  { id: "mm-2", context_length: 8192 },
];
before(async () => {
  server = http.createServer((q, s) => {
    if (q.url === "/v1/models") { s.setHeader("content-type", "application/json"); s.end(JSON.stringify({ data: MODELS })); }
    else { s.statusCode = 404; s.end("{}"); }
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  url = `http://127.0.0.1:${server.address().port}/v1`;
});
after(() => { server.close(); for (const h of homes) rmSync(h, { recursive: true, force: true }); });

const homeWith = (files) => {
  const home = mkdtempSync(path.join(tmpdir(), "ps-add-"));
  homes.push(home);
  for (const [rel, content] of Object.entries(files)) {
    const f = path.join(home, rel);
    mkdirSync(path.dirname(f), { recursive: true });
    writeFileSync(f, content);
  }
  return home;
};
const add = async (home, args = []) => flat(await runCliAsyncP(home, ["add", "mm", url, ...args]));
const OC_CFG = '{\n  "provider": {}\n}\n';
const HERMES = "custom_providers:\n";
const inHome = (home, rel) => path.join(home, rel);

test("hermes-only machine: only the hermes entry is written", async () => {
  const home = homeWith({ ".hermes/config.yaml": HERMES });
  const out = await add(home, ["--key", "K1"]);
  assert.match(out, /opencode \S*opencode\.jsonc skipped — opencode is not installed here/);
  assert.match(out, /keys \S*auth\.json skipped — opencode is not installed here/);
  assert.match(out, /hermes \S*config\.yaml custom_providers "mm" created \(2 models/);
  assert.match(readFileSync(inHome(home, ".hermes/config.yaml"), "utf8"), /- name: mm/);
});

test("hermes-only machine: no opencode config or auth.json is created", async () => {
  const home = homeWith({ ".hermes/config.yaml": HERMES });
  await add(home, ["--key", "K1"]);
  assert.equal(existsSync(inHome(home, ".config")), false, "no ~/.config was created");
  assert.equal(existsSync(inHome(home, ".local")), false, "no ~/.local was created");
});

test("opencode-only machine: hermes is reported as not installed", async () => {
  const home = homeWith({ ".config/opencode/opencode.jsonc": OC_CFG });
  const out = await add(home, ["--key", "K1"]);
  assert.match(out, /opencode \S* provider "mm" \(2 models\)/);
  assert.match(out, /hermes \S*config\.yaml skipped — hermes is not installed here/);
  assert.equal(existsSync(inHome(home, ".hermes")), false, "no ~/.hermes was created");
});

test("both installed: both are written", async () => {
  const home = homeWith({ ".config/opencode/opencode.jsonc": OC_CFG, ".hermes/config.yaml": HERMES });
  const out = await add(home, ["--key", "K1"]);
  assert.match(out, /opencode \S* provider "mm" \(2 models\)/);
  assert.match(out, /hermes \S* custom_providers "mm" created \(2 models/);
  assert.equal(existsSync(inHome(home, ".local/share/opencode/auth.json")), true);
});

test("--target opencode creates the config even where opencode is absent", async () => {
  const home = homeWith({ ".hermes/config.yaml": HERMES });
  const out = await add(home, ["--key", "K1", "--target", "opencode"]);
  assert.match(out, /provider "mm" \(2 models, new config file\)/);
  assert.match(out, /hermes \S* skipped — not selected \(--target opencode\)/);
  assert.equal(existsSync(inHome(home, ".config/opencode/opencode.jsonc")), true);
});

test("--target hermes says the other harness was not selected, not missing", async () => {
  const home = homeWith({ ".config/opencode/opencode.jsonc": OC_CFG });
  const out = await add(home, ["--key", "K1", "--target", "hermes"]);
  assert.match(out, /opencode \S* skipped — not selected \(--target hermes\)/);
  assert.match(out, /keys \S* skipped — not selected \(--target hermes\)/);
  assert.match(out, /hermes \S* skipped — hermes is not installed here/);
});

test("--no-hermes keeps working and says so", async () => {
  const home = homeWith({ ".config/opencode/opencode.jsonc": OC_CFG, ".hermes/config.yaml": HERMES });
  const out = await add(home, ["--key", "K1", "--no-hermes"]);
  assert.match(out, /hermes \S* skipped — disabled with --no-hermes/);
  assert.equal(readFileSync(inHome(home, ".hermes/config.yaml"), "utf8"), HERMES, "hermes untouched");
});

test("add refuses to rewrite a flow-style entry instead of corrupting it", async () => {
  const line = `  - {name: Flow, base_url: "${url}", api_key: dummy, models: {old: {context_length: 128}}}`;
  const home = homeWith({ ".hermes/config.yaml": `custom_providers:\n${line}\n` });
  const out = await add(home, ["--key", "K1", "--target", "hermes"]);
  assert.match(out, /hermes \S* skipped — the entry for .* is written in flow style/);
  assert.equal(readFileSync(inHome(home, ".hermes/config.yaml"), "utf8"), `custom_providers:\n${line}\n`,
    "the flow line must be byte-identical");
});

test("an invalid --target is refused", async () => {
  await assert.rejects(() => add(homeWith({ ".hermes/config.yaml": HERMES }), ["--target", "bogus"]), /bad --target/);
});

test("--dry-run reports the plan and writes nothing anywhere", async () => {
  const home = homeWith({ ".hermes/config.yaml": HERMES });
  const out = await add(home, ["--key", "K1", "--dry-run"]);
  assert.match(out, /dry-run: nothing written/);
  assert.match(out, /hermes \S* custom_providers "mm" would be created/);
  assert.equal(readFileSync(inHome(home, ".hermes/config.yaml"), "utf8"), HERMES);
  assert.equal(existsSync(inHome(home, ".config")), false);
});
