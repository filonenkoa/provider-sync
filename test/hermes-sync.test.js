// sync must use the key that belongs to the server, wherever it is stored:
// the OpenCode config entry (where `add --key` puts it since 1.1.1), auth.json,
// or a hermes key_env / {env:VAR} reference. The report and the probe must
// agree — a "borrowed from" line while the request goes out unauthenticated is
// exactly the lie this file guards against.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import http from "node:http";
import { runCliAsyncP, runCli, flat } from "./helpers.js";

let server, url;
const homes = [];

before(async () => {
  server = http.createServer((q, s) => {
    if (q.url === "/v1/models") {
      if (q.headers.authorization === "Bearer SECRET") {
        s.setHeader("content-type", "application/json");
        s.end(JSON.stringify({ data: [{ id: "m1", context_length: 4096 }] }));
      } else {
        s.statusCode = 401;
        s.end("{}");
      }
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
  const home = mkdtempSync(path.join(tmpdir(), "ps-hsync-"));
  homes.push(home);
  for (const [rel, content] of Object.entries(files)) {
    const f = path.join(home, rel);
    mkdirSync(path.dirname(f), { recursive: true });
    writeFileSync(f, content);
  }
  return home;
};
const inHome = (home, rel) => path.join(home, rel);

const OC_CFG = (pid, apiKey) => `{
  "provider": {
    "${pid}": { "options": { "baseURL": "${url}"${apiKey ? `, "apiKey": ${JSON.stringify(apiKey)}` : ""} }, "models": {} }
  }
}
`;
// built lazily: `url` only exists after the server in before() has started
const HERMES = () => `custom_providers:
  - name: H
    base_url: ${url}
    api_key: dummy
    models:
      m1:
        context_length: 4096
`;

// the v12+ mapping Hermes migrates custom_providers into
const HERMES_DICT = () => `model:
  default: x

# must survive
providers:
  h1:
    name: H
    base_url: ${url}
    api_key: dummy
    models:
      m1:
        context_length: 1
      stale:
        context_length: 4096
`;

test("sync reads and writes the providers: mapping Hermes migrated into", async () => {
  const home = homeWith({ ".config/opencode/opencode.jsonc": OC_CFG("p1", "SECRET"), ".hermes/config.yaml": HERMES_DICT() });
  const l = flat(runCli(home, ["list", "--target", "hermes"]));
  assert.match(l, /H\s+2 models\s+http:\/\/127\.0\.0\.1:\d+\/v1\s+key \(borrowed from p1\)/,
  "api_key: dummy is a placeholder, so the key is borrowed from the opencode entry");
  const report = flat(await runCliAsyncP(home, ["sync", "--target", "hermes"]));
  assert.match(report, /hermes .*: 1 custom provider\(s\) in providers:/);
  assert.match(report, /~ ctx m1: 1 -> 4096/);
  assert.match(report, /- stale \(no longer on server\)/);
  assert.match(report, /2 change\(s\) pending/);
  const out = flat(await runCliAsyncP(home, ["sync", "--target", "hermes", "--apply"]));
  assert.match(out, /APPLIED 2 change\(s\)/);
  const cfg = readFileSync(inHome(home, ".hermes/config.yaml"), "utf8");
  assert.match(cfg, /# must survive/, "unrelated lines survive");
  assert.match(cfg, /      m1:\n        context_length: 4096\n/);
  assert.doesNotMatch(cfg, /stale/);
  assert.match(flat(await runCliAsyncP(home, ["sync", "--target", "hermes"])), /in sync/);
});

test("add updates a mapping entry in place, matched by base url", async () => {
  const home = homeWith({
    ".config/opencode/opencode.jsonc": OC_CFG("p1", "SECRET"),
    ".hermes/config.yaml": HERMES_DICT().replace("stale:\n        context_length: 4096\n", ""),
  });
  const out = flat(await runCliAsyncP(home, ["add", "mm", url, "--key", "SECRET"]));
  assert.match(out, /providers "H" updated \(1 models/, "the report names the section actually edited");
  const cfg = readFileSync(inHome(home, ".hermes/config.yaml"), "utf8");
  assert.match(cfg, /api_key: SECRET/);
  assert.equal((cfg.match(/^ {2}h1:$/gm) || []).length, 1, "no duplicate entry");
  assert.doesNotMatch(cfg, /^- name: mm$/, "the mapping keeps its own key");
});

test("add creates an entry in an existing mapping, keeping the rest byte for byte", async () => {
  const second = http.createServer((q, s) => {
    if (q.url === "/v1/models") { s.setHeader("content-type", "application/json"); s.end(JSON.stringify({ data: [{ id: "m2", context_length: 2048 }] })); }
    else { s.statusCode = 404; s.end("{}"); }
  });
  await new Promise((r) => second.listen(0, "127.0.0.1", r));
  const otherUrl = `http://127.0.0.1:${second.address().port}/v1`;
  try {
    const home = homeWith({ ".hermes/config.yaml": HERMES_DICT().replace("stale:\n        context_length: 4096\n", "") });
    const before = readFileSync(inHome(home, ".hermes/config.yaml"), "utf8");
    const out = flat(await runCliAsyncP(home, ["add", "other", otherUrl, "--key", "K1", "--target", "hermes"]));
    assert.match(out, /providers "other" created \(1 models/);
    const cfg = readFileSync(inHome(home, ".hermes/config.yaml"), "utf8");
    assert.match(cfg, /^ {2}h1:$/m, "the existing entry is untouched");
    assert.equal(cfg.split("# must survive").length, before.split("# must survive").length);
    assert.match(cfg, /^ {2}other:\n {4}name: other\n {4}base_url: http:\/\/127\.0\.0\.1:\d+\/v1\n {4}api_key: K1\n/m);
    assert.match(cfg, / {6}m2:\n {8}context_length: 2048\n/);
    assert.match(cfg, / {4}models_discovered: true/);
    // the new entry is a working provider for hermes afterwards
    assert.match(flat(await runCliAsyncP(home, ["sync", "--target", "hermes"])), /other \(\w+, http:\/\/127\.0\.0\.1:\d+\/v1\): 1 on server, 1 in config/);
  } finally { second.close(); }
});

test("a mapping entry provider-sync cannot rewrite is refused, not mangled", async () => {
  const commented = `providers:
  h1:
    base_url: ${url}
    # a note the user wrote
    api_key: dummy
`;
  const home = homeWith({ ".hermes/config.yaml": commented });
  const out = flat(await runCliAsyncP(home, ["add", "mm", url, "--key", "SECRET", "--target", "hermes"]));
  assert.match(out, /hermes .* skipped — providers: line 4: a comment inside the "h1" entry/);
  assert.equal(readFileSync(inHome(home, ".hermes/config.yaml"), "utf8"), commented);
  assert.match(flat(runCli(home, ["list", "--target", "hermes"])), /note: providers: line 4: a comment/);
});

test("a file carrying both surfaces says which one is managed", async () => {
  const home = homeWith({ ".hermes/config.yaml": HERMES_DICT() + "\ncustom_providers:\n  - name: Old\n    base_url: http://127.0.0.1:7/v1\n" });
  const l = flat(runCli(home, ["list", "--target", "hermes"]));
  assert.match(l, /hermes \S*config\.yaml \(providers\)/, "the header names the surface in use");
  assert.match(l, /note: custom_providers: is still present — provider-sync manages providers:/);
  assert.match(l, /H\s+2 models/);
});

test("sync borrows the key stored in the opencode config entry", async () => {
  const home = homeWith({
    ".config/opencode/opencode.jsonc": OC_CFG("p1", "SECRET"),
    ".hermes/config.yaml": HERMES(),
  });
  const out = flat(await runCliAsyncP(home, ["sync", "--target", "hermes"]));
  assert.match(out, /H .*: 1 on server, 1 in config/);
  assert.match(out, /in sync/);
  assert.doesNotMatch(out, /AUTH 401/);
});

test("sync still borrows from auth.json when the config entry has no key", async () => {
  const home = homeWith({
    ".config/opencode/opencode.jsonc": OC_CFG("p1", null),
    ".local/share/opencode/auth.json": JSON.stringify({ p1: { type: "api", key: "SECRET" } }),
    ".hermes/config.yaml": HERMES(),
  });
  const out = flat(await runCliAsyncP(home, ["sync", "--target", "hermes"]));
  assert.match(out, /in sync/);
  assert.doesNotMatch(out, /AUTH 401/);
});

test("an unset {env:VAR} in the config is explained, not probed as garbage", async () => {
  const home = homeWith({
    ".config/opencode/opencode.jsonc": OC_CFG("p1", "{env:PS_TEST_MISSING_KEY}"),
    ".hermes/config.yaml": HERMES(),
  });
  const out = flat(await runCliAsyncP(home, ["sync", "--target", "hermes"]));
  assert.match(out, /AUTH 401 — its key is \{env:PS_TEST_MISSING_KEY\} \(from p1\), which is not set in this environment/);
});

test("add --key-env stores the reference in opencode and key_env in hermes", async () => {
  const home = homeWith({
    ".config/opencode/opencode.jsonc": '{\n  "provider": {}\n}\n',
    ".hermes/config.yaml": "custom_providers:\n",
    ".hermes/.env": "PS_TEST_P1_KEY=SECRET\n",
  });
  // the variable is set here, so the probe can authenticate without --key
  const out = flat(await runCliAsyncP(home, ["add", "mm", url, "--key-env", "PS_TEST_P1_KEY"], { PS_TEST_P1_KEY: "SECRET" }));
  assert.match(out, /provider "mm"/);
  assert.match(out, /custom_providers "mm" created/);
  const cfg = JSON.parse(readFileSync(inHome(home, ".config/opencode/opencode.jsonc"), "utf8"));
  assert.equal(cfg.provider.mm.options.apiKey, "{env:PS_TEST_P1_KEY}", "opencode keeps the reference");
  const yaml = readFileSync(inHome(home, ".hermes/config.yaml"), "utf8");
  assert.match(yaml, /key_env: PS_TEST_P1_KEY/);
  assert.match(yaml, /api_key: dummy/);
  assert.doesNotMatch(yaml, /\{env:/, "hermes must get its own syntax, not opencode's");
  // and the result is a working provider: sync authenticates via the reference
  const again = flat(await runCliAsyncP(home, ["sync", "--target", "hermes"], { PS_TEST_P1_KEY: "SECRET" }));
  assert.match(again, /in sync/);
  assert.doesNotMatch(again, /AUTH 401/);
});

test("--key-env with a value that is not a variable name is refused", async () => {
  const home = homeWith({ ".config/opencode/opencode.jsonc": '{\n  "provider": {}\n}\n' });
  await assert.rejects(
    () => runCliAsyncP(home, ["add", "mm", url, "--key-env", "not a name"]),
    /--key-env needs an environment variable name/,
  );
});

test("sync --apply --dry-run reports the plan and writes nothing, anywhere", async () => {
  // regression: --dry-run was ignored when --apply was also on the line
  const home = homeWith({
    ".config/opencode/opencode.jsonc": OC_CFG("p1", "SECRET"), // models {}: m1 is new
    ".hermes/config.yaml": HERMES().replace("context_length: 4096", "context_length: 1"),
  });
  const ocFile = inHome(home, ".config/opencode/opencode.jsonc");
  const hFile = inHome(home, ".hermes/config.yaml");
  const before = [readFileSync(ocFile, "utf8"), readFileSync(hFile, "utf8")];
  const out = flat(await runCliAsyncP(home, ["sync", "--apply", "--dry-run"]));
  assert.match(out, /change\(s\) pending/);
  assert.doesNotMatch(out, /APPLIED/);
  assert.equal(readFileSync(ocFile, "utf8"), before[0], "opencode config untouched");
  assert.equal(readFileSync(hFile, "utf8"), before[1], "hermes config untouched");
  assert.equal(readdirSync(path.join(home, ".hermes")).some((f) => f.includes("bak-provider-sync")), false,
    "no backup was made for a write that never happened");
});

test("sync --key stands in for a stored key that cannot be read, and is not stored", async () => {
  const home = homeWith({
    ".config/opencode/opencode.jsonc": OC_CFG("p1", null), // no key anywhere
    ".hermes/config.yaml": HERMES(),
  });
  const miss = flat(await runCliAsyncP(home, ["sync", "--target", "hermes"]));
  assert.match(miss, /AUTH 401 — key missing or invalid/);
  const wrong = flat(await runCliAsyncP(home, ["sync", "--target", "hermes", "--key", "WRONG"]));
  assert.match(wrong, /AUTH 401 — the key passed with --key was rejected/);
  const out = flat(await runCliAsyncP(home, ["sync", "--target", "hermes", "--key", "SECRET"]));
  assert.match(out, /in sync/);
  assert.doesNotMatch(out, /AUTH 401/);
  assert.doesNotMatch(readFileSync(inHome(home, ".hermes/config.yaml"), "utf8"), /SECRET/, "--key must never be stored");
});
